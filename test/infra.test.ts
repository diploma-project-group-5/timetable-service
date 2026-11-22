// Доступ (JWT), консюмер (3 спроби → DLQ), relay, чистка, клієнт знімка school-service.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { Db } from '../src/db/index.js';
import type { IncomingMessage, MessageSource, OutgoingMessage, Producer } from '../src/kafka/bus.js';
import { processMessage, RETRY_DELAYS_MS, superviseConsumer } from '../src/kafka/consumer.js';
import { chunkBySize, MAX_SEND_BYTES, messageBytes, relayOnce, startRelay } from '../src/kafka/relay.js';
import { cleanup, scheduleMaintenance } from '../src/maint.js';
import { createSnapshotFetcher, SchoolUnavailableError } from '../src/school-client.js';
import { handleSolveStatus } from '../src/domain/jobs.js';
import { maintDb, relayDb, silentLog, superDb, testApp, uuid, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let relay: Db;
let maint: Db;
let su: Db;
beforeAll(async () => {
  ctx = await testApp();
  relay = relayDb();
  maint = maintDb();
  su = superDb();
});
afterAll(async () => {
  await ctx.close();
  await Promise.all([relay.destroy(), maint.destroy(), su.destroy()]);
});

/** Kafka в пам'яті: failNext — наступна відправка падає; failOn — падає n-та відправка; понад 1 МБ — MESSAGE_TOO_LARGE. */
class MemoryProducer implements Producer {
  sent: OutgoingMessage[] = [];
  readonly calls: OutgoingMessage[][] = [];
  failNext = 0;
  failOn = 0;
  async send(messages: OutgoingMessage[]) {
    this.calls.push(messages);
    if (this.failNext > 0 || this.calls.length === this.failOn) {
      if (this.failNext > 0) this.failNext--;
      throw new Error('kafka недоступна');
    }
    // Як брокер з message.max.bytes ≈ 1 МБ: завеликий запит не приймається.
    if (messages.reduce((n, m) => n + messageBytes(m), 0) > 1_048_576) throw new Error('MESSAGE_TOO_LARGE');
    this.sent.push(...messages);
  }
  async close() {}
}

describe('доступ', () => {
  const get = (token?: string) => ctx.app.inject({ method: 'GET', url: '/api/v1/timetable/timetables', headers: token ? { authorization: `Bearer ${token}` } : {} });

  test('без токена → 401; sysadmin → 403; укладач без school_id → 403; укладач → 200', async () => {
    expect((await get()).statusCode).toBe(401);
    expect((await get('junk')).statusCode).toBe(401);
    expect((await get(await ctx.tokens.sysadmin())).statusCode).toBe(403);
    expect((await get(await ctx.tokens.sign({ realm_access: { roles: ['scheduler'] } }))).statusCode).toBe(403);
    expect((await get(await ctx.tokens.scheduler(uuid()))).statusCode).toBe(200);
  });

  test('публічний маршрут без JWT, але кабінетні — ні; /internal на публічному порту → 404', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/public/timetable' })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/timetable/internal/v1/x' })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/timetable/alert-plan' })).statusCode).toBe(401);
  });

  test('/health, невідомий маршрут, битий JSON, токен і X-Access-Token не в лозі', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    expect((await ctx.app.inject({ method: 'GET', url: '/nope' })).json()).toMatchObject({ code: 'not_found' });
    const token = await ctx.tokens.scheduler(uuid());
    const bad = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/timetable/holidays',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: '{"holiday_from":',
    });
    expect(bad.statusCode).toBe(400);
    const access = `${uuid()}.${uuid()}.${'A'.repeat(43)}`;
    await ctx.app.inject({ method: 'GET', url: '/api/v1/public/timetable', headers: { 'x-access-token': access } });
    const log = ctx.logs.lines.join('');
    expect(log).not.toContain(token);
    expect(log).not.toContain(access);
  });

  test('тіло дії з кількома варіантами перевіряється: :publish без полів → 400', async () => {
    const res = await ctx.as(uuid(), 'POST', `/timetables/${uuid()}:publish`, { order_no: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation_failed' });
  });
});

