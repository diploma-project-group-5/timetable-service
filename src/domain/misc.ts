// Канікули (етап 2), експорт даних вчителя (етап 2, ст. 8) і подія school.data.changed від school.
import { sql } from 'kysely';
import { claimInbox, InvalidEventError, type Envelope } from '../db/events.js';
import { ensureSchoolState, withSchool, type Trx } from '../db/index.js';
import { fail } from '../problem.js';
import { isValidDate } from '../time.js';
import { recordAudit, type Ctx, type Deps } from './context.js';
import { syncSchoolState } from './jobs.js';
import type { Names } from './projection.js';
import { ensureToken, revokeToken } from './qr.js';

// ───────────── канікули ─────────────

export interface Holidays {
  holiday_from: string | null;
  holiday_to: string | null;
}

export async function getHolidays(deps: Deps, schoolId: string): Promise<Holidays> {
  return withSchool(deps.db, schoolId, async (trx) => {
    const s = await trx.selectFrom('school_state').select(['holiday_from', 'holiday_to']).executeTakeFirst();
    return { holiday_from: s?.holiday_from ?? null, holiday_to: s?.holiday_to ?? null };
  });
}

/**
 * PUT /holidays: дві дати або обидві null (прибрати канікули); from > to → 422. Вільного тексту
 * немає: web показує фіксований текст «Канікули з … по …» (без витоку ПД і XSS).
 */
export async function putHolidays(deps: Deps, ctx: Ctx, body: Holidays): Promise<Holidays> {
  const { holiday_from: from, holiday_to: to } = body;
  if ((from === null) !== (to === null)) fail(422, 'invalid_date', 'Некоректні канікули', 'Задайте обидві дати або жодної');
  if (from !== null && to !== null) {
    if (!isValidDate(from) || !isValidDate(to)) fail(422, 'invalid_date', 'Некоректна дата', 'YYYY-MM-DD');
    if (from > to) fail(422, 'invalid_date', 'Некоректні канікули', 'holiday_from пізніше за holiday_to');
  }
  return withSchool(deps.db, ctx.schoolId, async (trx) => {
    await ensureSchoolState(trx, ctx.schoolId, true);
    await trx.updateTable('school_state').set({ holiday_from: from, holiday_to: to, updated_at: new Date() }).where('school_id', '=', ctx.schoolId).execute();
    await recordAudit(trx, ctx, from ? 'holidays_set' : 'holidays_cleared', ctx.schoolId, { holiday_from: from, holiday_to: to }, deps.now());
    return { holiday_from: from, holiday_to: to };
  });
}

// ───────────── експорт вчителя ─────────────

/**
 * Етап 2 · GET /teachers/{id}/export: частина експорту з timetable — уроки у версіях, відсутності
 * (без причини, її не зберігаємо), заміни, зокрема минулі. web додає частину school-service.
 */
export async function exportTeacher(deps: Deps, ctx: Ctx, teacherId: string) {
  return withSchool(deps.db, ctx.schoolId, async (trx) => {
    const lessons = await trx
      .selectFrom('lessons')
      .innerJoin('timetables', (j) => j.onRef('timetables.school_id', '=', 'lessons.school_id').onRef('timetables.timetable_id', '=', 'lessons.timetable_id'))
      .select(['lessons.timetable_id', 'timetables.kind', 'timetables.state', 'timetables.effective_from', 'lessons.class_id', 'lessons.day', 'lessons.lesson_no', 'lessons.subject_id'])
      .where('lessons.teacher_id', '=', teacherId)
      .orderBy('timetables.created_at')
      .orderBy('lessons.day')
      .orderBy('lessons.lesson_no')
      .execute();
    const absences = await trx
      .selectFrom('absences')
      .select(['absence_id', 'date_from', 'date_to', 'lesson_nos', 'created_at', 'cancelled_at'])
      .where('teacher_id', '=', teacherId)
      .orderBy('date_from')
      .execute();
    const substitutions = await trx
      .selectFrom('substitutions')
      .select(['job_id', 'date', 'class_id', 'lesson_no', 'subject_id', 'kind', 'state', 'original_teacher_id', 'new_teacher_id'])
      .where((eb) => eb.or([eb('new_teacher_id', '=', teacherId), eb('original_teacher_id', '=', teacherId)]))
      .orderBy('date')
      .execute();
    const now = deps.now();
    await recordAudit(trx, ctx, 'teacher_exported', teacherId, { source: 'timetable-service' }, now);
    return {
      source: 'timetable-service',
      exported_at: now.toISOString(),
      teacher_id: teacherId,
      lessons,
      absences: absences.map((a) => ({ ...a, created_at: a.created_at.toISOString(), cancelled_at: a.cancelled_at?.toISOString() ?? null })),
      substitutions: substitutions.map((s) => ({ ...s, role: s.new_teacher_id === teacherId ? 'substitute' : 'absent' })),
    };
  });
}

