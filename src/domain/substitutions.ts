// Етап 2 · відсутності й заміни (розділи 06, 10). По задачі substitution на кожну дату відсутності;
// payload самодостатній (contracts: solve.substitution.requested.v1, чернетка): знімок, чинний на дату
// шаблон (опублікована main або шаблон alert), погоджені заміни тижня.
//
// Форма результату заміни в solve.completed у contracts ще не спроєктована. timetable приймає
// пропозицію (README, «Результат заміни»):
//   data.substitution = { step: 1..3, proposals: [{ class_id, lesson_no, kind: 'teacher' | 'moved' |
//     'self_study', teacher_id?, off_profile?, moved_to?: { date, lesson_no } }] }
// Урок задачі без пропозиції стає «самостійною роботою».
import { randomUUID } from 'node:crypto';
import { dayLoad, type Snapshot } from '@lad/validator-lib';
import { writeOutbox } from '../db/events.js';
import { ensureSchoolState, withSchool, type Db, type SubstitutionKind, type Trx } from '../db/index.js';
import { fail } from '../problem.js';
import { addDays, datesBetween, isoWeek, isoWeekday, isSchoolDay, isValidDate, todayKyiv, weekStart } from '../time.js';
import { recordAudit, type Ctx, type Deps } from './context.js';
import { readAlertBells, syncSchoolState } from './jobs.js';
import { project, type Names } from './projection.js';
import { loadCalendar, resolveScheduleAt } from './resolve.js';
import { readData, type TimetableData } from './store.js';

export interface SubstitutionInput {
  /** Проєкція знімка, з якою пішла задача. */
  snapshot: Snapshot;
  template: { timetable_id: string; kind: 'main' | 'alert' } & TimetableData;
  absent_teacher_id: string;
  date: string;
  lessons: { class_id: string; lesson_no: number }[];
}

export interface AbsenceInput {
  teacher_id: string;
  date_from: string;
  date_to: string;
  /** null або відсутнє — увесь день. */
  lesson_nos?: number[] | null;
}

const MAX_ABSENCE_DAYS = 31;

