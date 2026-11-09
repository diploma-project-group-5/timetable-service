// Публічний розклад за QR (розділ 11): поточний і наступний ISO-тиждень за Europe/Kyiv однією
// відповіддю, рахується при читанні (resolveScheduleAt). Мінімум даних: на сторінці класу немає
// підписів вчителів (заміна — словом «Заміна»), ніде немає назви закладу, місткості й кількості учнів.
import { withSchool, type BellRow, type Db, type Trx } from '../db/index.js';
import { addDays, formatUa, isoWeek, schoolDays, todayKyiv, weekStart } from '../time.js';
import { readAlertBells } from './jobs.js';
import type { Names } from './projection.js';
import { activationOn, loadCalendar, mainOn, resolveScheduleAt, type Calendar } from './resolve.js';
import type { TokenRow } from './qr.js';

export interface PublicLesson {
  lesson_no: number;
  start: string;
  end: string;
  subject?: string;
  class_name?: string;
  substitution: boolean;
}

export interface PublicDay {
  date: string;
  format: 'in_person' | 'remote' | null;
  lessons: PublicLesson[];
  holiday?: true;
  holiday_from?: string;
  holiday_to?: string;
}

export interface PublicTimetable {
  state: 'published' | 'not_published';
  target_label: string;
  published_at: string | null;
  upcoming_change: string | null;
  weeks: { week: string; days: PublicDay[] }[];
}

interface Version {
  names: Names;
  lessons: { class_id: string; day: number; lesson_no: number; subject_id: string; teacher_id: string }[];
  formats: Map<string, boolean>;
}

async function loadVersion(trx: Trx, timetableId: string, cache: Map<string, Version>): Promise<Version> {
  const hit = cache.get(timetableId);
  if (hit) return hit;
  const [tt, lessons, formats] = await Promise.all([
    trx.selectFrom('timetables').select('names').where('timetable_id', '=', timetableId).executeTakeFirstOrThrow(),
    trx.selectFrom('lessons').select(['class_id', 'day', 'lesson_no', 'subject_id', 'teacher_id']).where('timetable_id', '=', timetableId).execute(),
    trx.selectFrom('day_formats').select(['class_id', 'day', 'in_person']).where('timetable_id', '=', timetableId).execute(),
  ]);
  const v: Version = { names: tt.names as Names, lessons, formats: new Map(formats.map((f) => [`${f.class_id}:${f.day}`, f.in_person])) };
  cache.set(timetableId, v);
  return v;
}

function bannerOf(cal: Calendar, today: string): string | null {
  const current = activationOn(cal, today);
  if (current) return current.date_to ? `Діє розклад тривог до ${formatUa(addDays(current.date_to, -1))}` : 'Діє розклад тривог';
  const upcoming = cal.activations.find((a) => a.date_from > today);
  if (upcoming) return `З ${formatUa(upcoming.date_from)} діє розклад тривог`;
  const scheduled = cal.mains.filter((m) => m.effective_from > today).at(-1);
  if (scheduled) return `З ${formatUa(scheduled.effective_from)} діє новий розклад`;
  return null;
}

type Sub = {
  date: string;
  class_id: string;
  lesson_no: number;
  timetable_id: string;
  subject_id: string;
  original_teacher_id: string;
  kind: 'teacher' | 'moved' | 'self_study' | 'cancelled';
  new_teacher_id: string | null;
  moved_to_date: string | null;
  moved_to_lesson_no: number | null;
};

