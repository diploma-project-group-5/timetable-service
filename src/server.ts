// Точка входу: npm run dev (локально) або node dist/server.js (контейнер).
// Один процес: HTTP, relay outbox → Kafka, консюмер (school.data.changed, solve.status), сторож і чистка.
import { buildApp, LOG_REDACT } from './app.js';
import { createTokenVerifier, remoteKeys } from './auth.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import type { Deps } from './domain/context.js';
import { handleSolveStatus } from './domain/jobs.js';
import { handleSchoolDataChanged } from './domain/misc.js';
import { runConsumer } from './kafka/consumer.js';
import { createProducer, createSource } from './kafka/platformatic.js';
import { startRelay, type RelayHandle } from './kafka/relay.js';
import type { MessageSource, Producer } from './kafka/bus.js';
import { scheduleMaintenance } from './maint.js';
import { createSnapshotFetcher } from './school-client.js';

const config = loadConfig();
const logger = { level: config.logLevel, redact: LOG_REDACT };

const db = createDb(config.databaseUrl);
const relayDb = createDb(config.relayDatabaseUrl, 2);
const maintDb = createDb(config.maintDatabaseUrl, 1);

const deps: Deps = {
  db,
  fetchSnapshot: createSnapshotFetcher(config.schoolInternalUrl),
  policy: config.policy,
  qrSecret: config.qrSecret,
  publicUrl: config.publicUrl,
  now: () => new Date(),
};

const app = buildApp({
  ...deps,
  verifyToken: createTokenVerifier({ issuer: config.oidcIssuer, clientId: config.oidcClientId, keys: remoteKeys(config.oidcJwksUrl) }),
  logger,
});

let producer: Producer | undefined;
let source: MessageSource | undefined;
let relay: RelayHandle | undefined;
if (config.kafkaBrokers.length > 0) {
  producer = createProducer({ brokers: config.kafkaBrokers, clientId: config.kafkaClientId });
  relay = startRelay(relayDb, producer, app.log.child({ component: 'relay' }), config.relayIntervalMs);
  const handlers = {
    'school.data.changed': (_db: unknown, e: Parameters<typeof handleSchoolDataChanged>[1]) => handleSchoolDataChanged(deps, e),
    'solve.status': (_db: unknown, e: Parameters<typeof handleSolveStatus>[1]) => handleSolveStatus(deps, e),
  };
  source = createSource({ brokers: config.kafkaBrokers, clientId: config.kafkaClientId, groupId: config.kafkaGroupId, topics: Object.keys(handlers) });
  const consumerLog = app.log.child({ component: 'consumer' });
  runConsumer(source, { db, producer, handlers, log: consumerLog }).catch((err) => {
    consumerLog.fatal({ err }, 'консюмер зупинився');
    process.exit(1);
  });
} else {
  app.log.warn('KAFKA_BROKERS не задано: події не відправляються й не приймаються');
}
const stopMaintenance = scheduleMaintenance(maintDb, app.log.child({ component: 'maint' }));

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'зупинка');
  stopMaintenance();
  await app.close();
  await relay?.stop();
  await source?.close().catch(() => undefined);
  await producer?.close().catch(() => undefined);
  await Promise.allSettled([db.destroy(), relayDb.destroy(), maintDb.destroy()]);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
