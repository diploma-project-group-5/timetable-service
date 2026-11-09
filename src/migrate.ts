// Запуск міграцій роллю timetable_owner: npm run migrate (у контейнері — окремою командою).
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { migrateToLatest } from './db/migrations.js';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('Не задано MIGRATION_DATABASE_URL (підключення роллю timetable_owner, див. .env.example)');
  process.exit(1);
}

const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 1 }) }) });
try {
  const applied = await migrateToLatest(db);
  console.log(applied.length ? `Застосовано міграції: ${applied.join(', ')}` : 'Міграції вже застосовані');
} catch (err) {
  console.error('Міграція не вдалася:', err);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
