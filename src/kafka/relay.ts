// Relay: відправляє події з outbox у Kafka (розділ 12, «Надійність»). Працює роллю timetable_relay
// (другий пул у процесі сервісу): бачить outbox усіх закладів лише завдяки окремій політиці RLS.
// FOR UPDATE SKIP LOCKED дозволяє кілька екземплярів без подвійної відправки одного рядка;
// якщо Kafka не прийняла пакет, транзакція відкочується і рядки підуть наступним проходом.
// ТИМЧАСОВО до @lad/db (там relay має бути спільним).
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import type { Producer } from './bus.js';

export async function relayOnce(relayDb: Db, producer: Producer, batchSize = 100): Promise<number> {
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
    await producer.send(
      rows.map((r) => ({
        topic: r.topic,
        key: r.school_id,
        value: typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload),
      })),
    );
    await trx
      .updateTable('outbox')
      .set({ published_at: sql<Date>`now()` })
      .where(({ eb, refTuple, tuple }) =>
        eb(refTuple('school_id', 'event_id'), 'in', rows.map((r) => tuple(r.school_id, r.event_id))),
      )
      .execute();
    return rows.length;
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

  const tick = async () => {
    if (stopped) return;
    let sent = 0;
    try {
      sent = await relayOnce(relayDb, producer);
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
