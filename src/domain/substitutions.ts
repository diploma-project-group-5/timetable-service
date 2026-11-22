// Етап 2 · відсутності й заміни (розділи 06, 10; contracts 0.5.0, ADR 2026-11-15-solver-substitution-engine).
// По задачі substitution на кожну дату відсутності. Payload самодостатній (solve.substitution.requested.v1):
// знімок, чинний на дату шаблон (опублікована main або шаблон alert), усі погоджені накладки тижня будь-якого
// виду, відсутності всіх вчителів тижня й неробочі дати тижня (з ними solver вмикає крок 3).
//
// solver лише пропонує: результат (data.substitution) перевіряється на інваріант contracts — кожен урок
// задачі рівно раз, з датою задачі, перенос лише в межах вікна, без рядків поза уроками задачі. Інакше
// задача failed (invalid_result). Вердикт дає validator-lib: newConflicts(тиждень без пропозицій, тиждень
// з ними) на знімку задачі — нових конфліктів немає → done, є → rejected. :approve повторює ту саму
// перевірку на свіжому знімку й поточних накладках.
import { randomUUID } from 'node:crypto';
import { newConflicts, type Absence, type Snapshot } from '@lad/validator-lib';
import { writeOutbox } from '../db/events.js';
import { ensureSchoolState, withSchool, type Db, type SubstitutionKind, type Trx } from '../db/index.js';
import { fail } from '../problem.js';
import { addDays, datesBetween, isoWeek, isoWeekday, isValidDate, todayKyiv, weekStart } from '../time.js';
import { recordAudit, type Ctx, type Deps } from './context.js';
import { readAlertBells, syncSchoolState } from './jobs.js';
import { missingProfileFields, project, type Names } from './projection.js';
import { loadCalendar, resolveScheduleAt, type Calendar } from './resolve.js';
import { readData, type TimetableData } from './store.js';
import { effectiveWeek, type WeekGiven, type WeekOverlay } from './week.js';

export interface SubstitutionInput {
  /** Проєкція знімка, з якою пішла задача. */
  snapshot: Snapshot;
  template: { timetable_id: string; kind: 'main' | 'alert' } & TimetableData;
  absent_teacher_id: string;
  date: string;
  lessons: { class_id: string; lesson_no: number }[];
  not_before: string;
  /** Дати, куди можна перенести урок кроком 3: навчальні дні тижня, не раніше not_before, не свята. */
  window: string[];
  /** Тиждень на момент запиту (дні тижня): свята, відсутності й погоджені накладки. */
  holidays: number[];
  absences: Absence[];
  overlays: WeekOverlay[];
}

export interface AbsenceInput {
  teacher_id: string;
  date_from: string;
  date_to: string;
  /** null або відсутнє — увесь день. */
  lesson_nos?: number[] | null;
}

const MAX_ABSENCE_DAYS = 31;

type AbsenceRow = { teacher_id: string; date: string; lesson_nos: number[] | null };

interface WeekState {
  dates: string[];
  /** Свята тижня, що припадають на навчальні дні (non_school_dates у payload). */
  holidayDates: string[];
  /** Відсутності тижня, по рядку на вчителя й дату (null — увесь день). */
  absences: AbsenceRow[];
  /** Погоджені накладки тижня, пораховані для цього шаблону, у порядку погодження. */
  approved: {
    date: string;
    class_id: string;
    lesson_no: number;
    kind: SubstitutionKind;
    new_teacher_id: string | null;
    subject_id: string;
    moved_to_date: string | null;
    moved_to_lesson_no: number | null;
  }[];
}