export async function publicTimetable(db: Db, schoolId: string, token: TokenRow, now: Date): Promise<PublicTimetable> {
  return withSchool(db, schoolId, async (trx) => {
    const cal = await loadCalendar(trx);
    const state = await trx.selectFrom('school_state').select(['saturday', 'main_bells']).executeTakeFirst();
    const today = todayKyiv(now);
    const cache = new Map<string, Version>();

    const effective = mainOn(cal, today) ?? cal.mains.at(-1);
    const labelFrom = (names: Names | undefined) =>
      token.scope === 'class'
        ? names?.classes.find((c) => c.class_id === token.target_id)?.name
        : names?.teachers.find((t) => t.teacher_id === token.target_id)?.label;
    let targetLabel = effective ? labelFrom((await loadVersion(trx, effective.timetable_id, cache)).names) : undefined;
    if (!targetLabel) {
      const any = await trx.selectFrom('timetables').select('names').orderBy('created_at', 'desc').execute();
      targetLabel = any.map((r) => labelFrom(r.names as Names)).find(Boolean);
    }

    if (cal.mains.length === 0) {
      return { state: 'not_published', target_label: targetLabel ?? '', published_at: null, upcoming_change: null, weeks: [] };
    }

    const mainBells = state?.main_bells ?? [];
    const alertBells = await readAlertBells(trx);
    const days = schoolDays(state?.saturday ?? false);
    const start = weekStart(today);
    const horizon = [0, 7].map((offset) => {
      const monday = addDays(start, offset);
      return { week: isoWeek(monday), dates: days.map((d) => addDays(monday, d - 1)) };
    });
    const allDates = horizon.flatMap((w) => w.dates);
    const subs: Sub[] = await trx
      .selectFrom('substitutions')
      .select(['date', 'class_id', 'lesson_no', 'timetable_id', 'subject_id', 'original_teacher_id', 'kind', 'new_teacher_id', 'moved_to_date', 'moved_to_lesson_no'])
      .where('state', '=', 'approved')
      .where('date', '>=', allDates[0]!)
      .where('date', '<=', allDates.at(-1)!)
      .execute();

    // Перенесені уроки з'являються на новій даті: збираємо їх наперед.
    const resolvedOn = new Map(allDates.map((d) => [d, resolveScheduleAt(cal, d)]));
    const activeSubs = subs.filter((s) => {
      const r = resolvedOn.get(s.date);
      return r && (r.kind === 'main' || r.kind === 'alert') && r.timetable_id === s.timetable_id;
    });

    const weeks = [];
    for (const w of horizon) {
      const out: PublicDay[] = [];
      for (const date of w.dates) {
        const r = resolvedOn.get(date)!;
        if (r.kind === 'holiday') {
          out.push({ date, format: null, lessons: [], holiday: true, holiday_from: r.from, holiday_to: r.to });
          continue;
        }
        if (r.kind === 'none') {
          out.push({ date, format: null, lessons: [] });
          continue;
        }
        const v = await loadVersion(trx, r.timetable_id, cache);
        const bells = new Map((r.kind === 'alert' ? alertBells : mainBells).map((b: BellRow) => [b.lesson_no, b]));
        const weekday = Number(new Date(`${date}T00:00:00Z`).getUTCDay() || 7);
        const subjectName = (id: string) => v.names.subjects?.find((s) => s.subject_id === id)?.name ?? '';
        const className = (id: string) => v.names.classes.find((c) => c.class_id === id)?.name ?? '';
        const lesson = (no: number, extra: Partial<PublicLesson>, substitution: boolean): PublicLesson => ({
          lesson_no: no,
          start: bells.get(no)?.start ?? '',
          end: bells.get(no)?.end ?? '',
          ...extra,
          substitution,
        });
        const daySubs = activeSubs.filter((s) => s.date === date);
        const movedHere = activeSubs.filter((s) => s.kind === 'moved' && s.moved_to_date === date);
        const lessons: PublicLesson[] = [];
        let inPerson: boolean | null = null;

        if (token.scope === 'class') {
          inPerson = v.formats.get(`${token.target_id}:${weekday}`) ?? false;
          for (const l of v.lessons.filter((x) => x.class_id === token.target_id && x.day === weekday)) {
            const s = daySubs.find((x) => x.class_id === l.class_id && x.lesson_no === l.lesson_no);
            if (s?.kind === 'cancelled' || s?.kind === 'moved') continue;
            lessons.push(lesson(l.lesson_no, { subject: subjectName(l.subject_id) }, s !== undefined));
          }
          for (const s of movedHere.filter((x) => x.class_id === token.target_id)) {
            lessons.push(lesson(s.moved_to_lesson_no!, { subject: subjectName(s.subject_id) }, true));
          }
        } else {
          const own = v.lessons.filter((x) => x.teacher_id === token.target_id && x.day === weekday);
          const add = (classId: string, no: number, substitution: boolean) => {
            lessons.push(lesson(no, { class_name: className(classId) }, substitution));
            const f = v.formats.get(`${classId}:${weekday}`) ?? false;
            inPerson = (inPerson ?? false) || f;
          };
          for (const l of own) {
            const s = daySubs.find((x) => x.class_id === l.class_id && x.lesson_no === l.lesson_no);
            if (s) continue; // вчителя замінено, урок перенесено чи скасовано
            add(l.class_id, l.lesson_no, false);
          }
          for (const s of daySubs.filter((x) => x.kind === 'teacher' && x.new_teacher_id === token.target_id)) add(s.class_id, s.lesson_no, true);
          for (const s of movedHere.filter((x) => x.original_teacher_id === token.target_id)) add(s.class_id, s.moved_to_lesson_no!, true);
        }
        lessons.sort((a, b) => a.lesson_no - b.lesson_no);
        out.push({ date, format: inPerson === null ? null : inPerson ? 'in_person' : 'remote', lessons });
      }
      weeks.push({ week: w.week, days: out });
    }

    return {
      state: 'published',
      target_label: targetLabel ?? '',
      published_at: (effective ?? cal.mains[0]!).published_at.toISOString(),
      upcoming_change: bannerOf(cal, today),
      weeks,
    };
  });
}
