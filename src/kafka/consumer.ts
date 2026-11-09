// Консюмер (розділ 12): по одному повідомленню, inbox у транзакції обробки, технічна помилка —
// 3 спроби з паузою, далі <топік>.dlq; зламана подія — одразу в DLQ. Offset підтверджується після
// обробки або після запису в DLQ, тож подія не губиться й не блокує партицію назавжди.
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function processMessage(message: IncomingMessage, deps: ConsumerDeps): Promise<'processed' | 'dlq'> {
  const attempts = deps.attempts ?? 3;
  const backoff = deps.backoffMs ?? ((n) => 500 * 2 ** (n - 1));
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
