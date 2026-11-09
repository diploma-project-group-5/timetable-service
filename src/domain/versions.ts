// Версії розкладу (розділи 05, 10): список, сітка, навантаження укриття, публікація з
// реквізитами наказу, копія опублікованої (етап 2) і ручна правка уроку (етап 2).
import type { LoadReport, Snapshot } from '@lad/validator-lib';
import { ensureSchoolState, withSchool, type Trx } from '../db/index.js';
import { fail } from '../problem.js';
import { addDays, isSchoolDay, isValidDate, todayKyiv } from '../time.js';
import { recordAudit, type Ctx, type Deps } from './context.js';
import { hasCurrentOrFutureActivation, syncSchoolState } from './jobs.js';
import { project, type Names } from './projection.js';
import { approvedSubstitutionsOn, loadCalendar, phaseOf, type LostSubstitution, type Phase } from './resolve.js';
import { check, conflictsOf, insertVersion, readData, writeData, type TimetableData } from './store.js';

type Row = {
  timetable_id: string;
  kind: 'main' | 'alert';
  state: 'validated' | 'published';
  snapshot_version: number;
  input: unknown;
  names: unknown;
  build_ms: number | null;
  order_no: string | null;
  order_date: string | null;
  approved_by: string | null;
  effective_from: string | null;
  published_at: Date | null;
  created_at: Date;
  copied_from: string | null;
};

export interface TimetableSummary {
  timetable_id: string;
  kind: 'main' | 'alert';
  model: '1.1' | '1.2';
  state: 'validated' | 'published';
  effective_from: string | null;
  published_at: string | null;
  phase?: Phase;
  data_changed_since_build: boolean;
  created_at: string;
  copied_from: string | null;
}

const COLUMNS = [
  'timetable_id',
  'kind',
  'state',
  'snapshot_version',
  'input',
  'names',
  'build_ms',
  'order_no',
  'order_date',
  'approved_by',
  'effective_from',
  'published_at',
  'created_at',
  'copied_from',
] as const;

function summary(r: Row, knownVersion: number, phase: Phase | undefined): TimetableSummary {
  return {
    timetable_id: r.timetable_id,
    kind: r.kind,
    model: r.kind === 'main' ? '1.1' : '1.2',
    state: r.state,
    effective_from: r.effective_from,
    published_at: r.published_at?.toISOString() ?? null,
    ...(phase ? { phase } : {}),
    data_changed_since_build: r.snapshot_version < knownVersion,
    created_at: r.created_at.toISOString(),
    copied_from: r.copied_from,
  };
}

async function knownVersion(trx: Trx): Promise<number> {
  const s = await trx.selectFrom('school_state').select('known_snapshot_version').executeTakeFirst();
  return s?.known_snapshot_version ?? 0;
}

async function getRow(trx: Trx, timetableId: string, lock = false): Promise<Row> {
  let q = trx.selectFrom('timetables').select(COLUMNS).where('timetable_id', '=', timetableId);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) return fail(404, 'not_found', 'Версію не знайдено');
  return row;
}

/** GET /timetables: версії основного розкладу (kind='main') з обчисленою фазою. */
export async function listVersions(deps: Deps, schoolId: string): Promise<TimetableSummary[]> {
  return withSchool(deps.db, schoolId, async (trx) => {
    const rows = await trx.selectFrom('timetables').select(COLUMNS).where('kind', '=', 'main').orderBy('created_at', 'desc').execute();
    const cal = await loadCalendar(trx);
    const known = await knownVersion(trx);
    const today = todayKyiv(deps.now());
    return rows.map((r) => summary(r, known, r.state === 'published' ? phaseOf(cal, r.timetable_id, today) : undefined));
  });
}

async function detailIn(trx: Trx, row: Row, today: string) {
  const [data, known, cal] = await Promise.all([readData(trx, row.timetable_id), knownVersion(trx), loadCalendar(trx)]);
  const names = row.names as Names;
  return {
    ...summary(row, known, row.state === 'published' ? phaseOf(cal, row.timetable_id, today) : undefined),
    snapshot_version: row.snapshot_version,
    classes: names.classes ?? [],
    teachers: names.teachers ?? [],
    subjects: names.subjects ?? [],
    lessons: data.lessons,
    day_formats: data.day_formats.map((f) => ({ class_id: f.class_id, day: f.day, format: f.in_person ? 'in_person' : 'remote' })),
    ...(row.order_no ? { order: { order_no: row.order_no, order_date: row.order_date, approved_by: row.approved_by } } : {}),
  };
}

/** GET /timetables/{id}: сітка уроків і формат кожного дня класу (і для шаблону kind='alert'). */
export async function getVersion(deps: Deps, schoolId: string, timetableId: string) {
  return withSchool(deps.db, schoolId, async (trx) => detailIn(trx, await getRow(trx, timetableId), todayKyiv(deps.now())));
}