describe('консюмер', () => {
  const msg = (topic: string, value: string): IncomingMessage & { committed: number } => {
    const m = { topic, partition: 1, offset: '7', key: 'k', value, committed: 0, async commit() { m.committed++; } };
    return m;
  };

  test('solve.status через processMessage: повтори при помилці, зламана подія — одразу DLQ', async () => {
    const { id } = ctx.newSchool();
    const jobId = (await ctx.as(id, 'POST', '/timetables:build')).json().job_id;
    const producer = new MemoryProducer();
    const handlers = { 'solve.status': (_db: unknown, e: Parameters<typeof handleSolveStatus>[1]) => handleSolveStatus(ctx.deps, e) };
    const ok = msg('solve.status', JSON.stringify(ctx.status(id, 'solve.started', { job_id: jobId, started_at: new Date().toISOString() })));
    expect(await processMessage(ok, { db: ctx.db, producer, handlers, log: silentLog })).toBe('processed');
    expect((await ctx.as(id, 'GET', `/jobs/${jobId}`)).json().state).toBe('running');

    const broken = msg('solve.status', JSON.stringify(ctx.status(id, 'solve.completed', { job_id: jobId, status: '???' })));
    expect(await processMessage(broken, { db: ctx.db, producer, handlers, log: silentLog, backoffMs: () => 1000 })).toBe('dlq');
    let calls = 0;
    const flaky = msg('solve.status', JSON.stringify(ctx.status(id, 'solve.started', { job_id: jobId })));
    expect(
      await processMessage(flaky, {
        db: ctx.db,
        producer,
        handlers: { 'solve.status': async () => { calls++; throw new Error('збій'); } },
        log: silentLog,
        backoffMs: () => 1,
      }),
    ).toBe('dlq');
    expect(calls).toBe(4);
    expect(producer.sent.map((m) => [m.topic, m.headers?.['x-original-offset']])).toEqual([
      ['solve.status.dlq', '7'],
      ['solve.status.dlq', '7'],
    ]);
  });
});

