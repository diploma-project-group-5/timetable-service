// Доступ (JWT), консюмер (3 спроби → DLQ), relay, чистка, клієнт знімка school-service.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Db } from '../src/db/index.js';
import type { IncomingMessage, OutgoingMessage, Producer } from '../src/kafka/bus.js';
import { processMessage } from '../src/kafka/consumer.js';
import { relayOnce, startRelay } from '../src/kafka/relay.js';
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

class MemoryProducer implements Producer {
  sent: OutgoingMessage[] = [];
  failNext = 0;
  async send(messages: OutgoingMessage[]) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('kafka недоступна');
    }
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
    expect(calls).toBe(3);
    expect(producer.sent.map((m) => [m.topic, m.headers?.['x-original-offset']])).toEqual([
      ['solve.status.dlq', '7'],
      ['solve.status.dlq', '7'],
    ]);
  });
});

describe('relay і чистка', () => {
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