/**
 * GET /timetables/{id}/load: навантаження укриття по днях (значення рахує validator-lib на знімку,
 * з якого версію побудовано), причина формату кожного дня класу, підсумок і звіт перевірки.
 */
export async function getLoad(deps: Deps, schoolId: string, timetableId: string) {
  return withSchool(deps.db, schoolId, async (trx) => {
    const row = await getRow(trx, timetableId);
    const outcome = check(row.input as Snapshot, await readData(trx, timetableId));
    if (outcome.status === 'INVALID_INPUT') return fail(500, 'internal', 'Збережену версію не вдалося перевірити');
    return loadView(row.kind, outcome.load, row.build_ms, outcome.status === 'ACCEPTED', outcome.conflicts);
  });
}

export function loadView(kind: 'main' | 'alert', load: LoadReport, buildMs: number | null, ok: boolean, conflicts: readonly unknown[]) {
  const passportPeak = load.summary.peak.find((p) => p.condition === 'passport');
  return {
    model: kind === 'main' ? '1.1' : '1.2',
    days: load.days.map((d) => ({
      day: d.day,
      students_in_person: d.students_in_person,
      teachers_on_site: d.teachers_on_site,
      passport: { load: d.conditions.passport.load, limit: d.conditions.passport.limit, ok: d.conditions.passport.ok },
      ...(d.conditions.seats ? { seats: { load: d.conditions.seats.load, limit: d.conditions.seats.limit, ok: d.conditions.seats.ok } } : {}),
      ok: d.ok,
    })),
    class_days: load.class_days.map((c) => ({
      class_id: c.class_id,
      day: c.day,
      format: c.in_person ? 'in_person' : 'remote',
      lessons: c.lessons,
      reason: c.reason,
    })),
    summary: {
      remote_class_days: load.summary.remote_class_days,
      peak: passportPeak ? { day: passportPeak.day, load: passportPeak.load, limit: passportPeak.limit } : null,
      peaks: load.summary.peak,
      build_ms: buildMs,
      classes_without_in_person_days: load.summary.classes_without_in_person_days,
    },
    validation: { ok, conflicts },
  };
}

export interface PublishInput {
  order_no: string;
  order_date: string;
  approved_by: string;
  effective_from: string;
}

/**
 * POST /timetables/{id}:publish (розділ 05). effective_from — навчальний день не раніше ніж через
 * PUBLISH_MIN_DAYS (Europe/Kyiv). Свіжий знімок: якщо snapshot_version змінилась, версію перевіряє
 * validator-lib на свіжих даних (порушення → 409 stale). Одна запланована версія: нова публікація
 * повертає заплановану у validated. warnings.lost_substitutions[] — завжди.
 */
export async function publishVersion(deps: Deps, ctx: Ctx, timetableId: string, body: PublishInput) {
  for (const [field, value] of [['order_date', body.order_date], ['effective_from', body.effective_from]] as const) {
    if (!isValidDate(value)) fail(422, 'invalid_date', 'Некоректна дата', `${field}: дата у форматі YYYY-MM-DD`);
  }
  const fresh = await deps.fetchSnapshot(ctx.schoolId, ctx.correlationId);
  const now = deps.now();
  const today = todayKyiv(now);
  const earliest = addDays(today, deps.policy.publishMinDays);
  if (body.effective_from < earliest) {
    fail(422, 'effective_from_too_early', 'Зарано', `Розклад може діяти не раніше ${earliest} (через ${deps.policy.publishMinDays} днів)`, {
      earliest,
    });
  }
  if (!isSchoolDay(body.effective_from, fresh.profile.saturday)) {
    fail(422, 'not_school_day', 'Не навчальний день', 'effective_from має бути навчальним днем');
  }

  return withSchool(deps.db, ctx.schoolId, async (trx) => {
    // Блокування рядка закладу: дві публікації одного закладу не перетнуться.
    await ensureSchoolState(trx, ctx.schoolId, true);
    await syncSchoolState(trx, ctx.schoolId, fresh);
    const row = await getRow(trx, timetableId, true);
    if (row.kind !== 'main') fail(404, 'not_found', 'Версію не знайдено', 'Шаблон розкладу тривог не публікується, а погоджується');
    if (row.state === 'published') fail(409, 'already_published', 'Версію вже опубліковано');

    if (fresh.snapshot_version !== row.snapshot_version) {
      const { input } = project(fresh, 'main', deps.policy.priorityAreas);
      const outcome = check(input, await readData(trx, timetableId));
      if (outcome.status !== 'ACCEPTED') {
        fail(409, 'stale', 'Дані закладу змінилися', 'Розклад порушує поточні дані — перебудуйте його', { conflicts: conflictsOf(outcome) });
      }
    }

    const cal = await loadCalendar(trx);
    const scheduled = cal.mains.filter((m) => m.effective_from > today).map((m) => m.timetable_id);
    if (scheduled.length > 0) {
      await trx
        .updateTable('timetables')
        .set({ state: 'validated', order_no: null, order_date: null, approved_by: null, effective_from: null, published_at: null })
        .where('timetable_id', 'in', scheduled)
        .execute();
    }
    await trx
      .updateTable('timetables')
      .set({
        state: 'published',
        order_no: body.order_no.trim(),
        order_date: body.order_date,
        approved_by: body.approved_by.trim(),
        effective_from: body.effective_from,
        published_at: now,
      })
      .where('timetable_id', '=', timetableId)
      .execute();

    // Заміни, пораховані для інших основних версій, з effective_from втрачають силу (крім дат активації тривог).
    const lost = (await approvedSubstitutionsOn(trx, { from: body.effective_from, timetableKind: 'main', exceptTimetableId: timetableId })).filter(
      (s) => !cal.activations.some((a) => a.date_from <= s.date && (a.date_to === null || s.date < a.date_to)),
    );
    await recordAudit(trx, ctx, 'timetable_published', timetableId, {
      order_no: body.order_no.trim(),
      order_date: body.order_date,
      effective_from: body.effective_from,
      replaced_scheduled: scheduled,
    }, now);
    const updated = await getRow(trx, timetableId);
    const known = await knownVersion(trx);
    return {
      timetable: summary(updated, known, phaseOf(await loadCalendar(trx), timetableId, today)),
      warnings: { lost_substitutions: lost satisfies LostSubstitution[] },
    };
  });
}