/** Стан ISO-тижня дати: свята, відсутності (без скасованих) і погоджені накладки шаблону timetableId. */
async function loadWeek(trx: Trx, cal: Calendar, input: Snapshot, timetableId: string, date: string): Promise<WeekState> {
  const from = weekStart(date);
  const to = addDays(from, 6);
  const dates = datesBetween(from, to);
  const schoolDay = (d: string) => input.school_days.includes(isoWeekday(d));
  const holiday = (d: string) => cal.holidayFrom !== null && cal.holidayTo !== null && cal.holidayFrom <= d && d <= cal.holidayTo;
  const holidayDates = dates.filter((d) => schoolDay(d) && holiday(d));
  const teachers = new Set(input.teachers.map((t) => t.id));

  const rows = await trx
    .selectFrom('absences')
    .select(['teacher_id', 'date_from', 'date_to', 'lesson_nos'])
    .where('cancelled_at', 'is', null)
    .where('date_from', '<=', to)
    .where('date_to', '>=', from)
    .execute();
  const merged = new Map<string, AbsenceRow>();
  for (const r of rows) {
    if (!teachers.has(r.teacher_id)) continue;
    for (const d of datesBetween(r.date_from < from ? from : r.date_from, r.date_to > to ? to : r.date_to)) {
      if (!schoolDay(d) || holiday(d)) continue;
      const key = `${r.teacher_id}/${d}`;
      const prev = merged.get(key);
      const nos = r.lesson_nos && r.lesson_nos.length > 0 ? r.lesson_nos : null;
      if (!prev) merged.set(key, { teacher_id: r.teacher_id, date: d, lesson_nos: nos ? [...nos].sort((a, b) => a - b) : null });
      else if (prev.lesson_nos !== null) prev.lesson_nos = nos === null ? null : [...new Set([...prev.lesson_nos, ...nos])].sort((a, b) => a - b);
    }
  }
  const absences = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date) || a.teacher_id.localeCompare(b.teacher_id));

  const approved = await trx
    .selectFrom('substitutions')
    .select(['date', 'class_id', 'lesson_no', 'kind', 'new_teacher_id', 'subject_id', 'moved_to_date', 'moved_to_lesson_no'])
    .where('state', '=', 'approved')
    .where('timetable_id', '=', timetableId)
    .where('date', '>=', from)
    .where('date', '<=', to)
    .orderBy('decided_at')
    .orderBy('date')
    .orderBy('class_id')
    .orderBy('lesson_no')
    .execute();
  return { dates, holidayDates, absences, approved };
}

/** Накладка в днях тижня (вхід effectiveWeek). */
const toOverlay = (o: WeekState['approved'][number]): WeekOverlay => ({
  day: isoWeekday(o.date),
  class_id: o.class_id,
  lesson_no: o.lesson_no,
  kind: o.kind,
  ...(o.kind === 'teacher' ? { new_teacher_id: o.new_teacher_id } : {}),
  ...(o.kind === 'moved' ? { moved_to: { day: isoWeekday(o.moved_to_date!), lesson_no: o.moved_to_lesson_no! } } : {}),
});

/** Відсутності для validator-lib: дні тижня, «увесь день» — усі номери уроків. */
const toAbsences = (rows: AbsenceRow[], lessonsPerDay: number): Absence[] =>
  rows.map((a) => ({
    teacher_id: a.teacher_id,
    day: isoWeekday(a.date),
    lesson_nos: a.lesson_nos ?? Array.from({ length: lessonsPerDay }, (_, i) => i + 1),
  }));

