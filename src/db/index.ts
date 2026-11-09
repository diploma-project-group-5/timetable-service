// Доступ до бази timetable через Kysely.
//
// ТИМЧАСОВО до появи пакета @lad/db: withSchool, outbox та inbox живуть тут (так само, як у
// tenant-service і school-service). Коли пакет з'явиться, цей модуль замінюється імпортом з нього.
import { Kysely, PostgresDialect, sql, type ColumnType, type Generated, type Transaction } from 'kysely';
import pg from 'pg';

pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.TIME, (v) => v);
// date лишаємо рядком 'YYYY-MM-DD': це календарне значення без часової зони (розділ 04).
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

type Json<T> = ColumnType<T, string, string>;

export interface SchoolStateTable {
  school_id: string;
  known_snapshot_version: Generated<number>;
  main_bells: ColumnType<BellRow[], string | undefined, string>;
  saturday: Generated<boolean>;
  holiday_from: string | null;
  holiday_to: string | null;
  updated_at: Generated<Date>;
}

export interface BellRow {
  lesson_no: number;
  start: string;
  end: string;
}

export type JobKind = 'build_main' | 'build_alert' | 'substitution';
export type JobState = 'queued' | 'running' | 'done' | 'infeasible' | 'rejected' | 'timeout' | 'failed';

export interface JobsTable {
  school_id: string;
  job_id: string;
  kind: JobKind;
  state: JobState;
  snapshot_version: number;
  time_limit_s: number;
  created_at: Generated<Date>;
  queue_deadline_at: Date;
  started_at: Date | null;
  run_deadline_at: Date | null;
  finished_at: Date | null;
  input: Json<unknown>;
  names: ColumnType<unknown, string | undefined, string>;
  conflicts: ColumnType<unknown[] | null, string | null, string | null>;
  result: ColumnType<unknown | null, string | null, string | null>;
  stats: ColumnType<unknown | null, string | null, string | null>;
  error: string | null;
  absence_id: string | null;
  date: string | null;
}

export interface TimetablesTable {
  school_id: string;
  timetable_id: string;
  kind: 'main' | 'alert';
  state: 'validated' | 'published';
  snapshot_version: number;
  input: Json<unknown>;
  names: ColumnType<unknown, string | undefined, string>;
  job_id: string | null;
  copied_from: string | null;
  build_ms: number | null;
  order_no: string | null;
  order_date: string | null;
  approved_by: string | null;
  effective_from: string | null;
  published_at: Date | null;
  created_at: Generated<Date>;
}

export interface LessonsTable {
  school_id: string;
  timetable_id: string;
  class_id: string;
  day: number;
  lesson_no: number;
  subject_id: string;
  teacher_id: string;
}

export interface DayFormatsTable {
  school_id: string;
  timetable_id: string;
  class_id: string;
  day: number;
  in_person: boolean;
}

export interface AlertPlanTable {
  school_id: string;
  timetable_id: string | null;
  state: Generated<'draft' | 'approved'>;
  order_no: string | null;
  order_date: string | null;
  approved_by: string | null;
  updated_at: Generated<Date>;
}

export interface AlertBellsTable {
  school_id: string;
  lesson_no: number;
  starts_at: string;
  ends_at: string;
}

export interface AlertActivationsTable {
  school_id: string;
  activation_id: string;
  date_from: string;
  date_to: string | null;
  created_at: Generated<Date>;
}

export interface AlertHoursTable {
  school_id: string;
  date: string;
  minutes: number;
}

export interface AbsencesTable {
  school_id: string;
  absence_id: string;
  teacher_id: string;
  date_from: string;
  date_to: string;
  lesson_nos: number[] | null;
  created_at: Generated<Date>;
  cancelled_at: Date | null;
}

export type SubstitutionKind = 'teacher' | 'moved' | 'self_study' | 'cancelled';
export type SubstitutionState = 'proposed' | 'approved' | 'rejected';

export interface SubstitutionsTable {
  school_id: string;
  job_id: string;
  date: string;
  class_id: string;
  lesson_no: number;
  timetable_id: string;
  subject_id: string;
  original_teacher_id: string;
  kind: SubstitutionKind;
  new_teacher_id: string | null;
  off_profile: Generated<boolean>;
  moved_to_date: string | null;
  moved_to_lesson_no: number | null;
  step: number | null;
  state: Generated<SubstitutionState>;
  decided_at: Date | null;
}

export interface AccessTokensTable {
  school_id: string;
  token_id: string;
  scope: 'class' | 'teacher';
  target_id: string;
  generation: Generated<number>;
  revoked_at: Date | null;
  created_at: Generated<Date>;
}

export interface OutboxTable {
  school_id: string;
  event_id: string;
  topic: string;
  payload: ColumnType<unknown, string, string>;
  created_at: Generated<Date>;
  published_at: Date | null;
}

export interface InboxTable {
  school_id: string;
  event_id: string;
  topic: string;
  received_at: Generated<Date>;
}

export interface Database {
  school_state: SchoolStateTable;
  jobs: JobsTable;
  timetables: TimetablesTable;
  lessons: LessonsTable;
  day_formats: DayFormatsTable;
  alert_plan: AlertPlanTable;
  alert_bells: AlertBellsTable;
  alert_activations: AlertActivationsTable;
  alert_hours: AlertHoursTable;
  absences: AbsencesTable;
  substitutions: SubstitutionsTable;
  access_tokens: AccessTokensTable;
  outbox: OutboxTable;
  inbox: InboxTable;
}

export type Db = Kysely<Database>;
export type Trx = Transaction<Database>;

export function createDb(connectionString: string, maxConnections = 10): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: maxConnections }) }),
  });
}

/**
 * Транзакція в контексті одного закладу: політики RLS читають app.school_id.
 * set_config(..., true) діє лише до кінця транзакції, тож заклад не «протікає» в інші запити пулу.
 */
export async function withSchool<T>(db: Db, schoolId: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.school_id', ${schoolId}, true)`.execute(trx);
    return fn(trx);
  });
}

/** Рядок «Стану закладу»: створює, якщо його ще немає. lock — SELECT … FOR UPDATE (серіалізує заклад). */
export async function ensureSchoolState(trx: Trx, schoolId: string, lock = false) {
  await sql`insert into school_state (school_id) values (${schoolId}) on conflict (school_id) do nothing`.execute(trx);
  let q = trx.selectFrom('school_state').selectAll().where('school_id', '=', schoolId);
  if (lock) q = q.forUpdate();
  return q.executeTakeFirstOrThrow();
}