/** Етап 2 · POST /timetables/{id}:copy: копія версії main у стані validated з тим самим snapshot_version. */
export async function copyVersion(deps: Deps, ctx: Ctx, timetableId: string) {
  return withSchool(deps.db, ctx.schoolId, async (trx) => {
    const row = await getRow(trx, timetableId);
    if (row.kind !== 'main') fail(404, 'not_found', 'Версію не знайдено', 'Копіюється лише основний розклад');
    const id = await insertVersion(trx, {
      schoolId: ctx.schoolId,
      kind: 'main',
      snapshotVersion: row.snapshot_version,
      input: row.input as Snapshot,
      names: row.names as Names,
      jobId: null,
      copiedFrom: timetableId,
      buildMs: row.build_ms,
      data: await readData(trx, timetableId),
    });
    return detailIn(trx, await getRow(trx, id), todayKyiv(deps.now()));
  });
}

export interface Slot {
  class_id: string;
  day: number;
  lesson_no: number;
}

/**
 * Етап 2 · PATCH /timetables/{id}/lessons/{classId}/{day}/{lessonNo}: перенесення уроку в слот
 * {day, lesson_no}; зайнятий слот класу — обмін. Синхронна перевірка validator-lib: конфлікт → 409
 * з conflicts[], зміна не зберігається. Опублікована версія → 409 published_readonly. Шаблон тривог
 * правиться, лише поки немає чинної чи майбутньої активації, і повертається в draft.
 */
export async function moveLesson(deps: Deps, ctx: Ctx, timetableId: string, from: Slot, to: { day: number; lesson_no: number }) {
  return withSchool(deps.db, ctx.schoolId, async (trx) => {
    const row = await getRow(trx, timetableId, true);
    if (row.state === 'published') fail(409, 'published_readonly', 'Опубліковану версію не правлять', 'Створіть копію (:copy) і правте її');
    if (row.kind === 'alert' && (await hasCurrentOrFutureActivation(trx, todayKyiv(deps.now())))) {
      fail(409, 'alert_plan_active', 'Розклад тривог діє за наказом');
    }
    const data = await readData(trx, timetableId);
    const idx = data.lessons.findIndex((l) => l.class_id === from.class_id && l.day === from.day && l.lesson_no === from.lesson_no);
    if (idx < 0) return fail(404, 'not_found', 'Урок не знайдено');
    if (to.day === from.day && to.lesson_no === from.lesson_no) return detailIn(trx, row, todayKyiv(deps.now()));
    const moved: TimetableData = { lessons: data.lessons.map((l) => ({ ...l })), day_formats: data.day_formats };
    const target = moved.lessons.findIndex((l) => l.class_id === from.class_id && l.day === to.day && l.lesson_no === to.lesson_no);
    if (target >= 0) {
      moved.lessons[target] = { ...moved.lessons[target]!, day: from.day, lesson_no: from.lesson_no };
    }
    moved.lessons[idx] = { ...moved.lessons[idx]!, day: to.day, lesson_no: to.lesson_no };
    const outcome = check(row.input as Snapshot, moved);
    if (outcome.status !== 'ACCEPTED') {
      fail(409, 'conflicts', 'Перенесення порушує правила', undefined, { conflicts: conflictsOf(outcome) });
    }
    await writeData(trx, ctx.schoolId, timetableId, moved);
    if (row.kind === 'alert') {
      await trx
        .updateTable('alert_plan')
        .set({ state: 'draft', order_no: null, order_date: null, approved_by: null, updated_at: new Date() })
        .execute();
    }
    return detailIn(trx, row, todayKyiv(deps.now()));
  });
}
