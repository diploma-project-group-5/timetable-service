// Задачі розрахунку (розділи 05, 06, 12): створення побудови, приймання solve.status від solver,
// сторож прострочених задач. timetable сам не рахує: він веде задачі й перевіряє результат.
import { randomUUID } from 'node:crypto';
import type { Snapshot } from '@lad/validator-lib';
import { sql } from 'kysely';
import { claimInbox, InvalidEventError, writeOutbox, type Envelope } from '../db/events.js';
import { ensureSchoolState, withSchool, type BellRow, type Db, type JobKind, type JobState, type Trx } from '../db/index.js';
import { fail } from '../problem.js';
import { todayKyiv } from '../time.js';
import type { Ctx, Deps } from './context.js';
import { isTerminal, onCompleted, onStarted, SOLVE_STATUSES, type SolveStatus } from './job-state.js';
import { missingProfileFields, precheck, project, type Kind, type Names } from './projection.js';
import { check, conflictsOf, insertVersion, type TimetableData } from './store.js';
import { storeProposals } from './substitutions.js';

export interface JobView {
  job_id: string;
  kind: JobKind;
  state: JobState;
  snapshot_version: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  conflicts?: unknown[];
  result?: unknown;
  error?: string;
}

const isUniqueViolation = (err: unknown, constraint: string) => {
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === constraint;
};

/** Чи є чинна або майбутня активація розкладу тривог (на сьогодні за Києвом). */
export async function hasCurrentOrFutureActivation(trx: Trx, today: string): Promise<boolean> {
  const row = await trx
    .selectFrom('alert_activations')
    .select('activation_id')
    .where((eb) => eb.or([eb('date_to', 'is', null), eb('date_to', '>', today)]))
    .executeTakeFirst();
  return row !== undefined;
}

export async function readAlertBells(trx: Trx): Promise<BellRow[]> {
  const rows = await trx.selectFrom('alert_bells').selectAll().orderBy('lesson_no').execute();
  return rows.map((r) => ({ lesson_no: r.lesson_no, start: r.starts_at.slice(0, 5), end: r.ends_at.slice(0, 5) }));
}

/**
 * POST /timetables:build (kind=main) і POST /alert-plan:build (kind=alert): знімок у school,
 * задача з snapshot_version і queue_deadline_at, solve.build.requested через outbox.
 * Дешеві передперевірки, що не пройшли, одразу дають задачу infeasible.
 */
