// Ролі й ізоляція в базі timetable (розділ 03): заклад A не бачить рядків закладу B; у ролях app,
// relay і maint немає BYPASSRLS; relay — лише outbox, maint — jobs, outbox та inbox; FORCE RLS на
// кожній таблиці; school_id першим у ключі; обмеження шаблону тривог і активацій тримає БД.
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { createDb, withSchool, type Db } from '../src/db/index.js';
import { createMigrator, migrateToLatest, TABLES } from '../src/db/migrations.js';
import { maintDb, relayDb, testApp, uuid, type TestCtx } from './helpers.js';

const urls = inject('pg');
let ctx: TestCtx;
let relay: Db;
let maint: Db;
let schoolA: string;
let schoolB: string;

beforeAll(async () => {
  ctx = await testApp();
  relay = relayDb();
  maint = maintDb();
  schoolA = ctx.newSchool().id;
  schoolB = ctx.newSchool().id;
  await ctx.build(schoolA);
  await ctx.build(schoolB);
});
afterAll(async () => {
  await ctx.close();
  await Promise.all([relay.destroy(), maint.destroy()]);
});

describe('ізоляція закладів у timetable_app', () => {
  test('у транзакції закладу A видно лише рядки A', async () => {
    await withSchool(ctx.db, schoolA, async (trx) => {
      for (const table of ['school_state', 'jobs', 'timetables', 'lessons', 'day_formats', 'access_tokens']) {
        const rows = await sql<{ school_id: string }>`select distinct school_id from ${sql.raw(table)}`.execute(trx);
        expect(rows.rows.map((r) => r.school_id), table).toEqual(table === 'access_tokens' ? [] : [schoolA]);
      }
    });
  });

  test('без app.school_id — 0 рядків; запис чужого закладу відхиляє RLS', async () => {
    expect(await ctx.db.selectFrom('jobs').selectAll().execute()).toEqual([]);
    await expect(
      withSchool(ctx.db, schoolA, (trx) => trx.insertInto('alert_hours').values({ school_id: schoolB, date: '2026-11-09', minutes: 10 }).execute()),
    ).rejects.toThrow(/row-level security/);
  });

  test('timetable_app не читає outbox і не змінює схему', async () => {
    await expect(withSchool(ctx.db, schoolA, (trx) => trx.selectFrom('outbox').selectAll().execute())).rejects.toThrow(/permission denied/);
    await expect(sql`create table hack (id int)`.execute(ctx.db)).rejects.toThrow(/permission denied/);
  });

  test('БД тримає: один шаблон тривог на заклад, alert без публікації, активації не перетинаються', async () => {
    await expect(
      withSchool(ctx.db, schoolA, async (trx) => {
        const tt = (await trx.selectFrom('timetables').select('timetable_id').executeTakeFirstOrThrow()).timetable_id;
        await trx.updateTable('timetables').set({ kind: 'alert', state: 'published', effective_from: '2026-11-16', published_at: new Date(), order_no: '1' }).where('timetable_id', '=', tt).execute();
      }),
    ).rejects.toThrow(/check/);
    await expect(
      withSchool(ctx.db, schoolA, async (trx) => {
        await trx.insertInto('alert_activations').values({ school_id: schoolA, activation_id: uuid(), date_from: '2026-11-10', date_to: null }).execute();
        await trx.insertInto('alert_activations').values({ school_id: schoolA, activation_id: uuid(), date_from: '2026-11-20', date_to: '2026-11-25' }).execute();
      }),
    ).rejects.toThrow(/alert_activations_no_overlap/);
  });
});

