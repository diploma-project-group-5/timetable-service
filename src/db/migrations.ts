// Міграції бази timetable. Виконуються роллю timetable_owner окремою командою (npm run migrate).
// Ролі timetable_app, timetable_relay, timetable_maint створює db-init у репозиторії platform.
//
// Ізоляція закладів (розділ 03): school_id першим у кожному первинному ключі, FORCE ROW LEVEL
// SECURITY на кожній таблиці. relay — лише outbox; maint — сторож задач (jobs), outbox та inbox.
import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';

const CURRENT_SCHOOL = sql.raw(`nullif(current_setting('app.school_id', true), '')::uuid`);

async function isolate(db: Kysely<unknown>, table: string): Promise<void> {
  const t = sql.raw(table);
  await sql`alter table ${t} enable row level security`.execute(db);
  await sql`alter table ${t} force row level security`.execute(db);
  await sql`
    create policy ${sql.raw(`${table}_app`)} on ${t} to timetable_app
      using (school_id = ${CURRENT_SCHOOL})
      with check (school_id = ${CURRENT_SCHOOL})`.execute(db);
}

export const TABLES = [
  'school_state',
  'jobs',
  'timetables',
  'lessons',
  'day_formats',
  'alert_plan',
  'alert_bells',
  'alert_activations',
  'alert_hours',
  'absences',
  'substitutions',
  'access_tokens',
  'outbox',
  'inbox',
] as const;