/** POST /absences: по задачі substitution на кожну навчальну дату, де вчитель має уроки. Причина не зберігається. */
export async function createAbsence(deps: Deps, ctx: Ctx, body: AbsenceInput): Promise<{ absence_id: string; job_ids: string[] }> {
  for (const d of [body.date_from, body.date_to]) if (!isValidDate(d)) fail(422, 'invalid_date', 'Некоректна дата', 'YYYY-MM-DD');
  const now = deps.now();
  const today = todayKyiv(now);
  if (body.date_from < today) fail(422, 'invalid_date', 'Дата в минулому', 'Відсутність вносять з сьогодні або пізніше');
  if (body.date_to < body.date_from) fail(422, 'invalid_date', 'Некоректний період', 'date_to раніше за date_from');
  if (datesBetween(body.date_from, body.date_to).length > MAX_ABSENCE_DAYS) fail(422, 'invalid_date', 'Задовгий період', `Не більше ${MAX_ABSENCE_DAYS} днів`);
  const lessonNos = body.lesson_nos && body.lesson_nos.length > 0 ? [...new Set(body.lesson_nos)].sort((a, b) => a - b) : null;

  const snapshot = await deps.fetchSnapshot(ctx.schoolId, ctx.correlationId);
  const teacher = snapshot.teachers.find((t) => t.teacher_id === body.teacher_id && t.deleted_at === null);
  if (!teacher) fail(422, 'teacher_not_found', 'Вчителя не знайдено');

  return withSchool(deps.db, ctx.schoolId, async (trx) => {
    await syncSchoolState(trx, ctx.schoolId, snapshot);
    const cal = await loadCalendar(trx);
    const alertBells = await readAlertBells(trx);
    const absenceId = randomUUID();
    const dates = datesBetween(body.date_from, body.date_to).filter((d) => isSchoolDay(d, snapshot.profile.saturday));
    type Planned = { date: string; template: SubstitutionInput['template']; lessons: SubstitutionInput['lessons'] };
    const planned: Planned[] = [];
    const templates = new Map<string, SubstitutionInput['template']>();
    for (const date of dates) {
      const r = resolveScheduleAt(cal, date);
      if (r.kind !== 'main' && r.kind !== 'alert') continue;
      let template = templates.get(r.timetable_id);
      if (!template) {
        template = { timetable_id: r.timetable_id, kind: r.kind, ...(await readData(trx, r.timetable_id)) };
        templates.set(r.timetable_id, template);
      }
      const lessons = template.lessons
        .filter((l) => l.teacher_id === body.teacher_id && l.day === isoWeekday(date) && (lessonNos === null || lessonNos.includes(l.lesson_no)))
        .map((l) => ({ class_id: l.class_id, lesson_no: l.lesson_no }));
      if (lessons.length > 0) planned.push({ date, template, lessons });
    }
    if (planned.length === 0) fail(422, 'no_lessons', 'Немає уроків для заміни', 'У цей період вчитель не має уроків в опублікованому розкладі');

    await trx
      .insertInto('absences')
      .values({ school_id: ctx.schoolId, absence_id: absenceId, teacher_id: body.teacher_id, date_from: body.date_from, date_to: body.date_to, lesson_nos: lessonNos })
      .execute();
    const absenceDates = planned.map((p) => p.date);
    const jobIds: string[] = [];
    for (const p of planned) {
      const jobId = randomUUID();
      const { input, names } = project(snapshot, p.template.kind, deps.policy.priorityAreas, alertBells);
      const week = weekStart(p.date);
      const approved = await trx
        .selectFrom('substitutions')
        .select(['date', 'class_id', 'lesson_no', 'new_teacher_id', 'subject_id'])
        .where('state', '=', 'approved')
        .where('kind', '=', 'teacher')
        .where('date', '>=', week)
        .where('date', '<=', addDays(week, 6))
        .execute();
      const queueDeadline = new Date(now.getTime() + deps.policy.queueAllowanceS * 1000);
      const jobInput: SubstitutionInput = { snapshot: input, template: p.template, absent_teacher_id: body.teacher_id, date: p.date, lessons: p.lessons };
      await trx
        .insertInto('jobs')
        .values({
          school_id: ctx.schoolId,
          job_id: jobId,
          kind: 'substitution',
          state: 'queued',
          snapshot_version: snapshot.snapshot_version,
          time_limit_s: deps.policy.substitutionTimeLimitS,
          created_at: now,
          queue_deadline_at: queueDeadline,
          started_at: null,
          run_deadline_at: null,
          finished_at: null,
          input: JSON.stringify(jobInput),
          names: JSON.stringify(names),
          conflicts: null,
          result: null,
          stats: null,
          error: null,
          absence_id: absenceId,
          date: p.date,
        })
        .execute();
      await writeOutbox(trx, {
        topic: 'solve.substitution.requested',
        schoolId: ctx.schoolId,
        correlationId: ctx.correlationId,
        data: {
          job_id: jobId,
          date: p.date,
          absence_dates: absenceDates,
          absent_teacher_id: body.teacher_id,
          lessons: p.lessons,
          not_before: today,
          iso_week: isoWeek(p.date),
          snapshot_version: snapshot.snapshot_version,
          time_limit_s: deps.policy.substitutionTimeLimitS,
          queue_deadline_at: queueDeadline.toISOString(),
          school_days: input.school_days,
          lessons_per_day: input.lessons_per_day,
          staff: input.staff,
          capacity: input.capacity,
          classes: input.classes,
          subjects: input.subjects,
          teachers: input.teachers,
          rows: input.rows,
          template: { timetable_id: p.template.timetable_id, kind: p.template.kind, lessons: p.template.lessons, day_formats: p.template.day_formats },
          approved_substitutions: approved.map((s) => ({ date: s.date, class_id: s.class_id, lesson_no: s.lesson_no, teacher_id: s.new_teacher_id!, subject_id: s.subject_id })),
        },
      });
      jobIds.push(jobId);
    }
    await recordAudit(trx, ctx, 'absence_recorded', body.teacher_id, { absence_id: absenceId, date_from: body.date_from, date_to: body.date_to, jobs: jobIds.length }, now);
    return { absence_id: absenceId, job_ids: jobIds };
  });
}

