// Консюмер (розділ 12): по одному повідомленню, inbox у транзакції обробки, технічна помилка —
// 4 спроби з паузами 1, 5 і 15 с (переживає рестарт PostgreSQL чи сусіднього сервісу, Z6-3), далі
// <топік>.dlq; зламана подія — одразу в DLQ. Offset підтверджується після обробки або після запису
// в DLQ, тож подія не губиться й не блокує партицію назавжди. Потік консюмера — під наглядом
// (superviseConsumer): падіння Kafka не зупиняє процес з HTTP-API (Z6-2).
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/index.js';
import { InvalidEventError, parseEnvelope, type Envelope } from '../db/events.js';
import { dlqTopic, type IncomingMessage, type MessageSource, type Producer } from './bus.js';

export type Handler = (db: Db, envelope: Envelope) => Promise<unknown>;

export interface ConsumerDeps {
  db: Db;
  producer: Producer;
  handlers: Record<string, Handler>;
  log: FastifyBaseLogger;
  attempts?: number;
  /** Пауза перед повтором: attempt = 1, 2, … */
  backoffMs?: (attempt: number) => number;
}

/** Паузи між спробами обробки технічно невдалої події; спроб на одну більше. */
export const RETRY_DELAYS_MS = [1_000, 5_000, 15_000] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function processMessage(message: IncomingMessage, deps: ConsumerDeps): Promise<'processed' | 'dlq'> {
  const attempts = deps.attempts ?? RETRY_DELAYS_MS.length + 1;
  const backoff = deps.backoffMs ?? ((n) => RETRY_DELAYS_MS[Math.min(n, RETRY_DELAYS_MS.length) - 1]!);
  const log = deps.log.child({ topic: message.topic, partition: message.partition, offset: message.offset });

  let error: unknown;
  let envelope: Envelope | undefined;
  try {
    envelope = parseEnvelope(message.value);
  } catch (err) {
    error = err;
  }

  if (envelope) {
    const handler = deps.handlers[message.topic];
    if (!handler) {
      error = new InvalidEventError(`немає обробника для топіка ${message.topic}`);
    } else {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          await handler(deps.db, envelope);
          error = undefined;
          break;
        } catch (err) {
          error = err;
          // Зламаний вміст не виправиться повтором.
          if (err instanceof InvalidEventError) break;
          log.warn({ err, attempt, event_id: envelope.event_id, school_id: envelope.school_id }, 'обробка події не вдалася');
          if (attempt < attempts) await sleep(backoff(attempt));
        }
      }
    }
  }

  if (error === undefined) {
    await message.commit();
    return 'processed';
  }

  // Тіло події не логуємо: у ньому можуть бути дані закладу.
  log.error({ err: error, event_id: envelope?.event_id, school_id: envelope?.school_id }, 'подію відправлено в DLQ');
  await deps.producer.send([
    {
      topic: dlqTopic(message.topic),
      key: message.key ?? envelope?.school_id ?? '',
      value: message.value,
      headers: {
        'x-error': String((error as Error)?.message ?? error).slice(0, 500),
        'x-original-topic': message.topic,
        'x-original-partition': String(message.partition),
        'x-original-offset': message.offset,
      },
    },
  ]);
  await message.commit();
  return 'dlq';
}

export async function runConsumer(source: MessageSource, deps: ConsumerDeps): Promise<void> {
  await source.run((message) => processMessage(message, deps).then(() => undefined));
}

export interface SupervisorOptions {
  /** Пауза перед першим перезапуском; далі подвоюється до maxDelayMs. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Потік, що пропрацював стільки, вважається здоровим: пауза знову з minDelayMs. */
  healthyAfterMs?: number;
}

export interface ConsumerHandle {
  stop(): Promise<void>;
}

/**
 * Консюмер під наглядом. Потік @platformatic/kafka падає, коли брокер недоступний довше за його
 * повтори; раніше це вбивало весь процес (process.exit) разом з HTTP-API і сторінками за QR, яким
 * Kafka не потрібна (Z6-2). Тепер джерело закривається й створюється наново з паузою 1 с → 30 с;
 * непідтверджені offset група віддасть знову, inbox відкидає повтори.
 */
export function superviseConsumer(makeSource: () => MessageSource, deps: ConsumerDeps, opts: SupervisorOptions = {}): ConsumerHandle {
  const minDelay = opts.minDelayMs ?? 1_000;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  const healthyAfter = opts.healthyAfterMs ?? 60_000;
  let stopped = false;
  let current: MessageSource | undefined;
  let wake: (() => void) | undefined;

  const loop = async () => {
    let failures = 0;
    while (!stopped) {
      const started = Date.now();
      current = makeSource();
      try {
        await runConsumer(current, deps);
        if (!stopped) deps.log.warn('потік консюмера завершився, перезапуск');
      } catch (err) {
        if (!stopped) deps.log.error({ err }, 'консюмер упав, перезапуск');
      }
      if (stopped) break; // stop() уже закрив джерело
      await current.close().catch(() => undefined);
      current = undefined;
      failures = Date.now() - started >= healthyAfter ? 1 : failures + 1;
      const delay = Math.min(maxDelay, minDelay * 2 ** (failures - 1));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  };
  const running = loop();

  return {
    async stop() {
      stopped = true;
      wake?.();
      await current?.close().catch(() => undefined);
      await running;
    },
  };
}
