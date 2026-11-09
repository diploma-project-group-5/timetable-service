// Читання й запис версій розкладу та перевірка validator-lib — спільне для задач, версій, тривог і замін.
import { randomUUID } from 'node:crypto';
import { validate, type DayFormat, type Lesson, type Snapshot, type ValidationOutcome } from '@lad/validator-lib';
import type { Trx } from '../db/index.js';
import type { Names } from './projection.js';

export const MAX_CONFLICTS = 200;

export interface TimetableData {
  lessons: Lesson[];
  day_formats: DayFormat[];
}

/** Перевірка розкладу на знімку (синхронно, у процесі). Ніколи не кидає на вхідних даних. */
export function check(input: Snapshot, data: TimetableData): ValidationOutcome {
  return validate({ schema_version: '1.0', snapshot: input, timetable: data }, { max_conflicts: MAX_CONFLICTS });
}

export async function readData(trx: Trx, timetableId: string): Promise<TimetableData> {
  const [lessons, dayFormats] = await Promise.all([
    trx
      .selectFrom('lessons')
      .select(['class_id', 'day', 'lesson_no', 'subject_id', 'teacher_id'])
      .where('timetable_id', '=', timetableId)
      .orderBy('class_id')
      .orderBy('day')
      .orderBy('lesson_no')
      .execute(),
    trx
      .selectFrom('day_formats')
      .select(['class_id', 'day', 'in_person'])
      .where('timetable_id', '=', timetableId)
      .orderBy('class_id')
      .orderBy('day')
      .execute(),
  ]);
  return { lessons, day_formats: dayFormats };
}

export interface NewVersion {
  schoolId: string;
  kind: 'main' | 'alert';
  snapshotVersion: number;
  input: Snapshot;
  names: Names;
  jobId: string | null;
  copiedFrom?: string | null;
  buildMs?: number | null;
  data: TimetableData;
}

export async function insertVersion(trx: Trx, v: NewVersion): Promise<string> {
  const timetableId = randomUUID();
  await trx
    .insertInto('timetables')
    .values({
      school_id: v.schoolId,
      timetable_id: timetableId,
      kind: v.kind,
      state: 'validated',
      snapshot_version: v.snapshotVersion,
      input: JSON.stringify(v.input),
      names: JSON.stringify(v.names),
      job_id: v.jobId,
      copied_from: v.copiedFrom ?? null,
      build_ms: v.buildMs ?? null,
      order_no: null,
      order_date: null,
      approved_by: null,
      effective_from: null,
      published_at: null,
    })
    .execute();
  await writeData(trx, v.schoolId, timetableId, v.data);
  return timetableId;
}

export async function writeData(trx: Trx, schoolId: string, timetableId: string, data: TimetableData): Promise<void> {
  await trx.deleteFrom('lessons').where('timetable_id', '=', timetableId).execute();
  await trx.deleteFrom('day_formats').where('timetable_id', '=', timetableId).execute();
  // Пакетами, щоб не впертися в ліміт параметрів запиту PostgreSQL.
  for (let i = 0; i < data.lessons.length; i += 1000) {
    await trx
      .insertInto('lessons')
      .values(data.lessons.slice(i, i + 1000).map((l) => ({ school_id: schoolId, timetable_id: timetableId, ...l })))
      .execute();
  }
  for (let i = 0; i < data.day_formats.length; i += 1000) {
    await trx
      .insertInto('day_formats')
      .values(data.day_formats.slice(i, i + 1000).map((f) => ({ school_id: schoolId, timetable_id: timetableId, ...f })))
      .execute();
  }
}

/** Конфлікти validator-lib у формі для problem+json і задачі. */
export const conflictsOf = (outcome: ValidationOutcome): unknown[] => [...(outcome.status === 'INVALID_INPUT' ? outcome.issues : outcome.conflicts)];