/** GET /absences: поточні й майбутні відсутності та стан їхніх задач. */
export async function listAbsences(deps: Deps, schoolId: string) {
  const today = todayKyiv(deps.now());
  return withSchool(deps.db, schoolId, async (trx) => {
    const absences = await trx
      .selectFrom('absences')
      .select(['absence_id', 'teacher_id', 'date_from', 'date_to', 'lesson_nos', 'created_at'])
      .where('date_to', '>=', today)
      .where('cancelled_at', 'is', null)
      .orderBy('date_from')
      .execute();
    const ids = absences.map((a) => a.absence_id);
    const jobs = ids.length
      ? await trx.selectFrom('jobs').select(['job_id', 'absence_id', 'date', 'state']).where('absence_id', 'in', ids).orderBy('date').execute()
      : [];
    return absences.map((a) => ({
      absence_id: a.absence_id,
      teacher_id: a.teacher_id,
      date_from: a.date_from,
      date_to: a.date_to,
      lesson_nos: a.lesson_nos,
      created_at: a.created_at.toISOString(),
      jobs: jobs.filter((j) => j.absence_id === a.absence_id).map((j) => ({ job_id: j.job_id, date: j.date, state: j.state })),
    }));
  });
}

/** DELETE /absences/{id}: пропозиції стають rejected, погоджені накладки знімаються. */
export async function cancelAbsence(deps: Deps, ctx: Ctx, absenceId: string): Promise<void> {
  await withSchool(deps.db, ctx.schoolId, async (trx) => {
    const a = await trx.selectFrom('absences').select(['teacher_id', 'cancelled_at']).where('absence_id', '=', absenceId).executeTakeFirst();
    if (!a) return fail(404, 'not_found', 'Відсутність не знайдено');
    if (a.cancelled_at) return;
    await trx.updateTable('absences').set({ cancelled_at: new Date() }).where('absence_id', '=', absenceId).execute();
    const jobIds = (await trx.selectFrom('jobs').select('job_id').where('absence_id', '=', absenceId).execute()).map((j) => j.job_id);
    if (jobIds.length > 0) {
      await trx
        .updateTable('substitutions')
        .set({ state: 'rejected', decided_at: new Date() })
        .where('job_id', 'in', jobIds)
        .where('state', 'in', ['proposed', 'approved'])
        .execute();
    }
    await recordAudit(trx, ctx, 'absence_cancelled', a.teacher_id, { absence_id: absenceId }, deps.now());
  });
}

const PROPOSAL_KINDS: readonly SubstitutionKind[] = ['teacher', 'moved', 'self_study'];

/** Зберігає пропозиції solver (solve.completed задачі substitution). Повертає їх для job.result. */
export async function storeProposals(
  trx: Trx,
  job: { school_id: string; job_id: string; input: unknown; absence_id: string | null },
  data: Record<string, unknown>,
) {
  const input = job.input as SubstitutionInput;
  const sub = (data.substitution ?? data) as { step?: unknown; proposals?: unknown };
  const step = typeof sub.step === 'number' ? sub.step : null;
  const raw = Array.isArray(sub.proposals) ? (sub.proposals as Record<string, unknown>[]) : [];
  const cancelled = job.absence_id
    ? (await trx.selectFrom('absences').select('cancelled_at').where('absence_id', '=', job.absence_id).executeTakeFirst())?.cancelled_at
    : null;

  const rows = input.lessons.map((l) => {
    const original = input.template.lessons.find((t) => t.class_id === l.class_id && t.day === isoWeekday(input.date) && t.lesson_no === l.lesson_no);
    const p = raw.find((x) => x.class_id === l.class_id && x.lesson_no === l.lesson_no);
    const kind = (p && PROPOSAL_KINDS.includes(p.kind as SubstitutionKind) ? p.kind : 'self_study') as SubstitutionKind;
    const moved = kind === 'moved' ? (p?.moved_to as { date?: string; lesson_no?: number } | undefined) : undefined;
    const valid =
      (kind !== 'teacher' || typeof p?.teacher_id === 'string') && (kind !== 'moved' || (typeof moved?.date === 'string' && typeof moved?.lesson_no === 'number'));
    const k: SubstitutionKind = valid ? kind : 'self_study';
    return {
      school_id: job.school_id,
      job_id: job.job_id,
      date: input.date,
      class_id: l.class_id,
      lesson_no: l.lesson_no,
      timetable_id: input.template.timetable_id,
      subject_id: original?.subject_id ?? input.template.lessons[0]!.subject_id,
      original_teacher_id: input.absent_teacher_id,
      kind: k,
      new_teacher_id: k === 'teacher' ? String(p!.teacher_id) : null,
      off_profile: k === 'teacher' ? Boolean(p!.off_profile) : false,
      moved_to_date: k === 'moved' ? moved!.date! : null,
      moved_to_lesson_no: k === 'moved' ? moved!.lesson_no! : null,
      step,
      state: cancelled ? ('rejected' as const) : ('proposed' as const),
    };
  });
  if (rows.length > 0) await trx.insertInto('substitutions').values(rows).onConflict((oc) => oc.doNothing()).execute();
  return rows.map(subView);
}