describe('консюмер під наглядом', () => {
  test('superviseConsumer: упалий потік (Kafka недоступна) перезапускається з паузою, процес живе (Z6-2)', async () => {
    const producer = new MemoryProducer();
    let made = 0;
    let closed = 0;
    const seen: string[] = [];
    const source = (): MessageSource => {
      const n = ++made;
      let release: () => void = () => undefined;
      const closedSignal = new Promise<void>((r) => (release = r));
      return {
        run: async (on) => {
          if (n <= 2) throw new Error('joinGroup failed');
          const value = JSON.stringify(ctx.status(uuid(), 'solve.started', { job_id: uuid() }));
          await on({ topic: 't', partition: 0, offset: '1', key: null, value, commit: async () => { seen.push('commit'); } });
          await closedSignal; // далі потік чекає нових повідомлень, поки його не закриють
        },
        close: async () => {
          closed++;
          release();
        },
      };
    };
    const handle = superviseConsumer(source, { db: ctx.db, producer, handlers: { t: async () => { seen.push('handled'); } }, log: silentLog }, { minDelayMs: 1, maxDelayMs: 5 });
    for (let i = 0; i < 100 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(made).toBe(3);
    expect(closed).toBe(2);
    expect(seen).toEqual(['handled', 'commit']);
    await handle.stop();
    expect(closed).toBe(3);
  });

  test('технічна помилка: 4 спроби з паузами 1, 5, 15 с за замовчуванням (Z6-3)', () => {
    expect(RETRY_DELAYS_MS).toEqual([1_000, 5_000, 15_000]);
  });
});

describe('relay і чистка', () => {
  /** Подія з корисним навантаженням ~bytes байтів прямо в outbox (як великі версії розкладу). */
  async function bigEvent(schoolId: string, bytes: number) {
    const eventId = crypto.randomUUID();
    await su
      .insertInto('outbox')
      .values({ school_id: schoolId, event_id: eventId, topic: 'audit.recorded', payload: JSON.stringify({ event_id: eventId, pad: 'x'.repeat(bytes) }) })
      .execute();
    return eventId;
  }
  const isPublished = async (eventId: string) =>
    (await su.selectFrom('outbox').select('published_at').where('event_id', '=', eventId).executeTakeFirstOrThrow()).published_at !== null;

  test('пачка великих подій іде частинами до MAX_SEND_BYTES, а не одним запитом понад 1 МБ', async () => {
    while ((await relayOnce(relay, new MemoryProducer())) > 0);
    const school = crypto.randomUUID();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await bigEvent(school, 250_000));
    const producer = new MemoryProducer();
    expect(await relayOnce(relay, producer)).toBe(10);
    expect(producer.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of producer.calls) expect(call.reduce((n, m) => n + messageBytes(m), 0)).toBeLessThanOrEqual(MAX_SEND_BYTES);
    for (const id of ids) expect(await isPublished(id)).toBe(true);
  });

  test('подія понад ліміт не блокує наступні: лишається ненадісланою, решта йде, onOversize викликано', async () => {
    while ((await relayOnce(relay, new MemoryProducer())) > 0);
    const school = crypto.randomUUID();
    const huge = await bigEvent(school, 2_000_000);
    const small = await bigEvent(school, 100);
    const producer = new MemoryProducer();
    const onOversize = vi.fn();
    expect(await relayOnce(relay, producer, { onOversize })).toBe(1);
    expect(await isPublished(small)).toBe(true);
    expect(await isPublished(huge)).toBe(false);
    expect(onOversize).toHaveBeenCalledWith(expect.objectContaining({ event_id: huge, school_id: school }));
    // Прибираємо, щоб завелика подія не заважала іншим тестам файлу.
    await su.deleteFrom('outbox').where('event_id', '=', huge).execute();
  });

  test('впала не перша частина — надіслані частини зафіксовано, решта йде наступним проходом', async () => {
    while ((await relayOnce(relay, new MemoryProducer())) > 0);
    const school = crypto.randomUUID();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await bigEvent(school, 250_000));
    const producer = new MemoryProducer();
    producer.failOn = 2;
    const first = await relayOnce(relay, producer);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(6);
    expect(await relayOnce(relay, producer)).toBe(6 - first);
    for (const id of ids) expect(await isPublished(id)).toBe(true);
    expect(producer.sent).toHaveLength(6);
    expect(new Set(producer.sent.map((m) => JSON.parse(m.value).event_id))).toEqual(new Set(ids));
  });

  test('chunkBySize: порядок збережено, межа не перевищується, завеликий елемент — окремою частиною', () => {
    expect(chunkBySize([3, 3, 3, 9, 1], (n) => n, 6)).toEqual([[3, 3], [3], [9], [1]]);
    expect(chunkBySize([], (n: number) => n, 6)).toEqual([]);
  });

  test('relay відправляє outbox з ключем school_id; Kafka не прийняла — рядки лишаються', async () => {
    while ((await relayOnce(relay, new MemoryProducer())) > 0);
    const { id } = ctx.newSchool();
    await ctx.as(id, 'POST', '/timetables:build');
    const producer = new MemoryProducer();
    producer.failNext = 1;
    await expect(relayOnce(relay, producer)).rejects.toThrow('kafka недоступна');
    expect(await relayOnce(relay, producer)).toBe(1);
    expect(producer.sent[0]).toMatchObject({ topic: 'solve.build.requested', key: id });
    const handle = startRelay(relay, producer, silentLog, 5);
    await ctx.as(ctx.newSchool().id, 'PUT', '/holidays', { holiday_from: null, holiday_to: null });
    for (let i = 0; i < 100 && producer.sent.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    await handle.stop();
    expect(producer.sent.map((m) => m.topic)).toContain('audit.recorded');
  });

  test('чистка: надіслані outbox і inbox старші за 7 днів; сторож і чистка за розкладом', async () => {
    const school = uuid();
    const old = new Date('2020-01-01T00:00:00Z');
    await su.insertInto('outbox').values({ school_id: school, event_id: uuid(), topic: 't', payload: '{}', published_at: old }).execute();
    await su.insertInto('inbox').values({ school_id: school, event_id: uuid(), topic: 't', received_at: old }).execute();
    const r = await cleanup(maint);
    expect(r.outbox).toBeGreaterThanOrEqual(1);
    expect(r.inbox).toBeGreaterThanOrEqual(1);
    const stop = scheduleMaintenance(maint, silentLog);
    stop();
  });
});

describe('клієнт знімка school-service', () => {
  test('GET /internal/v1/schools/{id}/snapshot з x-request-id; не 2xx чи мережа → SchoolUnavailableError', async () => {
    const calls: { url: string; headers: unknown }[] = [];
    const fetcher = createSnapshotFetcher('http://school:3102', {
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers });
        return new Response(JSON.stringify({ school_id: 'x', snapshot_version: 3 }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await fetcher('abc', 'corr')).toMatchObject({ snapshot_version: 3 });
    expect(calls[0]).toEqual({ url: 'http://school:3102/internal/v1/schools/abc/snapshot', headers: { 'x-request-id': 'corr' } });
    const notOk = createSnapshotFetcher('http://s', { fetch: (async () => new Response('', { status: 500 })) as unknown as typeof fetch });
    await expect(notOk('a')).rejects.toBeInstanceOf(SchoolUnavailableError);
    const down = createSnapshotFetcher('http://s', { fetch: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
    await expect(down('a')).rejects.toThrow(/недоступний/);
  });
});
