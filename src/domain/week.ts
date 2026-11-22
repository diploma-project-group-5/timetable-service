// Тиждень із накладками (етап 2, ADR 2026-11-09-validator-lib-substitution-check і
// 2026-11-15-solver-substitution-engine). effectiveWeek збирає вхід validator-lib з шаблону, свят,
// відсутностей і погоджених накладок; на ньому newConflicts дає вердикт задачі заміни й :approve.
// Семантика — та сама, що в генераторі contracts/vectors/substitution (тест проганяє всі вектори з given):
//   - свята спершу прибирають уроки шаблону (not_held holiday) і день зі school_days та day_formats;
//   - teacher — урок лишається на місці з іншим вчителем і origin=substitution;
//   - moved — урок (той самий клас, предмет, вчитель) іде в moved_to;
//   - self_study / cancelled — урок не проводиться (not_held з предметом).
// Дні — дні тижня 1..6 одного ISO-тижня; дати перетворює на дні той, хто викликає.
import type { Absence, DayFormat, Lesson, NotHeld, Snapshot, ValidationInput } from '@lad/validator-lib';
import type { SubstitutionKind } from '../db/index.js';

export interface WeekOverlay {
  day: number;
  class_id: string;
  lesson_no: number;
  kind: SubstitutionKind;
  new_teacher_id?: string | null;
  moved_to?: { day: number; lesson_no: number } | null;
}

export interface WeekGiven {
  snapshot: Snapshot;
  template: { lessons: readonly Lesson[]; day_formats: readonly DayFormat[] };
  holidays?: readonly number[];
  absences?: readonly Absence[];
  overlays?: readonly WeekOverlay[];
}

export interface EffectiveWeek {
  input: ValidationInput;
  /** Накладки, яким немає уроку в слоті (свято, урок уже прибрано іншою накладкою): на тиждень не впливають. */
  unapplied: WeekOverlay[];
}

type Placed = Lesson & { moved?: true };

function stripMoved(l: Placed): Lesson {
  const out: Placed = { ...l };
  delete out.moved;
  return out;
}

const at = (o: { class_id: string; day: number; lesson_no: number }) => (l: Lesson) =>
  l.class_id === o.class_id && l.day === o.day && l.lesson_no === o.lesson_no;

/**
 * Накладки застосовуються по черзі. Якщо в слоті два уроки (туди вже перенесли інший), накладка
 * стосується уроку, що стоїть там за шаблоном; перенесений обирається, лише коли іншого немає
 * (накладка на урок, перенесений раніше погодженою заміною).
 */
export function effectiveWeek(g: WeekGiven): EffectiveWeek {
  const holidays = [...(g.holidays ?? [])];
  const absences = [...(g.absences ?? [])];
  const notHeld: NotHeld[] = [];
  const unapplied: WeekOverlay[] = [];
  let lessons: Placed[] = [];
  for (const l of g.template.lessons) {
    if (holidays.includes(l.day)) notHeld.push({ class_id: l.class_id, day: l.day, lesson_no: l.lesson_no, subject_id: l.subject_id, kind: 'holiday' });
    else lessons.push({ ...l });
  }
  for (const o of g.overlays ?? []) {
    const match = at(o);
    let i = lessons.findIndex((l) => match(l) && !l.moved);
    if (i < 0) i = lessons.findIndex(match);
    if (i < 0) {
      unapplied.push(o);
      continue;
    }
    const l = lessons[i]!;
    if (o.kind === 'teacher' && o.new_teacher_id) lessons[i] = { ...l, teacher_id: o.new_teacher_id, origin: 'substitution' };
    else if (o.kind === 'moved' && o.moved_to) lessons[i] = { ...l, day: o.moved_to.day, lesson_no: o.moved_to.lesson_no, moved: true };
    else if (o.kind === 'self_study' || o.kind === 'cancelled') {
      lessons = lessons.filter((_, j) => j !== i);
      notHeld.push({ class_id: l.class_id, day: l.day, lesson_no: l.lesson_no, subject_id: l.subject_id, kind: o.kind });
    } else unapplied.push(o);
  }
  const input: ValidationInput = {
    schema_version: '1.0',
    snapshot: { ...g.snapshot, school_days: g.snapshot.school_days.filter((d) => !holidays.includes(d)) },
    timetable: {
      lessons: lessons.map(stripMoved),
      day_formats: g.template.day_formats.filter((f) => !holidays.includes(f.day)),
      ...(notHeld.length > 0 ? { not_held: notHeld } : {}),
    },
    ...(absences.length > 0 ? { absences } : {}),
    ...(holidays.length > 0 ? { holidays } : {}),
  };
  return { input, unapplied };
}