export async function startBuild(deps: Deps, ctx: Ctx, kind: Kind): Promise<{ job_id: string }> {
  const snapshot = await deps.fetchSnapshot(ctx.schoolId, ctx.correlationId);
  const now = deps.now();
  const jobKind: JobKind = kind === 'main' ? 'build_main' : 'build_alert';
  try {
    return await withSchool(deps.db, ctx.schoolId, async (trx) => {
      await syncSchoolState(trx, ctx.schoolId, snapshot);
      let alertBells: BellRow[] = [];
      if (kind === 'alert') {
        if (await hasCurrentOrFutureActivation(trx, todayKyiv(now))) {
          fail(409, 'alert_plan_active', 'Розклад тривог діє за наказом', 'Поки є чинна або майбутня активація, план не перебудовується');
        }
        alertBells = await readAlertBells(trx);
      }
      // Одна побудова на заклад (розділ 05). Індекс jobs_one_active_build ловить гонку; явна перевірка —
      // щоб і задача, яку передперевірка одразу закриває як infeasible, не обходила правило.
      const active = await activeBuildId(trx);
      if (active) fail(409, 'build_in_progress', 'Побудова вже йде', 'Дочекайтеся завершення активної задачі', { job_id: active });
      const missing = missingProfileFields(snapshot, kind, alertBells);
      if (missing.length > 0) {
        fail(422, 'profile_incomplete', 'Профіль закладу неповний', `Заповніть: ${missing.join(', ')}`, { fields: missing });
      }
      const { input, names } = project(snapshot, kind, deps.policy.priorityAreas, alertBells);
      const jobId = randomUUID();
      const pre = precheck(input);
      const queueDeadline = new Date(now.getTime() + deps.policy.queueAllowanceS * 1000);
      await trx
        .insertInto('jobs')
        .values({
          school_id: ctx.schoolId,
          job_id: jobId,
          kind: jobKind,
          state: pre.length > 0 ? 'infeasible' : 'queued',
          snapshot_version: snapshot.snapshot_version,
          time_limit_s: deps.policy.buildTimeLimitS,
          created_at: now,
          queue_deadline_at: queueDeadline,
          started_at: null,
          run_deadline_at: null,
          finished_at: pre.length > 0 ? now : null,
          input: JSON.stringify(input),
          names: JSON.stringify(names),
          conflicts: pre.length > 0 ? JSON.stringify(pre) : null,
          result: null,
          stats: null,
          error: null,
          absence_id: null,
          date: null,
        })
        .execute();
      if (pre.length === 0) {
        await writeOutbox(trx, {
          topic: 'solve.build.requested',
          schoolId: ctx.schoolId,
          correlationId: ctx.correlationId,
          data: buildRequestData(jobId, kind, snapshot.snapshot_version, input, deps.policy.buildTimeLimitS, queueDeadline),
        });
      }
      return { job_id: jobId };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'jobs_one_active_build')) {
      const active = await withSchool(deps.db, ctx.schoolId, activeBuildId);
      fail(409, 'build_in_progress', 'Побудова вже йде', 'Дочекайтеся завершення активної задачі', { job_id: active });
    }
    throw err;
  }
}

async function activeBuildId(trx: Trx): Promise<string | undefined> {
  const row = await trx
    .selectFrom('jobs')
    .select('job_id')
    .where('kind', 'in', ['build_main', 'build_alert'])
    .where('state', 'in', ['queued', 'running'])
    .executeTakeFirst();
  return row?.job_id;
}

/** data для solve.build.requested.v1 (contracts). */
export function buildRequestData(jobId: string, kind: Kind, snapshotVersion: number, input: Snapshot, timeLimitS: number, queueDeadline: Date) {
  return {
    job_id: jobId,
    kind,
    model: kind === 'main' ? '1.1' : '1.2',
    snapshot_version: snapshotVersion,
    time_limit_s: timeLimitS,
    queue_deadline_at: queueDeadline.toISOString(),
    school_days: input.school_days,
    lessons_per_day: input.lessons_per_day,
    staff: input.staff,
    capacity: input.capacity,
    classes: input.classes,
    subjects: input.subjects,
    teachers: input.teachers,
    rows: input.rows,
  };
}

/** «Стан закладу»: останній відомий snapshot_version, субота й основні дзвінки зі свіжого знімка. */
export async function syncSchoolState(
  trx: Trx,
  schoolId: string,
  snapshot: { snapshot_version: number; profile: { saturday: boolean }; bells: BellRow[] },
): Promise<void> {
  await ensureSchoolState(trx, schoolId);
  await trx
    .updateTable('school_state')
    .set({
      known_snapshot_version: sql<number>`greatest(known_snapshot_version, ${snapshot.snapshot_version})`,
      saturday: snapshot.profile.saturday,
      main_bells: JSON.stringify(snapshot.bells),
      updated_at: new Date(),
    })
    .where('school_id', '=', schoolId)
    .execute();
}

const toView = (r: {
  job_id: string;
  kind: JobKind;
  state: JobState;
  snapshot_version: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  conflicts: unknown[] | null;
  result: unknown;
  error: string | null;
}): JobView => ({
  job_id: r.job_id,
  kind: r.kind,
  state: r.state,
  snapshot_version: r.snapshot_version,
  created_at: r.created_at.toISOString(),
  started_at: r.started_at?.toISOString() ?? null,
  finished_at: r.finished_at?.toISOString() ?? null,
  ...(r.conflicts ? { conflicts: r.conflicts } : {}),
  ...(r.result ? { result: r.result } : {}),
  ...(r.error ? { error: r.error } : {}),
});

