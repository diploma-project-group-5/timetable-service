// Етап 2: відсутності, задачі замін, пропозиції, погодження з перевіркою накладок, сторінки за QR, експорт.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { handleSolveStatus } from '../src/domain/jobs.js';
import { ORDER, testApp, uuid, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await testApp();
});
afterAll(() => ctx.close());

/** Опублікований з понеділка 16.11 розклад; «сьогодні» — той самий понеділок, щоб розклад діяв. */
async function liveSchool() {
  ctx.clock.now = new Date('2026-11-09T10:00:00Z');
  const s = ctx.newSchool();
  const built = await ctx.build(s.id);
  await ctx.as(s.id, 'POST', `/timetables/${built.job.result.timetable_id}:publish`, { ...ORDER, effective_from: '2026-11-16' });
  ctx.clock.now = new Date('2026-11-16T06:00:00Z');
  return { ...s, tt: built.job.result.timetable_id, lessons: built.result.lessons };
}

afterAll(() => {
  ctx.clock.now = new Date('2026-11-09T10:00:00Z');
});

const complete = (schoolId: string, jobId: string, proposals: unknown[], step = 1) =>
  handleSolveStatus(ctx.deps, ctx.status(schoolId, 'solve.completed', { job_id: jobId, status: 'FEASIBLE', lessons: [], day_formats: [], conflicts: [], substitution: { step, proposals } }));

describe('відсутності', () => {
  test('по задачі на кожну навчальну дату з уроками; payload за contracts; без причини', async () => {
    const { id, snap } = await liveSchool();
    const t1 = snap.teachers[0]!; // Іваненко: 5-А математика пн–чт урок 1
    const res = await ctx.as(id, 'POST', '/absences', { teacher_id: t1.teacher_id, date_from: '2026-11-16', date_to: '2026-11-22' });
    expect(res.statusCode).toBe(202);
    const { absence_id, job_ids } = res.json();
    expect(job_ids).toHaveLength(4);
    const events = await ctx.events(id, 'solve.substitution.requested');
    expect(events).toHaveLength(4);
    expect(events[0]!.data).toMatchObject({
      date: '2026-11-16',
      absence_dates: ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'],
      absent_teacher_id: t1.teacher_id,
      lessons: [{ class_id: snap.classes[0]!.class_id, lesson_no: 1 }],
      not_before: '2026-11-16',
      iso_week: '2026-W47',
      template: { kind: 'main' },
      approved_substitutions: [],
    });
    expect(JSON.stringify(events)).not.toContain('Іваненко');
    const list = (await ctx.as(id, 'GET', '/absences')).json();
    expect(list).toEqual([expect.objectContaining({ absence_id, teacher_id: t1.teacher_id, lesson_nos: null, jobs: expect.arrayContaining([expect.objectContaining({ state: 'queued' })]) })]);
  });

  test('валідація: минула дата, from > to, задовгий період, невідомий вчитель, немає уроків → 422', async () => {
    const { id, snap } = await liveSchool();
    const t = snap.teachers[0]!.teacher_id;
    const cases: [Record<string, unknown>, string][] = [
      [{ teacher_id: t, date_from: '2026-11-13', date_to: '2026-11-16' }, 'invalid_date'],
      [{ teacher_id: t, date_from: '2026-11-18', date_to: '2026-11-17' }, 'invalid_date'],
      [{ teacher_id: t, date_from: '2026-11-16', date_to: '2027-01-30' }, 'invalid_date'],
      [{ teacher_id: uuid(), date_from: '2026-11-16', date_to: '2026-11-16' }, 'teacher_not_found'],
      [{ teacher_id: t, date_from: '2026-11-20', date_to: '2026-11-20' }, 'no_lessons'],
      [{ teacher_id: t, date_from: '2026-11-16', date_to: '2026-11-16', lesson_nos: [3] }, 'no_lessons'],
    ];
    for (const [body, code] of cases) expect((await ctx.as(id, 'POST', '/absences', body)).json(), JSON.stringify(body)).toMatchObject({ code });
  });
});

