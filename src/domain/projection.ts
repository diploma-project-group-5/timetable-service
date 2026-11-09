// Проєкція знімка school для solver і validator-lib (contracts: solve.build.requested.v1,
// validation.input.v1): лише id, без назв класів і підписів вчителів (мінімізація ПД, ст. 6).
// Назви й підписи окремо копіюються у версію розкладу (розділ 04: «копія назв класів і підписів»).
import type { Snapshot } from '@lad/validator-lib';
import type { BellRow } from '../db/index.js';
import type { SchoolSnapshot } from '../school-client.js';
import { schoolDays } from '../time.js';

export type Kind = 'main' | 'alert';

export interface Names {
  classes: { class_id: string; name: string }[];
  teachers: { teacher_id: string; label: string }[];
  subjects: { subject_id: string; name: string; short_name: string }[];
}

export interface Projection {
  input: Snapshot;
  names: Names;
}

export interface ProjectionConflict {
  rule: string;
  class_id?: string;
  teacher_id?: string;
  condition?: 'passport' | 'seats';
  value?: number;
  limit?: number;
}

/** Поля профілю, без яких будувати не можна (422 profile_incomplete, розділ 10). */
export function missingProfileFields(snapshot: SchoolSnapshot, kind: Kind, alertBells: BellRow[] = []): string[] {
  const p = snapshot.profile;
  const missing: string[] = [];
  if (p.lessons_per_day === null) missing.push('lessons_per_day');
  if (p.shelter_capacity === null) missing.push('shelter_capacity');
  if (p.non_teaching_staff === null) missing.push('non_teaching_staff');
  if (kind === 'alert') {
    if (p.shelter_seats === null) missing.push('shelter_seats');
    if (alertBells.length === 0) missing.push('alert_bells');
  }
  return missing;
}

/**
 * Будує проєкцію знімка. Лише активні класи й предмети та невидалені вчителі; рядки плану — лише
 * на них. Для kind=alert кількість уроків на день — за дзвінками тривог, місткість — дві умови.
 * Викликати після missingProfileFields (поля профілю не null).
 */
export function project(snapshot: SchoolSnapshot, kind: Kind, priorityAreas: string[], alertBells: BellRow[] = []): Projection {
  const p = snapshot.profile;
  const classes = snapshot.classes.filter((c) => c.archived_at === null);
  const subjects = snapshot.subjects.filter((s) => s.archived_at === null);
  const teachers = snapshot.teachers.filter((t) => t.deleted_at === null);
  const active = {
    classes: new Set(classes.map((c) => c.class_id)),
    subjects: new Set(subjects.map((s) => s.subject_id)),
    teachers: new Set(teachers.map((t) => t.teacher_id)),
  };
  const passport = p.shelter_capacity ?? 0;
  const input: Snapshot = {
    kind,
    school_days: schoolDays(p.saturday),
    lessons_per_day: kind === 'alert' ? alertBells.length : (p.lessons_per_day ?? 1),
    staff: p.non_teaching_staff ?? 0,
    capacity: kind === 'alert' ? { seats: p.shelter_seats ?? 0, passport } : { passport },
    classes: classes.map((c) => ({ id: c.class_id, students: c.students, priority: c.in_person_priority })),
    subjects: subjects.map((s) => ({ id: s.subject_id, priority_area: priorityAreas.includes(s.education_area), no_shelter: s.not_in_shelter })),
    teachers: teachers.map((t) => ({ id: t.teacher_id, weekly_limit: t.weekly_hours_limit, unavailable_days: [...t.unavailable_days].sort((a, b) => a - b) })),
    rows: snapshot.curriculum
      .filter((r) => active.classes.has(r.class_id) && active.subjects.has(r.subject_id) && active.teachers.has(r.teacher_id))
      .map((r) => ({ class_id: r.class_id, subject_id: r.subject_id, teacher_id: r.teacher_id, hours: r.hours_per_week })),
  };
  return { input, names: namesOf(snapshot) };
}

/** Копія назв і підписів усіх класів, вчителів і предметів знімка (зокрема архівних). */
export function namesOf(snapshot: SchoolSnapshot): Names {
  return {
    classes: snapshot.classes.map((c) => ({ class_id: c.class_id, name: c.name })),
    teachers: snapshot.teachers.map((t) => ({ teacher_id: t.teacher_id, label: t.label })),
    subjects: snapshot.subjects.map((s) => ({ subject_id: s.subject_id, name: s.name, short_name: s.short_name })),
  };
}

/**
 * Дешеві передперевірки перед запуском (розділ 05): якщо розв'язку точно немає, задача одразу
 * infeasible і в Kafka не йде. Коди правил — з contracts/conflict.v1.json.
 */
export function precheck(input: Snapshot): ProjectionConflict[] {
  const conflicts: ProjectionConflict[] = [];
  if (input.staff > input.capacity.passport) {
    conflicts.push({ rule: 'staff_over_passport', condition: 'passport', value: input.staff, limit: input.capacity.passport });
  }
  const slots = input.lessons_per_day * input.school_days.length;
  const classHours = new Map<string, number>();
  const teacherHours = new Map<string, number>();
  for (const r of input.rows) {
    classHours.set(r.class_id, (classHours.get(r.class_id) ?? 0) + r.hours);
    teacherHours.set(r.teacher_id, (teacherHours.get(r.teacher_id) ?? 0) + r.hours);
  }
  for (const [classId, hours] of classHours) {
    if (hours > slots) conflicts.push({ rule: 'class_hours_exceed_slots', class_id: classId, value: hours, limit: slots });
  }
  for (const t of input.teachers) {
    const hours = teacherHours.get(t.id) ?? 0;
    if (hours === 0) continue;
    if (hours > t.weekly_limit) conflicts.push({ rule: 'teacher_weekly_limit', teacher_id: t.id, value: hours, limit: t.weekly_limit });
    const available = input.school_days.filter((d) => !t.unavailable_days.includes(d)).length;
    if (available === 0) conflicts.push({ rule: 'teacher_unavailable_all_days', teacher_id: t.id });
    else if (hours > available * input.lessons_per_day) {
      conflicts.push({ rule: 'teacher_hours_exceed_available_slots', teacher_id: t.id, value: hours, limit: available * input.lessons_per_day });
    }
  }
  return conflicts;
}