const subView = (r: {
  job_id: string;
  date: string;
  class_id: string;
  lesson_no: number;
  timetable_id: string;
  subject_id: string;
  original_teacher_id: string;
  kind: SubstitutionKind;
  new_teacher_id: string | null;
  off_profile: boolean;
  moved_to_date: string | null;
  moved_to_lesson_no: number | null;
  step: number | null;
  state: string;
}) => ({
  job_id: r.job_id,
  date: r.date,
  class_id: r.class_id,
  lesson_no: r.lesson_no,
  timetable_id: r.timetable_id,
  subject_id: r.subject_id,
  original_teacher_id: r.original_teacher_id,
  kind: r.kind,
  new_teacher_id: r.new_teacher_id,
  off_profile: r.off_profile,
  moved_to: r.moved_to_date ? { date: r.moved_to_date, lesson_no: r.moved_to_lesson_no } : null,
  step: r.step,
  state: r.state,
});

/** GET /substitutions?date=: запропоновані, погоджені й відхилені накладки на дату. */
export async function listSubstitutions(db: Db, schoolId: string, date: string) {
  if (!isValidDate(date)) fail(422, 'invalid_date', 'Некоректна дата', 'YYYY-MM-DD');
  return withSchool(db, schoolId, async (trx) => {
    const rows = await trx.selectFrom('substitutions').selectAll().where('date', '=', date).orderBy('class_id').orderBy('lesson_no').execute();
    return rows.map(subView);
  });
}

/**
 * POST /substitutions/{job_id}:approve. SELECT … FOR UPDATE рядка закладу; на дату має діяти та сама
 * версія, для якої пораховано заміну (інакше 409 stale); перевірка накладок на свіжих даних
 * (вільний слот, недоступні дні, формат дня, тижневий ліміт, місткість); друга погоджена накладка
 * на слот не пройде частковий унікальний індекс. У тілі можна замінити «самостійну роботу» на «скасовано».
 */
export async function approveSubstitution(deps: Deps, ctx: Ctx, jobId: string, cancel: { class_id: string; lesson_no: number }[]) {
  const snapshot = await deps.fetchSnapshot(ctx.schoolId, ctx.correlationId);
  try {
    return await withSchool(deps.db, ctx.schoolId, async (trx) => {
      await ensureSchoolState(trx, ctx.schoolId, true);
      await syncSchoolState(trx, ctx.schoolId, snapshot);
      const job = await trx.selectFrom('jobs').select(['kind', 'state', 'date', 'input']).where('job_id', '=', jobId).executeTakeFirst();
      if (!job || job.kind !== 'substitution') return fail(404, 'not_found', 'Задачу заміни не знайдено');
      const proposals = await trx.selectFrom('substitutions').selectAll().where('job_id', '=', jobId).where('state', '=', 'proposed').execute();
      if (job.state !== 'done' || proposals.length === 0) fail(409, 'job_not_ready', 'Немає пропозицій для погодження');
      const date = job.date!;
      const cal = await loadCalendar(trx);
      const r = resolveScheduleAt(cal, date);
      if ((r.kind !== 'main' && r.kind !== 'alert') || r.timetable_id !== proposals[0]!.timetable_id) {
        fail(409, 'stale', 'На дату діє інший розклад', 'Внесіть відсутність знову');
      }
      for (const p of proposals) {
        if (p.kind === 'self_study' && cancel.some((c) => c.class_id === p.class_id && c.lesson_no === p.lesson_no)) p.kind = 'cancelled';
      }
      const conflicts = await checkOverlays(trx, deps, snapshot, date, r.kind === 'alert' ? 'alert' : 'main', proposals);
      if (conflicts.length > 0) fail(409, 'conflicts', 'Заміна порушує правила', undefined, { conflicts });
      for (const p of proposals) {
        await trx
          .updateTable('substitutions')
          .set({ state: 'approved', kind: p.kind, decided_at: new Date() })
          .where('job_id', '=', jobId)
          .where('class_id', '=', p.class_id)
          .where('lesson_no', '=', p.lesson_no)
          .execute();
      }
      await recordAudit(trx, ctx, 'substitution_approved', p0Teacher(proposals), { job_id: jobId, date, lessons: proposals.length }, deps.now());
      const rows = await trx.selectFrom('substitutions').selectAll().where('job_id', '=', jobId).execute();
      return rows.map(subView);
    });
  } catch (err) {
    if ((err as { code?: string; constraint?: string }).constraint === 'substitutions_one_approved') {
      fail(409, 'slot_taken', 'Слот уже має погоджену заміну');
    }
    throw err;
  }
}