/**
 * POST /absences: по задачі substitution на кожну навчальну дату, де вчитель має уроки в тижні з
 * накладками. Причина не зберігається. Уроки, які вже має погоджена накладка, у задачу не йдуть;
 * якщо у відсутні години вчитель сам погоджений замісником — 409 teacher_is_substitute.
 */
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
    // Відсутність записується першою: тиждень кожної дати вже бачить її (транзакція відкотиться на 4xx).
    await trx
      .insertInto('absences')
      .values({ school_id: ctx.schoolId, absence_id: absenceId, teacher_id: body.teacher_id, date_from: body.date_from, date_to: body.date_to, lesson_nos: lessonNos })
      .execute();

    type Planned = { date: string; template: SubstitutionInput['template']; projection: ReturnType<typeof project>; week: WeekState; lessons: SubstitutionInput['lessons'] };
    const planned: Planned[] = [];
    const templates = new Map<string, SubstitutionInput['template']>();
    const projections = new Map<string, ReturnType<typeof project>>();
    for (const date of datesBetween(body.date_from, body.date_to)) {
      const r = resolveScheduleAt(cal, date);
      if (r.kind !== 'main' && r.kind !== 'alert') continue;
      let projection = projections.get(r.kind);
      if (!projection) {
        const missing = missingProfileFields(snapshot, r.kind, alertBells);
        if (missing.length > 0) fail(422, 'profile_incomplete', 'Профіль закладу неповний', `Заповніть: ${missing.join(', ')}`, { missing });
        projection = project(snapshot, r.kind, deps.policy.priorityAreas, alertBells);
        projections.set(r.kind, projection);
      }
      const input = projection.input;
      if (!input.school_days.includes(isoWeekday(date))) continue;
      let template = templates.get(r.timetable_id);
      if (!template) {
        template = { timetable_id: r.timetable_id, kind: r.kind, ...(await readData(trx, r.timetable_id)) };
        templates.set(r.timetable_id, template);
      }
      const week = await loadWeek(trx, cal, input, r.timetable_id, date);
      const own = week.absences.find((a) => a.teacher_id === body.teacher_id && a.date === date);
      if (!own) continue;
      const eff = effectiveWeek(weekGiven(input, template, week)).input;
      const mine = eff.timetable.lessons.filter(
        (l) => l.day === isoWeekday(date) && l.teacher_id === body.teacher_id && (own.lesson_nos === null || own.lesson_nos.includes(l.lesson_no)),
      );
      const covering = mine.filter((l) => l.origin === 'substitution');
      if (covering.length > 0) {
        fail(409, 'teacher_is_substitute', 'Вчитель погоджений замісником', `${date}: уроки ${covering.map((l) => l.lesson_no).join(', ')} — спершу скасуйте ці заміни`, {
          lessons: covering.map((l) => ({ date, class_id: l.class_id, lesson_no: l.lesson_no })),
        });
      }
      const lessons = mine.map((l) => ({ class_id: l.class_id, lesson_no: l.lesson_no })).sort((a, b) => a.lesson_no - b.lesson_no || a.class_id.localeCompare(b.class_id));
      if (lessons.length > 0) planned.push({ date, template, projection, week, lessons });
    }
    if (planned.length === 0) fail(422, 'no_lessons', 'Немає уроків для заміни', 'У цей період вчитель не має уроків, які ще не закрито заміною');

    const absenceDates = planned.map((p) => p.date);
    const jobIds: string[] = [];
    for (const p of planned) {
      const jobId = randomUUID();
      const { input, names } = p.projection;
      const window = p.week.dates.filter((d) => d >= today && input.school_days.includes(isoWeekday(d)) && !p.week.holidayDates.includes(d));
      const queueDeadline = new Date(now.getTime() + deps.policy.queueAllowanceS * 1000);
      const given = weekGiven(input, p.template, p.week);
      const jobInput: SubstitutionInput = {
        snapshot: input,
        template: p.template,
        absent_teacher_id: body.teacher_id,
        date: p.date,
        lessons: p.lessons,
        not_before: today,
        window,
        holidays: [...(given.holidays ?? [])],
        absences: [...(given.absences ?? [])],
        overlays: [...(given.overlays ?? [])],
      };
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
          approved_substitutions: p.week.approved.map((s) => ({
            date: s.date,
            class_id: s.class_id,
            lesson_no: s.lesson_no,
            kind: s.kind,
            ...(s.kind === 'teacher' ? { teacher_id: s.new_teacher_id! } : {}),
            ...(s.kind === 'moved' ? { moved_to: { date: s.moved_to_date!, lesson_no: s.moved_to_lesson_no! } } : {}),
            subject_id: s.subject_id,
          })),
          absences: p.week.absences,
          non_school_dates: p.week.holidayDates,
          allow_support_moves: false,
        },
      });
      jobIds.push(jobId);
    }
    await recordAudit(trx, ctx, 'absence_recorded', body.teacher_id, { absence_id: absenceId, date_from: body.date_from, date_to: body.date_to, jobs: jobIds.length }, now);
    return { absence_id: absenceId, job_ids: jobIds };
  });
}

