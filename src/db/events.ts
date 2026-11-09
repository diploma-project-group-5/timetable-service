// Конверт подій (розділ 12, contracts/schemas/events/envelope.v1.json), запис в outbox і inbox.
// ТИМЧАСОВО до @lad/db: outbox та inbox мають жити лише там.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Trx } from './index.js';

export const SOURCE = 'timetable-service';
export const SCHEMA_VERSION = '1.0';

export interface Envelope<T = Record<string, unknown>> {
  event_id: string;
  type: string;
  schema_version: string;
  source: string;
  time: string;
  correlation_id: string;
  school_id: string;
  data: T;
}

export interface OutboxEvent {
  topic: string;
  /** Тип події в конверті; за замовчуванням — назва топіка. */
  type?: string;
  schoolId: string;
  correlationId: string;
  data: Record<string, unknown>;
}

/** Пише подію в outbox у поточній транзакції (дані й подія — атомарно). Повертає конверт. */
export async function writeOutbox(trx: Trx, event: OutboxEvent): Promise<Envelope> {
  const envelope: Envelope = {
    event_id: randomUUID(),
    type: event.type ?? event.topic,
    schema_version: SCHEMA_VERSION,
    source: SOURCE,
    time: new Date().toISOString(),
    correlation_id: event.correlationId,
    school_id: event.schoolId,
    data: event.data,
  };
  await trx
    .insertInto('outbox')
    .values({
      school_id: event.schoolId,
      event_id: envelope.event_id,
      topic: event.topic,
      payload: JSON.stringify(envelope),
    })
    .execute();
  return envelope;
}

/**
 * Позначає подію обробленою в транзакції обробки. false — подію вже обробили (повтор), її треба
 * пропустити. Викликається після set_config зі school_id конверта (withSchool).
 */
export async function claimInbox(trx: Trx, schoolId: string, eventId: string, topic: string): Promise<boolean> {
  const res = await sql<{ event_id: string }>`
    insert into inbox (school_id, event_id, topic) values (${schoolId}, ${eventId}, ${topic})
    on conflict do nothing
    returning event_id`.execute(trx);
  return res.rows.length === 1;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEventError';
  }
}

/** Розбирає й перевіряє конверт. Зламана подія — InvalidEventError (одразу в DLQ, без повторів). */
export function parseEnvelope(raw: string): Envelope {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InvalidEventError('подія не є JSON');
  }
  const e = value as Partial<Envelope> | null;
  if (!e || typeof e !== 'object') throw new InvalidEventError('подія не є об’єктом');
  if (typeof e.event_id !== 'string' || !UUID_RE.test(e.event_id)) throw new InvalidEventError('event_id не uuid');
  if (typeof e.school_id !== 'string' || !UUID_RE.test(e.school_id)) throw new InvalidEventError('school_id не uuid');
  if (typeof e.type !== 'string') throw new InvalidEventError('немає type');
  if (typeof e.schema_version !== 'string' || !/^1\.\d+$/.test(e.schema_version)) {
    throw new InvalidEventError(`непідтримувана schema_version ${String(e.schema_version)}`);
  }
  if (!e.data || typeof e.data !== 'object') throw new InvalidEventError('немає data');
  return {
    event_id: e.event_id.toLowerCase(),
    type: e.type,
    schema_version: e.schema_version,
    source: typeof e.source === 'string' ? e.source : 'unknown',
    time: typeof e.time === 'string' ? e.time : new Date().toISOString(),
    correlation_id: typeof e.correlation_id === 'string' ? e.correlation_id : e.event_id.toLowerCase(),
    school_id: e.school_id.toLowerCase(),
    data: e.data as Record<string, unknown>,
  };
}