describe('relay і maint', () => {
  test('relay бачить outbox усіх закладів і не має доступу до інших таблиць', async () => {
    const rows = await relay.selectFrom('outbox').select('school_id').where('school_id', 'in', [schoolA, schoolB]).groupBy('school_id').execute();
    expect(rows).toHaveLength(2);
    for (const table of TABLES.filter((t) => t !== 'outbox')) {
      await expect(sql`select 1 from ${sql.raw(table)} limit 1`.execute(relay), table).rejects.toThrow(/permission denied/);
    }
  });

  test('maint бачить jobs усіх закладів (сторож), але не версії й уроки', async () => {
    const jobs = await maint.selectFrom('jobs').select('school_id').where('school_id', 'in', [schoolA, schoolB]).groupBy('school_id').execute();
    expect(jobs).toHaveLength(2);
    for (const table of ['timetables', 'lessons', 'access_tokens', 'substitutions', 'school_state']) {
      await expect(sql`select 1 from ${sql.raw(table)} limit 1`.execute(maint), table).rejects.toThrow(/permission denied/);
    }
    await expect(maint.deleteFrom('jobs').execute()).rejects.toThrow(/permission denied/);
  });
});

describe('ролі й таблиці', () => {
  test('у ролях немає SUPERUSER і BYPASSRLS', async () => {
    const rows = await sql<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>`
      select rolname, rolsuper, rolbypassrls from pg_roles
      where rolname in ('timetable_app', 'timetable_relay', 'timetable_maint', 'timetable_owner')`.execute(ctx.db);
    expect(rows.rows).toHaveLength(4);
    for (const r of rows.rows) expect(r).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });

  test('FORCE ROW LEVEL SECURITY на кожній таблиці; school_id — перша колонка первинного ключа', async () => {
    const rls = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace and relname not like 'kysely%'
      order by relname`.execute(ctx.db);
    expect(rls.rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
    for (const r of rls.rows) expect(r, r.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });

    const pk = await sql<{ table: string; first: string }>`
      select c.relname as table, a.attname as first
      from pg_index i join pg_class c on c.oid = i.indrelid
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      where i.indisprimary and c.relnamespace = 'public'::regnamespace and c.relname = any(${[...TABLES]})`.execute(ctx.db);
    expect(pk.rows).toHaveLength(TABLES.length);
    for (const r of pk.rows) expect(r.first, r.table).toBe('school_id');
  });
});

describe('міграції', () => {
  const ownerFor = (db: string) => {
    const u = new URL(urls.owner);
    u.pathname = `/${db}`;
    return new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: u.toString(), max: 1 }) }) });
  };

  test('на чистій базі: up, down, знову up', async () => {
    const db = `timetable_mig_${Math.random().toString(16).slice(2, 10)}`;
    const admin = new pg.Client({ connectionString: urls.admin });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${db} OWNER timetable_owner`);
    const owner = ownerFor(db);
    try {
      expect(await migrateToLatest(owner)).toEqual(['0001_timetable']);
      const down = await createMigrator(owner).migrateDown();
      expect(down.error).toBeUndefined();
      const left = await sql<{ n: number }>`select count(*)::int as n from pg_tables where schemaname = 'public' and tablename not like 'kysely%'`.execute(owner);
      expect(left.rows[0]?.n).toBe(0);
      expect(await migrateToLatest(owner)).toEqual(['0001_timetable']);
    } finally {
      await owner.destroy();
      await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);
      await admin.end();
    }
  });

  test('помилка міграції не ковтається (timetable_app не може створювати таблиці)', async () => {
    const db = `timetable_mig_${Math.random().toString(16).slice(2, 10)}`;
    const admin = new pg.Client({ connectionString: urls.admin });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${db} OWNER timetable_owner`);
    await admin.query(`GRANT CONNECT ON DATABASE ${db} TO timetable_app`);
    const u = new URL(urls.app);
    u.pathname = `/${db}`;
    const asApp = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: u.toString(), max: 1 }) }) });
    try {
      await expect(migrateToLatest(asApp)).rejects.toThrow();
    } finally {
      await asApp.destroy();
      await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);
      await admin.end();
    }
  });

  test('повторний запуск нічого не робить', async () => {
    const owner = createDb(urls.owner, 1) as unknown as Kysely<unknown>;
    try {
      expect(await migrateToLatest(owner)).toEqual([]);
    } finally {
      await owner.destroy();
    }
  });
});