const migrations: Record<string, Migration> = {
  '0001_timetable': {
    async up(db: Kysely<unknown>) {
      await sql`create extension if not exists btree_gist`.execute(db);

      // «Стан закладу»: останній відомий snapshot_version з school.data.changed, основні дзвінки
      // (для сторінок за QR), канікули двома датами (етап 2). Рядок — ще й блокування закладу
      // для :publish і :approve заміни (SELECT … FOR UPDATE).
      await sql`
        create table school_state (
          school_id              uuid primary key,
          known_snapshot_version bigint not null default 0,
          main_bells             jsonb not null default '[]',
          saturday               boolean not null default false,
          holiday_from           date,
          holiday_to             date,
          updated_at             timestamptz not null default now(),
          check ((holiday_from is null) = (holiday_to is null)),
          check (holiday_from is null or holiday_from <= holiday_to)
        )`.execute(db);

      // Задачі розрахунку. input — проєкція знімка, з якою пішла задача: нею validator-lib перевіряє
      // результат; names — копія назв і підписів для нової версії (у Kafka вони не йдуть).
      await sql`
        create table jobs (
          school_id         uuid not null,
          job_id            uuid not null,
          kind              text not null check (kind in ('build_main', 'build_alert', 'substitution')),
          state             text not null check (state in ('queued', 'running', 'done', 'infeasible', 'rejected', 'timeout', 'failed')),
          snapshot_version  bigint not null,
          time_limit_s      integer not null check (time_limit_s > 0),
          created_at        timestamptz not null default now(),
          queue_deadline_at timestamptz not null,
          started_at        timestamptz,
          run_deadline_at   timestamptz,
          finished_at       timestamptz,
          input             jsonb not null,
          names             jsonb not null default '{}',
          conflicts         jsonb,
          result            jsonb,
          stats             jsonb,
          error             text,
          absence_id        uuid,
          date              date,
          primary key (school_id, job_id),
          check ((kind = 'substitution') = (date is not null))
        )`.execute(db);
      // Одночасно на заклад — одна побудова (основного чи тривог).
      await sql`
        create unique index jobs_one_active_build on jobs (school_id)
          where kind in ('build_main', 'build_alert') and state in ('queued', 'running')`.execute(db);
      await sql`create index jobs_watchdog on jobs (state, queue_deadline_at, run_deadline_at) where state in ('queued', 'running')`.execute(db);

      // Версії розкладу. kind='alert' — шаблон розкладу тривог: лише validated, без дати дії й
      // публікації; один на заклад. Усі читання основного розкладу фільтрують kind='main'.
      await sql`
        create table timetables (
          school_id        uuid not null,
          timetable_id     uuid not null,
          kind             text not null check (kind in ('main', 'alert')),
          state            text not null check (state in ('validated', 'published')),
          snapshot_version bigint not null,
          input            jsonb not null,
          names            jsonb not null default '{}',
          job_id           uuid,
          copied_from      uuid,
          build_ms         integer,
          order_no         text check (length(order_no) between 1 and 100),
          order_date       date,
          approved_by      text check (length(approved_by) between 1 and 200),
          effective_from   date,
          published_at     timestamptz,
          created_at       timestamptz not null default now(),
          primary key (school_id, timetable_id),
          check (kind = 'main' or (state = 'validated' and effective_from is null and published_at is null)),
          check ((state = 'published') = (effective_from is not null and published_at is not null and order_no is not null))
        )`.execute(db);
      await sql`create unique index timetables_one_alert on timetables (school_id) where kind = 'alert'`.execute(db);

      // Урок визначає слот; окремого id немає.
      await sql`
        create table lessons (
          school_id    uuid not null,
          timetable_id uuid not null,
          class_id     uuid not null,
          day          smallint not null check (day between 1 and 6),
          lesson_no    smallint not null check (lesson_no between 1 and 10),
          subject_id   uuid not null,
          teacher_id   uuid not null,
          primary key (school_id, timetable_id, class_id, day, lesson_no),
          foreign key (school_id, timetable_id) references timetables (school_id, timetable_id) on delete cascade
        )`.execute(db);
      await sql`create index lessons_teacher on lessons (school_id, teacher_id)`.execute(db);

      await sql`
        create table day_formats (
          school_id    uuid not null,
          timetable_id uuid not null,
          class_id     uuid not null,
          day          smallint not null check (day between 1 and 6),
          in_person    boolean not null,
          primary key (school_id, timetable_id, class_id, day),
          foreign key (school_id, timetable_id) references timetables (school_id, timetable_id) on delete cascade
        )`.execute(db);

      await sql`
        create table alert_plan (
          school_id    uuid primary key,
          timetable_id uuid,
          state        text not null default 'draft' check (state in ('draft', 'approved')),
          order_no     text,
          order_date   date,
          approved_by  text,
          updated_at   timestamptz not null default now(),
          check ((state = 'approved') = (order_no is not null))
        )`.execute(db);

      await sql`
        create table alert_bells (
          school_id uuid not null,
          lesson_no smallint not null check (lesson_no between 1 and 10),
          starts_at time not null,
          ends_at   time not null,
          primary key (school_id, lesson_no),
          check (starts_at < ends_at)
        )`.execute(db);

      // Активація розкладу тривог: [date_from, date_to) — з дати повернення знову діє основний.
      // Активації закладу не перетинаються (EXCLUDE).
      await sql`
        create table alert_activations (
          school_id     uuid not null,
          activation_id uuid not null,
          date_from     date not null,
          date_to       date,
          created_at    timestamptz not null default now(),
          primary key (school_id, activation_id),
          check (date_to is null or date_to > date_from),
          constraint alert_activations_no_overlap exclude using gist (school_id with =, daterange(date_from, date_to, '[)') with &&)
        )`.execute(db);

      await sql`
        create table alert_hours (
          school_id uuid not null,
          date      date not null,
          minutes   smallint not null check (minutes between 0 and 1440),
          primary key (school_id, date)
        )`.execute(db);

      // Відсутність вчителя: причина не зберігається. lesson_nos null — увесь день.
      await sql`
        create table absences (
          school_id    uuid not null,
          absence_id   uuid not null,
          teacher_id   uuid not null,
          date_from    date not null,
          date_to      date not null,
          lesson_nos   smallint[],
          created_at   timestamptz not null default now(),
          cancelled_at timestamptz,
          primary key (school_id, absence_id),
          check (date_from <= date_to)
        )`.execute(db);

      // Пропозиція задачі заміни на дату; відхилені зберігаються (RQ4). Одна погоджена накладка на слот.
      await sql`
        create table substitutions (
          school_id           uuid not null,
          job_id              uuid not null,
          date                date not null,
          class_id            uuid not null,
          lesson_no           smallint not null check (lesson_no between 1 and 10),
          timetable_id        uuid not null,
          subject_id          uuid not null,
          original_teacher_id uuid not null,
          kind                text not null check (kind in ('teacher', 'moved', 'self_study', 'cancelled')),
          new_teacher_id      uuid,
          off_profile         boolean not null default false,
          moved_to_date       date,
          moved_to_lesson_no  smallint,
          step                smallint,
          state               text not null default 'proposed' check (state in ('proposed', 'approved', 'rejected')),
          decided_at          timestamptz,
          primary key (school_id, job_id, date, class_id, lesson_no),
          check ((kind = 'teacher') = (new_teacher_id is not null)),
          check ((kind = 'moved') = (moved_to_date is not null and moved_to_lesson_no is not null))
        )`.execute(db);
      await sql`
        create unique index substitutions_one_approved on substitutions (school_id, date, class_id, lesson_no)
          where state = 'approved'`.execute(db);

      // QR-токен: відкритий токен не зберігається, а відтворюється з HMAC (розділ 11).
      await sql`
        create table access_tokens (
          school_id  uuid not null,
          token_id   uuid not null,
          scope      text not null check (scope in ('class', 'teacher')),
          target_id  uuid not null,
          generation integer not null default 1 check (generation > 0),
          revoked_at timestamptz,
          created_at timestamptz not null default now(),
          primary key (school_id, token_id),
          unique (school_id, scope, target_id)
        )`.execute(db);

      await sql`
        create table outbox (
          school_id    uuid not null,
          event_id     uuid not null,
          topic        text not null,
          payload      jsonb not null,
          created_at   timestamptz not null default now(),
          published_at timestamptz,
          primary key (school_id, event_id)
        )`.execute(db);
      await sql`create index outbox_unpublished on outbox (created_at) where published_at is null`.execute(db);

      await sql`
        create table inbox (
          school_id   uuid not null,
          event_id    uuid not null,
          topic       text not null,
          received_at timestamptz not null default now(),
          primary key (school_id, event_id)
        )`.execute(db);
      await sql`create index inbox_received on inbox (received_at)`.execute(db);

      for (const table of TABLES) await isolate(db, table);
      await sql`create policy outbox_relay on outbox to timetable_relay using (true) with check (true)`.execute(db);
      await sql`create policy outbox_maint on outbox to timetable_maint using (true)`.execute(db);
      await sql`create policy inbox_maint on inbox to timetable_maint using (true)`.execute(db);
      await sql`create policy jobs_maint on jobs to timetable_maint using (true) with check (true)`.execute(db);

      const data = TABLES.filter((t) => t !== 'outbox' && t !== 'inbox').join(', ');
      await sql`grant select, insert, update, delete on ${sql.raw(data)} to timetable_app`.execute(db);
      await sql`grant insert on outbox to timetable_app`.execute(db);
      await sql`grant select, insert on inbox to timetable_app`.execute(db);
      await sql`grant select, update on outbox to timetable_relay`.execute(db);
      await sql`grant select, delete on outbox, inbox to timetable_maint`.execute(db);
      await sql`grant select, update on jobs to timetable_maint`.execute(db);
    },
    async down(db: Kysely<unknown>) {
      for (const table of [...TABLES].reverse()) await sql`drop table ${sql.raw(table)}`.execute(db);
    },
  },
};

const provider: MigrationProvider = { getMigrations: async () => migrations };

export function createMigrator(db: Kysely<unknown>): Migrator {
  return new Migrator({ db, provider });
}

export async function migrateToLatest(db: Kysely<unknown>): Promise<string[]> {
  const { error, results } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
