// Тестове оточення: PostgreSQL з ролями як у db-init і (для інтеграційного тесту) Kafka.
// За замовчуванням усе піднімається в контейнерах (Testcontainers, потрібен лише Docker).
// Вже запущені сервери: TEST_PG_ADMIN_URL (суперкористувач) і TEST_KAFKA_BROKERS.
// TEST_KAFKA=off — пропустити тест зі справжньою Kafka (наприклад, без Docker).
import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { migrateToLatest } from '../src/db/migrations.js';

const ROLE_PASSWORD = 'test-role-pass-123';
const ROLES = ['timetable_owner', 'timetable_app', 'timetable_relay', 'timetable_maint'] as const;
export const KAFKA_IMAGE = 'apache/kafka:4.3.2';

function withCredentials(baseUrl: string, user: string, password: string, database: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

async function prepareDatabase(adminUrl: string, database: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    // Ролі — як у platform/db-init: без SUPERUSER і без BYPASSRLS.
    for (const role of ROLES) {
      await client.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
             CREATE ROLE ${role} LOGIN;
           END IF;
         END $$`,
      );
      await client.query(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${ROLE_PASSWORD}'`);
    }
    await client.query(`CREATE DATABASE ${database} OWNER timetable_owner`);
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO timetable_app, timetable_relay, timetable_maint`);
  } finally {
    await client.end();
  }
}

async function dropDatabase(adminUrl: string, database: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await client.end();
}

const step = (msg: string) => console.log(`▶ ${msg}`);

export default async function setup(project: TestProject) {
  const cleanups: Array<() => Promise<unknown>> = [];
  const started = Date.now();

  let adminUrl = process.env.TEST_PG_ADMIN_URL;
  if (!adminUrl) {
    step('PostgreSQL 16.15 у контейнері (перший раз — завантаження образу)…');
    const container = await new PostgreSqlContainer('postgres:16.15').start();
    cleanups.push(() => container.stop());
    adminUrl = container.getConnectionUri();
  }
  const database = `timetable_test_${randomBytes(4).toString('hex')}`;
  await prepareDatabase(adminUrl, database);
  cleanups.push(() => dropDatabase(adminUrl, database));

  const urls = {
    admin: adminUrl,
    owner: withCredentials(adminUrl, 'timetable_owner', ROLE_PASSWORD, database),
    app: withCredentials(adminUrl, 'timetable_app', ROLE_PASSWORD, database),
    relay: withCredentials(adminUrl, 'timetable_relay', ROLE_PASSWORD, database),
    maint: withCredentials(adminUrl, 'timetable_maint', ROLE_PASSWORD, database),
  };
  const owner = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: urls.owner, max: 1 }) }) });
  step('ролі й база timetable, міграції…');
  await migrateToLatest(owner);
  await owner.destroy();
  project.provide('pg', urls);

  // Kafka піднімається лише для kafka.test.ts: сам тест стартує контейнер, якщо брокера не задано.
  project.provide('kafka', { brokers: process.env.TEST_KAFKA_BROKERS ?? '', enabled: process.env.TEST_KAFKA !== 'off' });

  step(`оточення готове за ${Math.round((Date.now() - started) / 1000)} с, запускаю тести`);
  return async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    pg: { admin: string; owner: string; app: string; relay: string; maint: string };
    kafka: { brokers: string; enabled: boolean };
  }
}
