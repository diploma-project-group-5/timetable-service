// Relay: відправляє події з outbox у Kafka (розділ 12, «Надійність»). Працює роллю timetable_relay
// (другий пул у процесі сервісу): бачить outbox усіх закладів лише завдяки окремій політиці RLS.
// FOR UPDATE SKIP LOCKED дозволяє кілька екземплярів без подвійної відправки одного рядка;
// якщо Kafka не прийняла пакет, транзакція відкочується і рядки підуть наступним проходом.
//
// Пакет іде в Kafka частинами не більше MAX_SEND_BYTES: брокер приймає до ~1 МБ на запит
// (message.max.bytes), і пачка з кількох великих подій інакше впиралась би в MESSAGE_TOO_LARGE
// назавжди, блокуючи все, що записано після неї (знахідка Z6-1 звіту 22.11). Якщо впала не перша частина,
// уже надіслані частини фіксуються, решта йде наступним проходом. Подія, сама більша за ліміт,
// у Kafka не відправляється взагалі: вона лишається ненадісланою (onOversize повідомляє про неї),
// а наступні за нею події йдуть далі.
// ТИМЧАСОВО до @lad/db: код збігається з relay tenant-service і school-service.
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import type { OutgoingMessage, Producer } from './bus.js';

/** Верхня межа однієї відправки: із запасом під ліміт брокера 1 МБ і службові поля запиту. */
export const MAX_SEND_BYTES = 900_000;

/** Розмір повідомлення в запиті до Kafka: значення, ключ, топік, заголовки й службовий запас. */
export function messageBytes(m: OutgoingMessage): number {
  let bytes = Buffer.byteLength(m.value) + Buffer.byteLength(m.key) + Buffer.byteLength(m.topic) + 64;
  for (const [k, v] of Object.entries(m.headers ?? {})) bytes += Buffer.byteLength(k) + Buffer.byteLength(v);
  return bytes;
}

/** Ділить повідомлення на частини не більше maxBytes, зберігаючи порядок. */
export function chunkBySize<T>(items: T[], size: (item: T) => number, maxBytes: number): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const s = size(item);
    if (current.length > 0 && bytes + s > maxBytes) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += s;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface RelayOptions {
  batchSize?: number;
  maxSendBytes?: number;
  /** Подія більша за maxSendBytes: у Kafka не йде, лишається ненадісланою. */
  onOversize?: (event: { school_id: string; event_id: string; topic: string; bytes: number }) => void;
}

export async function relayOnce(relayDb: Db, producer: Producer, batchSizeOrOptions: number | RelayOptions = {}): Promise<number> {
  const opts = typeof batchSizeOrOptions === 'number' ? { batchSize: batchSizeOrOptions } : batchSizeOrOptions;
  const batchSize = opts.batchSize ?? 100;
  const maxBytes = opts.maxSendBytes ?? MAX_SEND_BYTES;
  return relayDb.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('outbox')
      .select(['school_id', 'event_id', 'topic', 'payload'])
      .where('published_at', 'is', null)
      .orderBy('created_at')
      .orderBy('event_id')
      .limit(batchSize)
      .forUpdate()
      .skipLocked()
      .execute();
    if (rows.length === 0) return 0;

    const items = rows.map((r) => ({
      row: r,
      message: {
        topic: r.topic,
        key: r.school_id,
        value: typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload),
      } satisfies OutgoingMessage,
    }));
    const sendable = items.filter((i) => {
      const bytes = messageBytes(i.message);
      if (bytes <= maxBytes) return true;
      opts.onOversize?.({ school_id: i.row.school_id, event_id: i.row.event_id, topic: i.row.topic, bytes });
      return false;
    });

    const sent: typeof rows = [];
    for (const chunk of chunkBySize(sendable, (i) => messageBytes(i.message), maxBytes)) {
      try {
        await producer.send(chunk.map((i) => i.message));
      } catch (err) {
        // Нічого не надіслано — відкат, увесь пакет піде наступним проходом.
        if (sent.length === 0) throw err;
        break; // Частину вже прийнято: фіксуємо її, решта — наступним проходом.
      }
      sent.push(...chunk.map((i) => i.row));
    }

    if (sent.length > 0) {
      await trx
        .updateTable('outbox')
        .set({ published_at: sql<Date>`now()` })
        .where(({ eb, refTuple, tuple }) =>
          eb(refTuple('school_id', 'event_id'), 'in', sent.map((r) => tuple(r.school_id, r.event_id))),
        )
        .execute();
    }
    return sent.length;
  });
}

export interface RelayHandle {
  stop(): Promise<void>;
}

/** Цикл relay: поки є що відправляти — без паузи, інакше чекає intervalMs. */
export function startRelay(relayDb: Db, producer: Producer, log: FastifyBaseLogger, intervalMs: number): RelayHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  // Така подія лишається в outbox і трапляється на кожному проході: пишемо про неї один раз.
  const reported = new Set<string>();
  const onOversize: RelayOptions['onOversize'] = (event) => {
    if (reported.has(event.event_id)) return;
    reported.add(event.event_id);
    log.error({ ...event, limit: MAX_SEND_BYTES }, 'relay: подія більша за ліміт Kafka, лишається в outbox ненадісланою');
  };

  const tick = async () => {
    if (stopped) return;
    let sent = 0;
    try {
      sent = await relayOnce(relayDb, producer, { onOversize });
      if (sent > 0) log.debug({ sent }, 'outbox → kafka');
    } catch (err) {
      log.warn({ err }, 'relay: не вдалося відправити події, повтор пізніше');
    }
    if (!stopped) timer = setTimeout(() => (running = tick()), sent > 0 ? 0 : intervalMs);
  };
  running = tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