function weekGiven(input: Snapshot, template: TimetableData, week: WeekState): WeekGiven {
  const holidays = week.holidayDates.map(isoWeekday);
  return {
    snapshot: input,
    template,
    holidays,
    absences: toAbsences(week.absences, input.lessons_per_day),
    // Накладки на святах нічого не змінюють (уроків того дня немає).
    overlays: week.approved.filter((o) => !week.holidayDates.includes(o.date)).map(toOverlay),
  };
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

type Proposal = {
  class_id: string;
  lesson_no: number;
  kind: 'teacher' | 'moved' | 'self_study';
  teacher_id: string | null;
  off_profile: boolean;
  moved_to: { date: string; lesson_no: number } | null;
  step: number | null;
};

/**
 * Пропозиції solve.completed за інваріантом contracts 0.5.0 або null, якщо результат зламаний:
 * кожен урок задачі рівно раз, з датою задачі; moved — у межах вікна (крок 2 — та сама дата);
 * рядків поза уроками задачі немає (allow_support_moves=false).
 */
export function parseProposals(input: SubstitutionInput, data: Record<string, unknown>): Proposal[] | null {
  const sub = data.substitution as { proposals?: unknown } | undefined;
  if (!sub || typeof sub !== 'object' || !Array.isArray(sub.proposals)) return null;
  const raw = sub.proposals as Record<string, unknown>[];
  if (raw.length !== input.lessons.length) return null;
  const window = input.window ?? [];
  const maxNo = input.snapshot.lessons_per_day;
  const out: Proposal[] = [];
  for (const l of input.lessons) {
    const found = raw.filter((p) => p && p.class_id === l.class_id && p.lesson_no === l.lesson_no);
    if (found.length !== 1) return null;
    const p = found[0]!;
    if (p.date !== input.date) return null;
    const step = typeof p.step === 'number' && Number.isInteger(p.step) ? p.step : null;
    if (p.kind === 'teacher') {
      if (typeof p.teacher_id !== 'string' || p.teacher_id.length === 0) return null;
      out.push({ ...l, kind: 'teacher', teacher_id: p.teacher_id, off_profile: p.off_profile === true, moved_to: null, step });
    } else if (p.kind === 'moved') {
      const m = p.moved_to as { date?: unknown; lesson_no?: unknown } | undefined;
      if (!m || typeof m.date !== 'string' || typeof m.lesson_no !== 'number' || !Number.isInteger(m.lesson_no)) return null;
      if (m.lesson_no < 1 || m.lesson_no > maxNo) return null;
      if (m.date !== input.date && !window.includes(m.date)) return null;
      if (m.date === input.date && m.lesson_no === l.lesson_no) return null;
      out.push({ ...l, kind: 'moved', teacher_id: null, off_profile: false, moved_to: { date: m.date, lesson_no: m.lesson_no }, step });
    } else if (p.kind === 'self_study') {
      out.push({ ...l, kind: 'self_study', teacher_id: null, off_profile: false, moved_to: null, step });
    } else return null;
  }
  return out;
}

const proposalOverlay = (date: string, p: { class_id: string; lesson_no: number; kind: SubstitutionKind; new_teacher_id: string | null; moved_to: { date: string; lesson_no: number } | null }): WeekOverlay => ({
  day: isoWeekday(date),
  class_id: p.class_id,
  lesson_no: p.lesson_no,
  kind: p.kind,
  ...(p.kind === 'teacher' ? { new_teacher_id: p.new_teacher_id } : {}),
  ...(p.kind === 'moved' ? { moved_to: { day: isoWeekday(p.moved_to!.date), lesson_no: p.moved_to!.lesson_no } } : {}),
});

type Verdict =
  | { status: 'invalid'; week: 'baseline' | 'effective'; issues: readonly unknown[] }
  | { status: 'unapplied' }
  | { status: 'checked'; added: readonly unknown[] };

/** newConflicts(тиждень без пропозицій, тиждень з ними). */
function verdict(given: WeekGiven, proposals: WeekOverlay[]): Verdict {
  const base = effectiveWeek(given);
  const eff = effectiveWeek({ ...given, overlays: [...(given.overlays ?? []), ...proposals] });
  if (eff.unapplied.length > base.unapplied.length) return { status: 'unapplied' };
  const r = newConflicts(base.input, eff.input);
  if (r.status === 'INVALID_INPUT') return { status: 'invalid', week: r.week, issues: r.issues };
  return { status: 'checked', added: r.added };
}

export interface SubstitutionOutcome {
  state: 'done' | 'rejected' | 'failed';
  error: string | null;
  conflicts: unknown[];
  result: { proposals: ReturnType<typeof subView>[] } | null;
}

/**
 * solve.completed задачі substitution: перевірка інваріанту, вердикт validator-lib, збереження пропозицій.
 * Відхилені validator-lib пропозиції зберігаються як rejected (RQ4); пропозиції задачі, чию відсутність
 * скасовано до результату, — теж rejected.
 */
export async function completeSubstitution(
  trx: Trx,
  job: { school_id: string; job_id: string; input: unknown; absence_id: string | null },
  data: Record<string, unknown>,
): Promise<SubstitutionOutcome> {
  const input = job.input as SubstitutionInput;
  const proposals = parseProposals(input, data);
  if (!proposals) return { state: 'failed', error: 'invalid_result', conflicts: [], result: null };
  const given: WeekGiven = { snapshot: input.snapshot, template: input.template, holidays: input.holidays ?? [], absences: input.absences ?? [], overlays: input.overlays ?? [] };
  const v = verdict(
    given,
    proposals.map((p) => proposalOverlay(input.date, { ...p, new_teacher_id: p.teacher_id })),
  );
  if (v.status === 'unapplied') return { state: 'failed', error: 'invalid_result', conflicts: [], result: null };
  if (v.status === 'invalid') return { state: 'failed', error: v.week === 'baseline' ? 'invalid_snapshot' : 'invalid_result', conflicts: [], result: null };
  const rejected = v.added.length > 0;
  const cancelled = job.absence_id
    ? (await trx.selectFrom('absences').select('cancelled_at').where('absence_id', '=', job.absence_id).executeTakeFirst())?.cancelled_at
    : null;
  const subjectOf = (classId: string, no: number) =>
    input.template.lessons.find((t) => t.class_id === classId && t.day === isoWeekday(input.date) && t.lesson_no === no)?.subject_id ??
    // Урок, перенесений на цю дату погодженою заміною: предмет — з його вихідного слоту.
    movedInSubject(input, classId, no);
  const rows = proposals.map((p) => ({
    school_id: job.school_id,
    job_id: job.job_id,
    date: input.date,
    class_id: p.class_id,
    lesson_no: p.lesson_no,
    timetable_id: input.template.timetable_id,
    subject_id: subjectOf(p.class_id, p.lesson_no),
    original_teacher_id: input.absent_teacher_id,
    kind: p.kind as SubstitutionKind,
    new_teacher_id: p.teacher_id,
    off_profile: p.off_profile,
    moved_to_date: p.moved_to?.date ?? null,
    moved_to_lesson_no: p.moved_to?.lesson_no ?? null,
    step: p.step,
    state: cancelled || rejected ? ('rejected' as const) : ('proposed' as const),
  }));
  await trx.insertInto('substitutions').values(rows).onConflict((oc) => oc.doNothing()).execute();
  return {
    state: rejected ? 'rejected' : 'done',
    error: rejected ? 'validator_rejected' : null,
    conflicts: [...v.added],
    result: { proposals: rows.map(subView) },
  };
}

function movedInSubject(input: SubstitutionInput, classId: string, no: number): string {
  const day = isoWeekday(input.date);
  const o = (input.overlays ?? []).find((x) => x.kind === 'moved' && x.class_id === classId && x.moved_to?.day === day && x.moved_to.lesson_no === no);
  const src = o && input.template.lessons.find((t) => t.class_id === o.class_id && t.day === o.day && t.lesson_no === o.lesson_no);
  return src?.subject_id ?? input.template.lessons.find((t) => t.class_id === classId)!.subject_id;
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
 * POST /substitutions/{job_id}:approve. SELECT … FOR UPDATE рядка закладу; дата не в минулому (409
 * date_passed); на дату має діяти та сама версія, для якої пораховано заміну (інакше 409 stale).
 * Вердикт — validator-lib newConflicts на свіжому знімку: тиждень з погодженими накладками й
 * відсутностями проти того ж тижня з пропозиціями цієї задачі; нові чи гірші конфлікти → 409 conflicts.
 * Друга погоджена накладка на слот не пройде частковий унікальний індекс. У тілі можна замінити
 * «самостійну роботу» на «скасовано».
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
      const today = todayKyiv(deps.now());
      if (date < today || proposals.some((p) => p.moved_to_date !== null && p.moved_to_date < today)) {
        fail(409, 'date_passed', 'Дата заміни минула', 'Заміни погоджують на сьогодні або пізніше');
      }
      const cal = await loadCalendar(trx);
      const r = resolveScheduleAt(cal, date);
      if ((r.kind !== 'main' && r.kind !== 'alert') || r.timetable_id !== proposals[0]!.timetable_id) {
        return fail(409, 'stale', 'На дату діє інший розклад', 'Внесіть відсутність знову');
      }
      for (const p of proposals) {
        if (p.kind === 'self_study' && cancel.some((c) => c.class_id === p.class_id && c.lesson_no === p.lesson_no)) p.kind = 'cancelled';
      }
      const alertBells = r.kind === 'alert' ? await readAlertBells(trx) : [];
      const missing = missingProfileFields(snapshot, r.kind, alertBells);
      if (missing.length > 0) fail(422, 'profile_incomplete', 'Профіль закладу неповний', `Заповніть: ${missing.join(', ')}`, { missing });
      const { input } = project(snapshot, r.kind, deps.policy.priorityAreas, alertBells);
      const template = await readData(trx, r.timetable_id);
      const week = await loadWeek(trx, cal, input, r.timetable_id, date);
      const v = verdict(
        weekGiven(input, template, week),
        proposals.map((p) =>
          proposalOverlay(date, { ...p, moved_to: p.moved_to_date ? { date: p.moved_to_date, lesson_no: p.moved_to_lesson_no! } : null }),
        ),
      );
      if (v.status === 'unapplied') fail(409, 'stale', 'Тиждень змінився', 'Урок пропозиції вже не в цьому слоті; внесіть відсутність знову');
      if (v.status === 'invalid') {
        if (v.week === 'baseline') fail(500, 'internal', 'Тиждень із накладками не складається', undefined, { issues: v.issues });
        fail(409, 'stale', 'Пропозиція не застосовується до поточного тижня', 'Внесіть відсутність знову', { issues: v.issues });
      }
      if (v.status === 'checked' && v.added.length > 0) fail(409, 'conflicts', 'Заміна порушує правила', undefined, { conflicts: v.added });
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

export type { Names };
