// Інтеграція зі справжньою Kafka 4.3.2 (той самий образ, що в platform): relay → solve.build.requested,
// консюмер solve.status → задача done, зламана подія → DLQ. Без Docker: TEST_KAFKA=off.
import { createServer } from 'node:net';
import { Admin, Consumer, stringDeserializers } from '@platformatic/kafka';
import Fastify from 'fastify';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { handleSolveStatus } from '../src/domain/jobs.js';
import { handleSchoolDataChanged } from '../src/domain/misc.js';
import { runConsumer } from '../src/kafka/consumer.js';
import { createProducer, createSource } from '../src/kafka/platformatic.js';
import { relayOnce } from '../src/kafka/relay.js';
import type { Db } from '../src/db/index.js';
import type { MessageSource, Producer } from '../src/kafka/bus.js';
import { relayDb, solve, testApp, type BuildRequest, type TestCtx } from './helpers.js';
import { KAFKA_IMAGE } from './global-setup.js';

const { brokers: givenBrokers, enabled } = inject('kafka');
const log = Fastify({ logger: { level: 'silent' } }).log;
const TOPICS = ['solve.build.requested', 'solve.status', 'solve.status.dlq', 'school.data.changed', 'school.data.changed.dlq', 'audit.recorded'];

/** Вільний порт хоста: брокер оголошує клієнтам саме його (advertised listener). */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

async function startKafka(): Promise<{ brokers: string[]; container: StartedTestContainer }> {
  const port = await freePort();
  const container = await new GenericContainer(KAFKA_IMAGE)
    .withExposedPorts({ container: 9092, host: port })
    .withEnvironment({
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
      KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://localhost:${port}`,
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT',
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
    })
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .withStartupTimeout(120_000)
    .start();
  return { brokers: [`localhost:${port}`], container };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('не дочекались');
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Читає топік з початку окремою групою, поки predicate не знайде повідомлення. */
async function readUntil(brokers: string[], topic: string, predicate: (value: string, headers: Map<string, string>) => boolean) {
  const consumer = new Consumer({
    clientId: 'test-reader',
    groupId: `test-reader-${crypto.randomUUID()}`,
    bootstrapBrokers: brokers,
    deserializers: stringDeserializers,
  });
  const stream = await consumer.consume({ topics: [topic], mode: 'earliest', autocommit: false });
  try {
    const timer = setTimeout(() => void stream.close(), 30_000);
    for await (const m of stream) {
      if (predicate(m.value ?? '', m.headers)) {
        clearTimeout(timer);
        return { key: m.key, value: m.value ?? '', headers: m.headers };
      }
    }
    throw new Error(`повідомлення в ${topic} не знайдено`);
  } finally {
    await stream.close().catch(() => undefined);
    await consumer.close(true);
  }
}

describe.skipIf(!enabled)('Kafka', () => {
  let container: StartedTestContainer | undefined;
  let brokers: string[];
  let ctx: TestCtx;
  let relay: Db;
  let producer: Producer;
  let source: MessageSource;
  let consuming: Promise<void>;

  beforeAll(async () => {
    if (givenBrokers) brokers = givenBrokers.split(',');
    else ({ brokers, container } = await startKafka());
    const admin = new Admin({ clientId: 'test-admin', bootstrapBrokers: brokers });
    await admin.createTopics({ topics: TOPICS, partitions: 3, replicas: 1 }).catch((err: Error) => {
      if (!/already exists/i.test(String(err.message) + JSON.stringify(err))) throw err;
    });
    await admin.close();

    ctx = await testApp();
    relay = relayDb();
    producer = createProducer({ brokers, clientId: 'timetable-service-test' });
    const handlers = {
      'school.data.changed': (_db: unknown, e: Parameters<typeof handleSchoolDataChanged>[1]) => handleSchoolDataChanged(ctx.deps, e),
      'solve.status': (_db: unknown, e: Parameters<typeof handleSolveStatus>[1]) => handleSolveStatus(ctx.deps, e),
    };
    source = createSource({ brokers, clientId: 'timetable-service-test', groupId: `timetable-service-test-${crypto.randomUUID()}`, topics: Object.keys(handlers) });
    consuming = runConsumer(source, { db: ctx.db, producer, handlers, log, backoffMs: () => 10 });
  }, 180_000);

  afterAll(async () => {
    await source?.close().catch(() => undefined);
    await consuming?.catch(() => undefined);
    await producer?.close().catch(() => undefined);
    await relay?.destroy();
    await ctx?.close();
    await container?.stop();
  });

  test('побудова наскрізь: relay → solve.build.requested; solve.status з топіка → задача done', async () => {
    const { id } = ctx.newSchool();
    const jobId = (await ctx.as(id, 'POST', '/timetables:build')).json().job_id as string;
    while ((await relayOnce(relay, producer)) > 0);
    const msg = await readUntil(brokers, 'solve.build.requested', (v) => v.includes(jobId));
    expect(msg.key).toBe(id);
    const request = JSON.parse(msg.value).data as BuildRequest;
    const envelope = (type: string, data: Record<string, unknown>) =>
      JSON.stringify({ event_id: crypto.randomUUID(), type, schema_version: '1.0', source: 'solver', time: new Date().toISOString(), correlation_id: 'kafka', school_id: id, data });
    await producer.send([
      { topic: 'solve.status', key: id, value: envelope('solve.started', { job_id: jobId, started_at: new Date().toISOString() }) },
      { topic: 'solve.status', key: id, value: envelope('solve.completed', { job_id: jobId, status: 'FEASIBLE', ...solve(request), conflicts: [] }) },
    ]);
    const job = await waitFor(async () => {
      const j = (await ctx.as(id, 'GET', `/jobs/${jobId}`)).json();
      return j.state === 'done' ? j : undefined;
    });
    expect(job.result.timetable_id).toBeTruthy();
  });

  test('зламана подія → solve.status.dlq з причиною', async () => {
    const marker = `broken-${crypto.randomUUID()}`;
    await producer.send([{ topic: 'solve.status', key: crypto.randomUUID(), value: marker }]);
    const msg = await readUntil(brokers, 'solve.status.dlq', (v) => v === marker);
    expect(msg.headers.get('x-original-topic')).toBe('solve.status');
  });
});