export async function getJob(db: Db, schoolId: string, jobId: string): Promise<JobView> {
  const row = await withSchool(db, schoolId, (trx) =>
    trx
      .selectFrom('jobs')
      .select(['job_id', 'kind', 'state', 'snapshot_version', 'created_at', 'started_at', 'finished_at', 'conflicts', 'result', 'error'])
      .where('job_id', '=', jobId)
      .executeTakeFirst(),
  );
  if (!row) return fail(404, 'not_found', 'Задачу не знайдено');
  return toView(row);
}

// ───────────── solve.status ─────────────

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** solve.started / solve.completed від solver. Повтор event_id і пізні події відкидаються. */
export async function handleSolveStatus(deps: Deps, e: Envelope): Promise<'processed' | 'duplicate' | 'ignored'> {
  const jobId = str(e.data.job_id);
  if (!jobId) throw new InvalidEventError('solve.status без job_id');
  if (e.type !== 'solve.started' && e.type !== 'solve.completed') throw new InvalidEventError(`невідомий тип ${e.type}`);
  const startedAt = new Date(str(e.data.started_at) ?? e.time);
  if (e.type === 'solve.started' && Number.isNaN(startedAt.getTime())) throw new InvalidEventError('solve.started з некоректним started_at');
  const status = str(e.data.status) as SolveStatus | undefined;
  if (e.type === 'solve.completed' && (!status || !SOLVE_STATUSES.includes(status))) {
    throw new InvalidEventError(`solve.completed з невідомим статусом ${String(status)}`);
  }
  return withSchool(deps.db, e.school_id, async (trx) => {
    if (!(await claimInbox(trx, e.school_id, e.event_id, 'solve.status'))) return 'duplicate';
    const job = await trx.selectFrom('jobs').selectAll().where('job_id', '=', jobId).forUpdate().executeTakeFirst();
    if (!job) return 'ignored';
    if (e.type === 'solve.started') {
      const d = onStarted(job, startedAt, deps.policy.runDeadlineMarginS);
      if (!d.accept) return 'ignored';
      await trx.updateTable('jobs').set({ state: 'running', started_at: d.started_at, run_deadline_at: d.run_deadline_at }).where('job_id', '=', jobId).execute();
      return 'processed';
    }
    const next = onCompleted(job, status!);
    if (next === null) return 'ignored';
    await completeJob(deps, trx, e, job, status!, next);
    return 'processed';
  });
}

interface JobRow {
  school_id: string;
  job_id: string;
  kind: JobKind;
  snapshot_version: number;
  input: unknown;
  names: unknown;
  date: string | null;
  absence_id: string | null;
}

async function finish(
  trx: Trx,
  jobId: string,
  state: JobState,
  extra: { conflicts?: unknown[] | null; result?: unknown; stats?: unknown; error?: string | null } = {},
): Promise<void> {
  await trx
    .updateTable('jobs')
    .set({
      state,
      finished_at: new Date(),
      conflicts: extra.conflicts && extra.conflicts.length > 0 ? JSON.stringify(extra.conflicts) : null,
      result: extra.result === undefined ? null : JSON.stringify(extra.result),
      stats: extra.stats === undefined ? null : JSON.stringify(extra.stats),
      error: extra.error ?? null,
    })
    .where('job_id', '=', jobId)
    .execute();
}