const p0Teacher = (proposals: { original_teacher_id: string }[]) => proposals[0]?.original_teacher_id ?? null;

/** POST /substitutions/{job_id}:reject: пропозиції → rejected (зберігаються для RQ4). */
export async function rejectSubstitution(deps: Deps, ctx: Ctx, jobId: string) {
  return withSchool(deps.db, ctx.schoolId, async (trx) => {
    const job = await trx.selectFrom('jobs').select(['kind']).where('job_id', '=', jobId).executeTakeFirst();
    if (!job || job.kind !== 'substitution') return fail(404, 'not_found', 'Задачу заміни не знайдено');
    await trx.updateTable('substitutions').set({ state: 'rejected', decided_at: new Date() }).where('job_id', '=', jobId).where('state', '=', 'proposed').execute();
    await recordAudit(trx, ctx, 'substitution_rejected', null, { job_id: jobId }, deps.now());
    const rows = await trx.selectFrom('substitutions').selectAll().where('job_id', '=', jobId).execute();
    return rows.map(subView);
  });
}

type Proposal = {
  class_id: string;
  lesson_no: number;
  kind: SubstitutionKind;
  new_teacher_id: string | null;
  moved_to_date: string | null;
  moved_to_lesson_no: number | null;
  original_teacher_id: string;
  timetable_id: string;
};