describe('пропозиції й погодження', () => {
  test('вчитель того ж формату → погодження → накладка на сторінках за QR; повторне погодження → 409', async () => {
    const { id, snap } = await liveSchool();
    const [t1, t2] = snap.teachers;
    const cls = snap.classes[0]!;
    const { job_ids } = (await ctx.as(id, 'POST', '/absences', { teacher_id: t1!.teacher_id, date_from: '2026-11-16', date_to: '2026-11-16' })).json();
    const jobId = job_ids[0];
    expect((await ctx.as(id, 'POST', `/substitutions/${jobId}:approve`, {})).json()).toMatchObject({ code: 'job_not_ready' });
    // Петренко (5-А укр, уроки 2) вільний на уроці 1 і в очному форматі того дня.
    await complete(id, jobId, [{ class_id: cls.class_id, lesson_no: 1, kind: 'teacher', teacher_id: t2!.teacher_id, off_profile: true }]);
    const job = (await ctx.as(id, 'GET', `/jobs/${jobId}`)).json();
    expect(job).toMatchObject({ state: 'done', result: { proposals: [expect.objectContaining({ kind: 'teacher', new_teacher_id: t2!.teacher_id, off_profile: true, step: 1, state: 'proposed' })] } });
    const list = (await ctx.as(id, 'GET', '/substitutions?date=2026-11-16')).json();
    expect(list).toEqual([expect.objectContaining({ job_id: jobId, class_id: cls.class_id, lesson_no: 1, kind: 'teacher', state: 'proposed', moved_to: null })]);

    const approved = await ctx.as(id, 'POST', `/substitutions/${jobId}:approve`, {});
    expect(approved.statusCode).toBe(200);
    expect(approved.json()[0]).toMatchObject({ state: 'approved' });
    expect((await ctx.as(id, 'POST', `/substitutions/${jobId}:approve`, {})).json()).toMatchObject({ code: 'job_not_ready' });

    const classToken = (await ctx.as(id, 'GET', '/access-tokens?type=class')).json().find((t: { target_id: string }) => t.target_id === cls.class_id);
    const classPage = (await ctx.app.inject({ method: 'GET', url: '/api/v1/public/timetable', headers: { 'x-access-token': classToken.url.split('#')[1] } })).json();
    expect(classPage.weeks[0].days[0].lessons[0]).toMatchObject({ lesson_no: 1, subject: 'Математика', substitution: true });
    expect(JSON.stringify(classPage)).not.toContain('Петренко');
    const teachers = (await ctx.as(id, 'GET', '/access-tokens?type=teacher')).json();
    const page = async (teacherId: string) =>
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/public/timetable',
          headers: { 'x-access-token': teachers.find((t: { target_id: string }) => t.target_id === teacherId).url.split('#')[1] },
        })
      ).json();
    const petrenko = await page(t2!.teacher_id);
    expect(petrenko.weeks[0].days[0].lessons).toContainEqual(expect.objectContaining({ lesson_no: 1, class_name: '5-А', substitution: true }));
    const ivanenko = await page(t1!.teacher_id);
    expect(ivanenko.weeks[0].days[0].lessons.some((l: { lesson_no: number; class_name: string }) => l.lesson_no === 1 && l.class_name === '5-А')).toBe(false);

    const actions = (await ctx.events(id, 'audit.recorded')).map((e) => e.data.action);
    expect(actions).toEqual(expect.arrayContaining(['absence_recorded', 'substitution_approved']));
  });

  test('зайнятий вчитель, недоступний день, понад ліміт → 409 conflicts; самостійна робота → скасовано', async () => {
    const { id, snap } = await liveSchool();
    const [t1, t2] = snap.teachers;
    const cls = snap.classes[0]!;
    const absence = async (date: string) => (await ctx.as(id, 'POST', '/absences', { teacher_id: t1!.teacher_id, date_from: date, date_to: date })).json().job_ids[0];

    // Коваль (t4) у вівторок на уроці 1 веде 9-Б — пропозиція на урок 1 5-А дає накладку.
    const t4 = snap.teachers[3]!;
    const busyJob = await absence('2026-11-17');
    await complete(id, busyJob, [{ class_id: cls.class_id, lesson_no: 1, kind: 'teacher', teacher_id: t4.teacher_id }]);
    const busy = await ctx.as(id, 'POST', `/substitutions/${busyJob}:approve`, {});
    expect(busy.statusCode).toBe(409);
    expect(busy.json().conflicts).toContainEqual(expect.objectContaining({ rule: 'teacher_double_booked', teacher_id: t4.teacher_id, lesson_no: 1 }));

    const unknownJob = await absence('2026-11-18');
    await complete(id, unknownJob, [{ class_id: cls.class_id, lesson_no: 1, kind: 'teacher', teacher_id: uuid() }]);
    expect((await ctx.as(id, 'POST', `/substitutions/${unknownJob}:approve`, {})).json().conflicts).toContainEqual(expect.objectContaining({ rule: 'teacher_not_active' }));

    // Без пропозиції урок стає «самостійною роботою»; у тілі :approve її можна замінити на «скасовано».
    const selfJob = await absence('2026-11-19');
    await complete(id, selfJob, [], 3);
    const proposals = (await ctx.as(id, 'GET', `/jobs/${selfJob}`)).json().result.proposals;
    expect(proposals).toEqual([expect.objectContaining({ kind: 'self_study', step: 3 })]);
    const res = await ctx.as(id, 'POST', `/substitutions/${selfJob}:approve`, { cancel: [{ class_id: cls.class_id, lesson_no: 1 }] });
    expect(res.json()[0]).toMatchObject({ kind: 'cancelled', state: 'approved' });
    void t2;
  });

  test('недоступний день і перевищення тижневого ліміту', async () => {
    const { id, snap } = await liveSchool();
    const [t1, t2] = snap.teachers;
    snap.teachers[1]!.unavailable_days = [1];
    snap.teachers[1]!.weekly_hours_limit = 3;
    const jobId = (await ctx.as(id, 'POST', '/absences', { teacher_id: t1!.teacher_id, date_from: '2026-11-16', date_to: '2026-11-16' })).json().job_ids[0];
    await complete(id, jobId, [{ class_id: snap.classes[0]!.class_id, lesson_no: 1, kind: 'teacher', teacher_id: t2!.teacher_id }]);
    const rules = (await ctx.as(id, 'POST', `/substitutions/${jobId}:approve`, {})).json().conflicts.map((c: { rule: string }) => c.rule);
    expect(rules).toEqual(expect.arrayContaining(['teacher_unavailable_day', 'teacher_weekly_limit']));
  });

  test('перенесений урок і зламана пропозиція (без teacher_id → самостійна робота)', async () => {
    const { id, snap } = await liveSchool();
    const t1 = snap.teachers[0]!;
    const cls = snap.classes[0]!;
    const jobId = (await ctx.as(id, 'POST', '/absences', { teacher_id: t1.teacher_id, date_from: '2026-11-16', date_to: '2026-11-16' })).json().job_ids[0];
    await complete(id, jobId, [{ class_id: cls.class_id, lesson_no: 1, kind: 'moved', moved_to: { date: '2026-11-20', lesson_no: 1 } }], 3);
    const [p] = (await ctx.as(id, 'GET', '/substitutions?date=2026-11-16')).json();
    expect(p).toMatchObject({ kind: 'moved', moved_to: { date: '2026-11-20', lesson_no: 1 } });
    expect((await ctx.as(id, 'POST', `/substitutions/${jobId}:approve`, {})).statusCode).toBe(200);
    const token = (await ctx.as(id, 'GET', '/access-tokens?type=class')).json().find((t: { target_id: string }) => t.target_id === cls.class_id);
    const page = (await ctx.app.inject({ method: 'GET', url: '/api/v1/public/timetable', headers: { 'x-access-token': token.url.split('#')[1] } })).json();
    const [mon, , , , fri] = page.weeks[0].days;
    expect(mon.lessons.some((l: { lesson_no: number }) => l.lesson_no === 1)).toBe(false);
    expect(fri.lessons).toContainEqual(expect.objectContaining({ lesson_no: 1, subject: 'Математика', substitution: true }));

    const job2 = (await ctx.as(id, 'POST', '/absences', { teacher_id: t1.teacher_id, date_from: '2026-11-17', date_to: '2026-11-17' })).json().job_ids[0];
    await complete(id, job2, [{ class_id: cls.class_id, lesson_no: 1, kind: 'teacher' }]);
    expect((await ctx.as(id, 'GET', '/substitutions?date=2026-11-17')).json()[0]).toMatchObject({ kind: 'self_study' });
  });

  test(':reject, скасування відсутності знімає погоджені накладки', async () => {
    const { id, snap } = await liveSchool();
    const [t1, t2] = snap.teachers;
    const cls = snap.classes[0]!;
    const { absence_id, job_ids } = (await ctx.as(id, 'POST', '/absences', { teacher_id: t1!.teacher_id, date_from: '2026-11-16', date_to: '2026-11-17' })).json();
    await complete(id, job_ids[0], [{ class_id: cls.class_id, lesson_no: 1, kind: 'teacher', teacher_id: t2!.teacher_id }]);
    await complete(id, job_ids[1], [{ class_id: cls.class_id, lesson_no: 1, kind: 'teacher', teacher_id: t2!.teacher_id }]);
    expect((await ctx.as(id, 'POST', `/substitutions/${job_ids[1]}:reject`)).json()[0]).toMatchObject({ state: 'rejected' });
    await ctx.as(id, 'POST', `/substitutions/${job_ids[0]}:approve`, {});
    expect((await ctx.as(id, 'DELETE', `/absences/${absence_id}`)).json()).toEqual({ cancelled: true });
    expect((await ctx.as(id, 'GET', '/substitutions?date=2026-11-16')).json()[0]).toMatchObject({ state: 'rejected' });
    expect((await ctx.as(id, 'GET', '/absences')).json()).toEqual([]);
    expect((await ctx.as(id, 'DELETE', `/absences/${absence_id}`)).statusCode).toBe(200);
    expect((await ctx.as(id, 'DELETE', `/absences/${uuid()}`)).statusCode).toBe(404);
    expect((await ctx.as(id, 'POST', `/substitutions/${uuid()}:reject`)).statusCode).toBe(404);
    expect((await ctx.as(id, 'POST', `/substitutions/${uuid()}:approve`, {})).statusCode).toBe(404);
    expect((await ctx.as(id, 'GET', '/substitutions?date=2026-13-01')).statusCode).toBe(422);
  });

  test('пропозиції задачі, чию відсутність скасовано до результату, зберігаються як rejected', async () => {
    const { id, snap } = await liveSchool();
    const { absence_id, job_ids } = (await ctx.as(id, 'POST', '/absences', { teacher_id: snap.teachers[0]!.teacher_id, date_from: '2026-11-16', date_to: '2026-11-16' })).json();
    await ctx.as(id, 'DELETE', `/absences/${absence_id}`);
    await complete(id, job_ids[0], []);
    expect((await ctx.as(id, 'GET', '/substitutions?date=2026-11-16')).json()[0]).toMatchObject({ state: 'rejected' });
  });

  test('нова публікація: погоджені заміни старої версії → warnings.lost_substitutions', async () => {
    const { id, snap } = await liveSchool();
    const [t1, t2] = snap.teachers;
    const jobId = (await ctx.as(id, 'POST', '/absences', { teacher_id: t1!.teacher_id, date_from: '2026-11-26', date_to: '2026-11-26' })).json().job_ids[0];
    await complete(id, jobId, [{ class_id: snap.classes[0]!.class_id, lesson_no: 1, kind: 'teacher', teacher_id: t2!.teacher_id }]);
    await ctx.as(id, 'POST', `/substitutions/${jobId}:approve`, {});
    const next = (await ctx.build(id)).job.result.timetable_id;
    const res = await ctx.as(id, 'POST', `/timetables/${next}:publish`, { ...ORDER, effective_from: '2026-11-23' });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings.lost_substitutions).toEqual([{ date: '2026-11-26', class_id: snap.classes[0]!.class_id, lesson_no: 1 }]);
  });
});

describe('експорт вчителя (етап 2)', () => {
  test('уроки у версіях, відсутності без причини, заміни; запис у журнал', async () => {
    const { id, snap } = await liveSchool();
    const t1 = snap.teachers[0]!;
    await ctx.as(id, 'POST', '/absences', { teacher_id: t1.teacher_id, date_from: '2026-11-16', date_to: '2026-11-16' });
    const res = await ctx.as(id, 'GET', `/teachers/${t1.teacher_id}/export`);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toMatchObject({ source: 'timetable-service', teacher_id: t1.teacher_id });
    expect(body.lessons.length).toBe(4);
    expect(body.absences).toEqual([expect.objectContaining({ date_from: '2026-11-16', cancelled_at: null })]);
    expect(Object.keys(body.absences[0])).not.toContain('reason');
    expect((await ctx.events(id, 'audit.recorded')).map((e) => e.data.action)).toContain('teacher_exported');
  });
});
