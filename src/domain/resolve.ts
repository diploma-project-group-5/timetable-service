// resolveScheduleAt(date) (розділ 04): канікули → день без уроків; чинна активація → шаблон
// kind='alert' з дзвінками тривог; інакше опублікована kind='main' з найпізнішою effective_from ≤ дата
// з основними дзвінками; поверх — погоджені заміни на дату, пораховані для цієї ж версії.
// «Запланована», «чинна» й «архівна» не зберігаються, а обчислюються тут з effective_from і дати.
import type { Trx } from '../db/index.js';

export interface PublishedMain {
  timetable_id: string;
  effective_from: string;
  published_at: Date;
}

export interface Activation {
  activation_id: string;
  date_from: string;
  date_to: string | null;
}

export interface Calendar {
  holidayFrom: string | null;
  holidayTo: string | null;
  /** Опубліковані основні версії, від найпізнішої effective_from. */
  mains: PublishedMain[];
  activations: Activation[];
  alertTimetableId: string | null;
}

export type Resolved =
  | { kind: 'holiday'; from: string; to: string }
  | { kind: 'alert'; timetable_id: string; activation: Activation }
  | { kind: 'main'; timetable_id: string; version: PublishedMain }
  | { kind: 'none' };

export async function loadCalendar(trx: Trx): Promise<Calendar> {
  const [state, mains, activations, plan] = await Promise.all([
    trx.selectFrom('school_state').select(['holiday_from', 'holiday_to']).executeTakeFirst(),
    trx
      .selectFrom('timetables')
      .select(['timetable_id', 'effective_from', 'published_at'])
      .where('kind', '=', 'main')
      .where('state', '=', 'published')
      .orderBy('effective_from', 'desc')
      .execute(),
    trx.selectFrom('alert_activations').select(['activation_id', 'date_from', 'date_to']).orderBy('date_from').execute(),
    trx.selectFrom('alert_plan').select('timetable_id').executeTakeFirst(),
  ]);
  return {
    holidayFrom: state?.holiday_from ?? null,
    holidayTo: state?.holiday_to ?? null,
    mains: mains.map((m) => ({ timetable_id: m.timetable_id, effective_from: m.effective_from!, published_at: m.published_at! })),
    activations,
    alertTimetableId: plan?.timetable_id ?? null,
  };
}

export const activationOn = (cal: Calendar, date: string): Activation | undefined =>
  cal.activations.find((a) => a.date_from <= date && (a.date_to === null || date < a.date_to));

export const mainOn = (cal: Calendar, date: string): PublishedMain | undefined => cal.mains.find((m) => m.effective_from <= date);

export function resolveScheduleAt(cal: Calendar, date: string): Resolved {
  if (cal.holidayFrom && cal.holidayTo && cal.holidayFrom <= date && date <= cal.holidayTo) {
    return { kind: 'holiday', from: cal.holidayFrom, to: cal.holidayTo };
  }
  const activation = activationOn(cal, date);
  if (activation && cal.alertTimetableId) return { kind: 'alert', timetable_id: cal.alertTimetableId, activation };
  const version = mainOn(cal, date);
  if (version) return { kind: 'main', timetable_id: version.timetable_id, version };
  return { kind: 'none' };
}

export type Phase = 'scheduled' | 'current' | 'archived';

/** Фаза опублікованої версії на сьогодні: запланована (майбутня), чинна (найпізніша ≤ сьогодні), архівна. */
export function phaseOf(cal: Calendar, timetableId: string, today: string): Phase | undefined {
  const v = cal.mains.find((m) => m.timetable_id === timetableId);
  if (!v) return undefined;
  if (v.effective_from > today) return 'scheduled';
  return mainOn(cal, today)?.timetable_id === timetableId ? 'current' : 'archived';
}

export interface LostSubstitution {
  date: string;
  class_id: string;
  lesson_no: number;
}

/** Погоджені заміни, пораховані для timetableIds, на датах [from, to) — після зміни втратять силу. */
export async function approvedSubstitutionsOn(
  trx: Trx,
  opts: { from: string; to?: string | null; timetableKind: 'main' | 'alert'; exceptTimetableId?: string },
): Promise<LostSubstitution[]> {
  let q = trx
    .selectFrom('substitutions')
    .innerJoin('timetables', (j) =>
      j.onRef('timetables.school_id', '=', 'substitutions.school_id').onRef('timetables.timetable_id', '=', 'substitutions.timetable_id'),
    )
    .select(['substitutions.date', 'substitutions.class_id', 'substitutions.lesson_no'])
    .where('substitutions.state', '=', 'approved')
    .where('timetables.kind', '=', opts.timetableKind)
    .where('substitutions.date', '>=', opts.from);
  if (opts.to) q = q.where('substitutions.date', '<', opts.to);
  if (opts.exceptTimetableId) q = q.where('substitutions.timetable_id', '<>', opts.exceptTimetableId);
  return q.orderBy('substitutions.date').orderBy('substitutions.class_id').orderBy('substitutions.lesson_no').execute();
}