async function completeJob(deps: Deps, trx: Trx, e: Envelope, job: JobRow, status: SolveStatus, next: JobState): Promise<void> {
  const stats = e.data.stats ?? undefined;
  const conflicts = Array.isArray(e.data.conflicts) ? e.data.conflicts : [];
  if (next !== 'done') {
    const error = (e.data.error as { code?: string } | undefined)?.code ?? (status === 'EXPIRED' ? 'expired' : null);
    await finish(trx, job.job_id, next, { conflicts, stats, error });
    return;
  }
  if (job.kind === 'substitution') {
    const proposals = await storeProposals(trx, job, e.data);
    await finish(trx, job.job_id, 'done', { result: { proposals }, stats });
    return;
  }

  const data: TimetableData = {
    lessons: Array.isArray(e.data.lessons) ? (e.data.lessons as TimetableData['lessons']) : [],
    day_formats: Array.isArray(e.data.day_formats) ? (e.data.day_formats as TimetableData['day_formats']) : [],
  };
  const input = job.input as Snapshot;
  const outcome = check(input, data);
  if (outcome.status !== 'ACCEPTED') {
    // REJECTED або зламаний розклад — помилка solver, звіт зберігається; зламаний знімок — технічний збій.
    const technical = outcome.status === 'INVALID_INPUT' && outcome.issues.some((i) => i.part !== 'timetable');
    await finish(trx, job.job_id, technical ? 'failed' : 'rejected', {
      conflicts: conflictsOf(outcome),
      stats,
      error: technical ? 'invalid_snapshot' : 'validator_rejected',
    });
    return;
  }
  const buildMs = typeof (stats as { wall_time_ms?: unknown } | undefined)?.wall_time_ms === 'number' ? (stats as { wall_time_ms: number }).wall_time_ms : null;

  if (job.kind === 'build_main') {
    const timetableId = await insertVersion(trx, {
      schoolId: job.school_id,
      kind: 'main',
      snapshotVersion: job.snapshot_version,
      input,
      names: job.names as Names,
      jobId: job.job_id,
      buildMs,
      data,
    });
    await finish(trx, job.job_id, 'done', { result: { timetable_id: timetableId }, stats });
    return;
  }

  // build_alert: план, який уже погоджено або активовано, не перезаписується (розділ 05).
  const plan = await trx.selectFrom('alert_plan').selectAll().executeTakeFirst();
  if (plan?.state === 'approved' || (await hasCurrentOrFutureActivation(trx, todayKyiv(deps.now())))) {
    await finish(trx, job.job_id, 'rejected', { stats, error: 'alert_plan_locked' });
    return;
  }
  await trx.deleteFrom('timetables').where('kind', '=', 'alert').execute();
  const timetableId = await insertVersion(trx, {
    schoolId: job.school_id,
    kind: 'alert',
    snapshotVersion: job.snapshot_version,
    input,
    names: job.names as Names,
    jobId: job.job_id,
    buildMs,
    data,
  });
  await trx
    .insertInto('alert_plan')
    .values({ school_id: job.school_id, timetable_id: timetableId, order_no: null, order_date: null, approved_by: null })
    .onConflict((oc) =>
      oc.column('school_id').doUpdateSet({ timetable_id: timetableId, state: 'draft', order_no: null, order_date: null, approved_by: null, updated_at: new Date() }),
    )
    .execute();
  await finish(trx, job.job_id, 'done', { result: { alert_plan: true, timetable_id: timetableId }, stats });
}

// ───────────── сторож ─────────────

/**
 * Раз на хвилину (роль timetable_maint): queued після queue_deadline_at і running після
 * run_deadline_at → failed. Пізній solve.completed закритої задачі потім відкидається.
 */
export async function runWatchdog(maintDb: Db, now: Date = new Date()): Promise<number> {
  const res = await maintDb
    .updateTable('jobs')
    .set({ state: 'failed', finished_at: now, error: 'deadline_exceeded' })
    .where((eb) =>
      eb.or([
        eb.and([eb('state', '=', 'queued'), eb('queue_deadline_at', '<', now)]),
        eb.and([eb('state', '=', 'running'), eb('run_deadline_at', '<', now)]),
      ]),
    )
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}

export { isTerminal };