/** Перевірка накладок заміни на свіжих даних. Повертає конфлікти у формі contracts/conflict.v1. */
async function checkOverlays(trx: Trx, deps: Deps, snapshot: Parameters<typeof project>[0], date: string, kind: 'main' | 'alert', proposals: Proposal[]) {
  const alertBells = kind === 'alert' ? await readAlertBells(trx) : [];
  const { input } = project(snapshot, kind, deps.policy.priorityAreas, alertBells);
  const template = await readData(trx, proposals[0]!.timetable_id);
  const weekday = isoWeekday(date);
  const week = weekStart(date);
  const approved = await trx
    .selectFrom('substitutions')
    .select(['date', 'class_id', 'lesson_no', 'kind', 'new_teacher_id', 'original_teacher_id', 'moved_to_date', 'moved_to_lesson_no'])
    .where('state', '=', 'approved')
    .where('date', '>=', week)
    .where('date', '<=', addDays(week, 6))
    .execute();
  const conflicts: Record<string, unknown>[] = [];
  const format = (classId: string, day: number) => template.day_formats.find((f) => f.class_id === classId && f.day === day)?.in_person ?? false;

  /** Уроки вчителя на дату з урахуванням погоджених і нових накладок. */
  const teacherSlots = (teacherId: string, d: string, extra: Proposal[]) => {
    const wd = isoWeekday(d);
    const replacedAway = (classId: string, no: number) =>
      approved.some((a) => a.date === d && a.class_id === classId && a.lesson_no === no) ||
      extra.some((p) => d === date && p.class_id === classId && p.lesson_no === no);
    const own = template.lessons.filter((l) => l.teacher_id === teacherId && l.day === wd && !replacedAway(l.class_id, l.lesson_no));
    const added = [
      ...approved.filter((a) => a.date === d && a.kind === 'teacher' && a.new_teacher_id === teacherId).map((a) => ({ class_id: a.class_id, lesson_no: a.lesson_no })),
      ...approved.filter((a) => a.kind === 'moved' && a.moved_to_date === d && a.original_teacher_id === teacherId).map((a) => ({ class_id: a.class_id, lesson_no: a.moved_to_lesson_no! })),
    ];
    return [...own.map((l) => ({ class_id: l.class_id, lesson_no: l.lesson_no })), ...added];
  };

  for (const p of proposals) {
    if (p.kind === 'teacher') {
      const t = input.teachers.find((x) => x.id === p.new_teacher_id);
      if (!t) {
        conflicts.push({ rule: 'teacher_not_active', teacher_id: p.new_teacher_id });
        continue;
      }
      const others = proposals.filter((x) => x !== p && x.kind === 'teacher' && x.new_teacher_id === t.id);
      const slots = [...teacherSlots(t.id, date, proposals), ...others.map((o) => ({ class_id: o.class_id, lesson_no: o.lesson_no }))];
      if (slots.some((s) => s.lesson_no === p.lesson_no)) conflicts.push({ rule: 'teacher_double_booked', teacher_id: t.id, day: weekday, lesson_no: p.lesson_no });
      if (t.unavailable_days.includes(weekday)) conflicts.push({ rule: 'teacher_unavailable_day', teacher_id: t.id, day: weekday });
      const fmt = format(p.class_id, weekday);
      if (slots.some((s) => format(s.class_id, weekday) !== fmt)) conflicts.push({ rule: 'teacher_mixed_format', teacher_id: t.id, day: weekday });
      const weekly =
        template.lessons.filter((l) => l.teacher_id === t.id).length +
        approved.filter((a) => a.kind === 'teacher' && a.new_teacher_id === t.id).length +
        proposals.filter((x) => x.kind === 'teacher' && x.new_teacher_id === t.id).length;
      if (weekly > t.weekly_limit) conflicts.push({ rule: 'teacher_weekly_limit', teacher_id: t.id, value: weekly, limit: t.weekly_limit });
    }
    if (p.kind === 'moved') {
      const d = p.moved_to_date!;
      const no = p.moved_to_lesson_no!;
      const classBusy = template.lessons.some((l) => l.class_id === p.class_id && l.day === isoWeekday(d) && l.lesson_no === no);
      if (classBusy) conflicts.push({ rule: 'class_double_booked', class_id: p.class_id, day: isoWeekday(d), lesson_no: no });
      if (teacherSlots(p.original_teacher_id, d, []).some((s) => s.lesson_no === no)) {
        conflicts.push({ rule: 'teacher_double_booked', teacher_id: p.original_teacher_id, day: isoWeekday(d), lesson_no: no });
      }
    }
  }

  // Місткість дня: новий очний вчитель додає 1 (розділ 06, крок 1).
  const dayLessons = template.lessons
    .filter((l) => l.day === weekday)
    .map((l) => {
      const p = proposals.find((x) => x.class_id === l.class_id && x.lesson_no === l.lesson_no);
      const a = approved.find((x) => x.date === date && x.class_id === l.class_id && x.lesson_no === l.lesson_no);
      const teacher = p?.kind === 'teacher' ? p.new_teacher_id : a?.kind === 'teacher' ? a.new_teacher_id : p || a ? null : l.teacher_id;
      return teacher ? { class_id: l.class_id, teacher_id: teacher } : null;
    })
    .filter((x): x is { class_id: string; teacher_id: string } => x !== null);
  const classes = input.classes.map((c) => ({ id: c.id, students: c.students, in_person: format(c.id, weekday) }));
  const load =
    kind === 'alert'
      ? dayLoad({ model: '1.2', staff: input.staff, capacity: input.capacity as { seats: number; passport: number }, day: { classes, lessons: dayLessons } })
      : dayLoad({ model: '1.1', staff: input.staff, capacity: { passport: input.capacity.passport }, day: { classes, lessons: dayLessons } });
  if (!load.conditions.passport.ok) {
    conflicts.push({ rule: 'capacity_exceeded', day: weekday, condition: 'passport', value: load.conditions.passport.load, limit: load.conditions.passport.limit });
  }
  if (load.conditions.seats && !load.conditions.seats.ok) {
    conflicts.push({ rule: 'capacity_exceeded', day: weekday, condition: 'seats', value: load.conditions.seats.load, limit: load.conditions.seats.limit });
  }
  return conflicts;
}

export type { Names };