// ───────────── school.data.changed ─────────────

interface Change {
  entity?: string;
  op?: string;
  id?: string;
  teacher_no?: number;
}

/** Підписи видаленого вчителя у копіях версій → «Вчитель #N» (розділ 12). */
async function relabelDeletedTeacher(trx: Trx, teacherId: string, teacherNo: number): Promise<void> {
  const rows = await trx.selectFrom('timetables').select(['timetable_id', 'names']).execute();
  for (const r of rows) {
    const names = r.names as Names;
    if (!names.teachers?.some((t) => t.teacher_id === teacherId)) continue;
    const updated: Names = { ...names, teachers: names.teachers.map((t) => (t.teacher_id === teacherId ? { ...t, label: `Вчитель #${teacherNo}` } : t)) };
    await trx.updateTable('timetables').set({ names: JSON.stringify(updated) }).where('timetable_id', '=', r.timetable_id).execute();
  }
  const jobs = await trx.selectFrom('jobs').select(['job_id', 'names']).execute();
  for (const j of jobs) {
    const names = j.names as Partial<Names>;
    if (!names.teachers?.some((t) => t.teacher_id === teacherId)) continue;
    const updated = { ...names, teachers: names.teachers.map((t) => (t.teacher_id === teacherId ? { ...t, label: `Вчитель #${teacherNo}` } : t)) };
    await trx.updateTable('jobs').set({ names: JSON.stringify(updated) }).where('job_id', '=', j.job_id).execute();
  }
}

/**
 * school.data.changed: «новіший за відомий» оновлює лише останній відомий snapshot_version (ознака
 * «дані змінилися після побудови»); дельти застосовуються ідемпотентно за сутністю — QR створюється,
 * якщо його немає; revoked_at ставиться, якщо ще не стоїть; тож перегравання старої події нічого не губить.
 */
export async function handleSchoolDataChanged(deps: Deps, e: Envelope): Promise<'processed' | 'duplicate'> {
  const version = e.data.snapshot_version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) throw new InvalidEventError('school.data.changed без snapshot_version');
  const changes = (Array.isArray(e.data.changes) ? e.data.changes : []) as Change[];
  // Дзвінки й субота потрібні сторінкам за QR: беремо свіжий знімок до транзакції.
  const needsSnapshot = changes.some((c) => c.entity === 'bells' || c.entity === 'profile');
  const snapshot = needsSnapshot ? await deps.fetchSnapshot(e.school_id, e.correlation_id) : null;

  return withSchool(deps.db, e.school_id, async (trx) => {
    if (!(await claimInbox(trx, e.school_id, e.event_id, 'school.data.changed'))) return 'duplicate';
    await ensureSchoolState(trx, e.school_id);
    if (snapshot) await syncSchoolState(trx, e.school_id, snapshot);
    await trx
      .updateTable('school_state')
      .set({ known_snapshot_version: sql<number>`greatest(known_snapshot_version, ${version})`, updated_at: new Date() })
      .where('school_id', '=', e.school_id)
      .execute();
    for (const c of changes) {
      if (!c.id) continue;
      if (c.entity === 'class' && c.op === 'created') await ensureToken(trx, e.school_id, 'class', c.id);
      if (c.entity === 'teacher' && c.op === 'created') await ensureToken(trx, e.school_id, 'teacher', c.id);
      if (c.entity === 'class' && c.op === 'archived') await revokeToken(trx, 'class', c.id);
      if (c.entity === 'teacher' && c.op === 'deleted') {
        await revokeToken(trx, 'teacher', c.id);
        if (typeof c.teacher_no === 'number') await relabelDeletedTeacher(trx, c.id, c.teacher_no);
      }
    }
    return 'processed';
  });
}
