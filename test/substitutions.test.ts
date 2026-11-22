// Етап 2: відсутності, задачі замін (contracts 0.5.0), вердикт validator-lib, погодження, сторінки за QR, експорт.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Envelope } from '../src/db/events.js';
import { handleSolveStatus } from '../src/domain/jobs.js';
import { contractsDir, contractsValidator, ORDER, testApp, uuid, type TestCtx } from './helpers.js';

let ctx: TestCtx;
const schema = contractsValidator();
beforeAll(async () => {
  ctx = await testApp();
});
afterAll(() => ctx.close());

/**
 * Тестовий заклад після побудови заглушкою (4 уроки, пн–пт):
 *   5-А: Іваненко (t1) математика пн–чт урок 1; Петренко (t2) українська пн–ср урок 2; пт — дистанційно (уроків немає);
 *   9-Б: Коваль (t4) математика пн–ср урок 1; Сидоренко (t3) фізкультура пн–ср урок 2.
 * Опубліковано з понеділка 16.11; «сьогодні» — той самий понеділок, щоб розклад діяв.
 */
async function liveSchool() {
  ctx.clock.now = new Date('2026-11-09T10:00:00Z');
  const s = ctx.newSchool();
  const built = await ctx.build(s.id);
  await ctx.as(s.id, 'POST', `/timetables/${built.job.result.timetable_id}:publish`, { ...ORDER, effective_from: '2026-11-16' });
  ctx.clock.now = new Date('2026-11-16T06:00:00Z');
  const [t1, t2, t3, t4] = s.snap.teachers.map((t) => t.teacher_id) as [string, string, string, string];
  const [c1, c2] = s.snap.classes.map((c) => c.class_id) as [string, string];
  return { ...s, tt: built.job.result.timetable_id, lessons: built.result.lessons, t1, t2, t3, t4, c1, c2 };
}

afterAll(() => {
  ctx.clock.now = new Date('2026-11-09T10:00:00Z');
});

type Req = { job_id: string; date: string; lessons: { class_id: string; lesson_no: number }[] } & Record<string, unknown>;
const request = async (schoolId: string, jobId: string): Promise<Req> =>
  (await ctx.events(schoolId, 'solve.substitution.requested')).map((e) => e.data as Req).find((d) => d.job_id === jobId)!;

const example = JSON.parse(readFileSync(join(contractsDir(), 'examples', 'solve.status.v1', 'completed-substitution.json'), 'utf8')) as Envelope;

/**
 * solve.completed задачі заміни з прикладу contracts (completed-substitution.json) з пропозиціями тесту.
 * Пропозиція без date отримує дату задачі, без step — 1. Подія перевіряється схемою solve.status.v1,
 * якщо тест не перевіряє навмисно зламаний результат (raw).
 */
async function complete(schoolId: string, jobId: string, proposals: Record<string, unknown>[], opts: { raw?: boolean } = {}) {
  const req = await request(schoolId, jobId);
  const full = opts.raw ? proposals : proposals.map((p) => ({ date: req.date, step: 1, ...(p.kind === 'teacher' ? { off_profile: false } : {}), ...p }));
  const steps = full.map((p) => (typeof p.step === 'number' ? p.step : 1));
  const event: Envelope = {
    ...structuredClone(example),
    event_id: uuid(),
    school_id: schoolId,
    time: ctx.clock.now.toISOString(),
    data: { ...structuredClone(example.data), job_id: jobId, substitution: { step: Math.max(1, ...steps), proposals: full } },
  };
  if (!opts.raw) {
    const validate = schema('solve.status.v1.json');
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  }
  await handleSolveStatus(ctx.deps, event);
  return (await ctx.as(schoolId, 'GET', `/jobs/${jobId}`)).json();
}

/** Відсутність і її задачі. */
const absent = async (schoolId: string, body: Record<string, unknown>) => {
  const res = await ctx.as(schoolId, 'POST', '/absences', body);
  expect(res.statusCode, res.body).toBe(202);
  return res.json() as { absence_id: string; job_ids: string[] };
};

describe('відсутності', () => {
  test('по задачі на кожну навчальну дату з уроками; payload за contracts 0.5.0; без причини', async () => {
    const { id, snap, t1, c1 } = await liveSchool();
    const { absence_id, job_ids } = await absent(id, { teacher_id: t1, date_from: '2026-11-16', date_to: '2026-11-22' });
    expect(job_ids).toHaveLength(4);
    const events = await ctx.events(id, 'solve.substitution.requested');
    expect(events).toHaveLength(4);
    const validate = schema('solve.substitution.requested.v1.json');
    for (const e of events) expect(validate(e), JSON.stringify(validate.errors)).toBe(true);
    expect(events[0]!.data).toMatchObject({
      date: '2026-11-16',
      absence_dates: ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'],
      absent_teacher_id: t1,
      lessons: [{ class_id: c1, lesson_no: 1 }],
      not_before: '2026-11-16',
      iso_week: '2026-W47',
      template: { kind: 'main' },
      approved_substitutions: [],
      non_school_dates: [],
      allow_support_moves: false,
    });
    // Усі відсутності тижня, по рядку на вчителя й дату (null — увесь день).
    expect(events[0]!.data.absences).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'].map((date) => ({ teacher_id: t1, date, lesson_nos: null })));
    expect(JSON.stringify(events)).not.toContain('Іваненко');
    const list = (await ctx.as(id, 'GET', '/absences')).json();
    expect(list).toEqual([expect.objectContaining({ absence_id, teacher_id: t1, lesson_nos: null, jobs: expect.arrayContaining([expect.objectContaining({ state: 'queued' })]) })]);
    void snap;
  });

  test('payload: погоджені накладки тижня будь-якого виду, відсутності інших вчителів, свята тижня (Z3-2, Z3-3)', async () => {
    const { id, t1, t2, t4, c1 } = await liveSchool();
    expect((await ctx.as(id, 'PUT', '/holidays', { holiday_from: '2026-11-20', holiday_to: '2026-11-24' })).statusCode).toBe(200);
    // Іваненко відсутній лише на уроці 1: крок 2 переносить урок на урок 3 того ж дня.
    const first = (await absent(id, { teacher_id: t1, date_from: '2026-11-16', date_to: '2026-11-16', lesson_nos: [1] })).job_ids[0]!;
    const moved = await complete(id, first, [{ class_id: c1, lesson_no: 1, kind: 'moved', moved_to: { date: '2026-11-16', lesson_no: 3 }, step: 2 }]);
    expect(moved.state, JSON.stringify(moved.conflicts)).toBe('done');
    expect((await ctx.as(id, 'POST', `/substitutions/${first}:approve`, {})).statusCode).toBe(200);

    const { job_ids } = await absent(id, { teacher_id: t2, date_from: '2026-11-17', date_to: '2026-11-17', lesson_nos: [2] });
    const req = await request(id, job_ids[0]!);
    expect(req).toMatchObject({
      date: '2026-11-17',
      non_school_dates: ['2026-11-20'],
      approved_substitutions: [{ date: '2026-11-16', class_id: c1, lesson_no: 1, kind: 'moved', moved_to: { date: '2026-11-16', lesson_no: 3 } }],
    });
    expect(req.approved_substitutions).toEqual([expect.not.objectContaining({ teacher_id: expect.anything() })]);
    expect(req.absences).toEqual([
      { teacher_id: t1, date: '2026-11-16', lesson_nos: [1] },
      { teacher_id: t2, date: '2026-11-17', lesson_nos: [2] },
    ]);
    // Свято — не в межах вікна кроку 3: перенос туди є зламаним результатом.
    const job = await complete(id, job_ids[0]!, [{ class_id: req.lessons[0]!.class_id, lesson_no: 2, kind: 'moved', moved_to: { date: '2026-11-20', lesson_no: 2 }, step: 3 }]);
    expect(job).toMatchObject({ state: 'failed', error: 'invalid_result' });
    void t4;
  });

  test('валідація: минула дата, from > to, задовгий період, невідомий вчитель, немає уроків → 422', async () => {
    const { id, t1 } = await liveSchool();
    const cases: [Record<string, unknown>, string][] = [
      [{ teacher_id: t1, date_from: '2026-11-13', date_to: '2026-11-16' }, 'invalid_date'],
      [{ teacher_id: t1, date_from: '2026-11-18', date_to: '2026-11-17' }, 'invalid_date'],
      [{ teacher_id: t1, date_from: '2026-11-16', date_to: '2027-01-30' }, 'invalid_date'],
      [{ teacher_id: uuid(), date_from: '2026-11-16', date_to: '2026-11-16' }, 'teacher_not_found'],
      [{ teacher_id: t1, date_from: '2026-11-20', date_to: '2026-11-20' }, 'no_lessons'],
      [{ teacher_id: t1, date_from: '2026-11-16', date_to: '2026-11-16', lesson_nos: [3] }, 'no_lessons'],
    ];
    for (const [body, code] of cases) expect((await ctx.as(id, 'POST', '/absences', body)).json(), JSON.stringify(body)).toMatchObject({ code });
    expect((await ctx.as(id, 'GET', '/absences')).json()).toEqual([]);
  });

  test('урок, уже закритий погодженою заміною, у нову задачу не йде (Z3-5)', async () => {
    const { id, t1, t2, c1 } = await liveSchool();
    const first = (await absent(id, { teacher_id: t1, date_from: '2026-11-16', date_to: '2026-11-16', lesson_nos: [1] })).job_ids[0]!;
    await complete(id, first, [{ class_id: c1, lesson_no: 1, kind: 'teacher', teacher_id: t2 }]);
    expect((await ctx.as(id, 'POST', `/substitutions/${first}:approve`, {})).statusCode).toBe(200);
    // Відсутність продовжили на весь день і вівторок: понеділок уже закрито, задача лише на вівторок.
    const { job_ids } = await absent(id, { teacher_id: t1, date_from: '2026-11-16', date_to: '2026-11-17' });
    expect(job_ids).toHaveLength(1);
    const req = await request(id, job_ids[0]!);
    expect(req).toMatchObject({ date: '2026-11-17', lessons: [{ class_id: c1, lesson_no: 1 }] });
    expect(req.approved_substitutions).toEqual([expect.objectContaining({ date: '2026-11-16', class_id: c1, lesson_no: 1, kind: 'teacher', teacher_id: t2 })]);
    expect(schema('solve.substitution.requested.v1.json')((await ctx.events(id, 'solve.substitution.requested')).at(-1))).toBe(true);
  });

  test('вчитель, погоджений замісником у відсутні години → 409 teacher_is_substitute (Z3-6)', async () => {
    const { id, t1, t2, c1 } = await liveSchool();
    const first = (await absent(id, { teacher_id: t1, date_from: '2026-11-16', date_to: '2026-11-16' })).job_ids[0]!;
    await complete(id, first, [{ class_id: c1, lesson_no: 1, kind: 'teacher', teacher_id: t2 }]);
    await ctx.as(id, 'POST', `/substitutions/${first}:approve`, {});
    const res = await ctx.as(id, 'POST', '/absences', { teacher_id: t2, date_from: '2026-11-16', date_to: '2026-11-16' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'teacher_is_substitute', lessons: [{ date: '2026-11-16', class_id: c1, lesson_no: 1 }] });
    expect((await ctx.as(id, 'GET', '/absences')).json()).toHaveLength(1);
    // Лише на власний урок 2 — можна.
    const { job_ids } = await absent(id, { teacher_id: t2, date_from: '2026-11-16', date_to: '2026-11-16', lesson_nos: [2] });
    expect((await request(id, job_ids[0]!)).lessons).toEqual([{ class_id: c1, lesson_no: 2 }]);
  });
});

describe('результат solver і вердикт validator-lib', () => {
  test('зламаний результат → failed invalid_result, пропозиції не зберігаються (Z3-13)', async () => {
    const { id, t1, t2, c1, c2 } = await liveSchool();
    const job = async (date: string) => (await absent(id, { teacher_id: t1, date_from: date, date_to: date })).job_ids[0]!;
    const broken: [string, Record<string, unknown>[]][] = [
      ['немає пропозиції на урок', []],
      ['teacher без teacher_id', [{ class_id: c1, lesson_no: 1, kind: 'teacher' }]],
      ['чужа дата', [{ date: '2026-11-17', class_id: c1, lesson_no: 1, kind: 'self_study', step: 2 }]],
      ['рядок поза уроками задачі', [{ class_id: c1, lesson_no: 1, kind: 'self_study', step: 2 }, { class_id: c2, lesson_no: 1, kind: 'teacher', teacher_id: t2 }]],
      ['урок двічі', [{ class_id: c1, lesson_no: 1, kind: 'self_study', step: 2 }, { class_id: c1, lesson_no: 1, kind: 'teacher', teacher_id: t2, off_profile: false }]],
      ['перенос за межі тижня', [{ class_id: c1, lesson_no: 1, kind: 'moved', moved_to: { date: '2026-11-23', lesson_no: 1 }, step: 3 }]],
      ['перенос у минуле', [{ class_id: c1, lesson_no: 1, kind: 'moved', moved_to: { date: '2026-11-13', lesson_no: 1 }, step: 3 }]],
    ];
    for (const [name, proposals] of broken) {
      const jobId = await job('2026-11-18');
      const raw = name === 'teacher без teacher_id' || name === 'урок двічі';
      const done = await complete(id, jobId, proposals.map((p) => ({ date: '2026-11-18', step: 1, ...p })), { raw });
      // Пропозиція не за схемою contracts (teacher без teacher_id) ловиться ще перевіркою події (#2).
      expect(done, name).toMatchObject({ state: 'failed', error: name === 'teacher без teacher_id' ? 'invalid_event' : 'invalid_result' });
      expect((await ctx.as(id, 'GET', '/substitutions?date=2026-11-18')).json(), name).toEqual([]);
      const { absence_id } = (await ctx.as(id, 'GET', '/absences')).json()[0];
      await ctx.as(id, 'DELETE', `/absences/${absence_id}`);
    }
  });

  test('пропозиція з новим конфліктом → задача rejected з conflicts, пропозиції rejected', async () => {
    const { id, t1, t4, c1 } = await liveSchool();
    // Коваль (t4) у вівторок на уроці 1 веде 9-Б.
    const busyJob = (await absent(id, { teacher_id: t1, date_from: '2026-11-17', date_to: '2026-11-17' })).job_ids[0]!;
    const job = await complete(id, busyJob, [{ class_id: c1, lesson_no: 1, kind: 'teacher', teacher_id: t4 }]);
    expect(job).toMatchObject({ state: 'rejected', error: 'validator_rejected' });
    expect(job.conflicts).toContainEqual(expect.objectContaining({ rule: 'teacher_double_booked', teacher_id: t4, lesson_no: 1 }));
    expect(job.result.proposals).toEqual([expect.objectContaining({ kind: 'teacher', state: 'rejected' })]);
    expect((await ctx.as(id, 'POST', `/substitutions/${busyJob}:approve`, {})).json()).toMatchObject({ code: 'job_not_ready' });

    const unknownJob = (await absent(id, { teacher_id: t1, date_from: '2026-11-18', date_to: '2026-11-18' })).job_ids[0]!;
    const unknown = await complete(id, unknownJob, [{ class_id: c1, lesson_no: 1, kind: 'teacher', teacher_id: uuid() }]);
    expect(unknown.state).toBe('rejected');
    expect(unknown.conflicts).toContainEqual(expect.objectContaining({ rule: 'teacher_not_active' }));
  });

  test('недоступний день і перевищення тижневого ліміту замісника → rejected', async () => {
    const { id, snap, t1, t2, c1 } = await liveSchool();
    snap.teachers[1]!.unavailable_days = [1];
    snap.teachers[1]!.weekly_hours_limit = 3;
    const jobId = (await absent(id, { teacher_id: t1, date_from: '2026-11-16', date_to: '2026-11-16' })).job_ids[0]!;
    const job = await complete(id, jobId, [{ class_id: c1, lesson_no: 1, kind: 'teacher', teacher_id: t2 }]);
    expect(job.state).toBe('rejected');
    expect(job.conflicts.map((c: { rule: string }) => c.rule)).toEqual(expect.arrayContaining(['teacher_unavailable_day', 'teacher_weekly_limit']));
  });
});

describe('пропозиції й погодження', () => {
  test('вчитель того ж формату → погодження → накладка на сторінках за QR; повторне погодження → 409', async () => {
    const { id, t1, t2, c1 } = await liveSchool();
    const { job_ids } = await absent(id, { teacher_id: t1, date_from: '2026-11-16', date_to: '2026-11-16' });
    const jobId = job_ids[0]!;
    expect((await ctx.as(id, 'POST', `/substitutions/${jobId}:approve`, {})).json()).toMatchObject({ code: 'job_not_ready' });
    // Петренко (5-А укр, урок 2) вільний на уроці 1 і в очному форматі того дня.
    const job = await complete(id, jobId, [{ class_id: c1, lesson_no: 1, kind: 'teacher', teacher_id: t2, off_profile: true }]);
    expect(job).toMatchObject({ state: 'done', result: { proposals: [expect.objectContaining({ kind: 'teacher', new_teacher_id: t2, off_profile: true, step: 1, state: 'proposed' })] } });
    const list = (await ctx.as(id, 'GET', '/substitutions?date=2026-11-16')).json();
    expect(list).toEqual([expect.objectContaining({ job_id: jobId, class_id: c1, lesson_no: 1, kind: 'teacher', state: 'proposed', moved_to: null })]);

    const approved = await ctx.as(id, 'POST', `/substitutions/${jobId}:approve`, {});
    expect(approved.statusCode).toBe(200);
    expect(approved.json()[0]).toMatchObject({ state: 'approved' });
    expect((await ctx.as(id, 'POST', `/substitutions/${jobId}:approve`, {})).json()).toMatchObject({ code: 'job_not_ready' });

    const classToken = (await ctx.as(id, 'GET', '/access-tokens?type=class')).json().find((t: { target_id: string }) => t.target_id === c1);
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
    const petrenko = await page(t2);
    expect(petrenko.weeks[0].days[0].lessons).toContainEqual(expect.objectContaining({ lesson_no: 1, class_name: '5-А', substitution: true }));
    const ivanenko = await page(t1);
    expect(ivanenko.weeks[0].days[0].lessons.some((l: { lesson_no: number; class_name: string }) => l.lesson_no === 1 && l.class_name === '5-А')).toBe(false);

    const actions = (await ctx.events(id, 'audit.recorded')).map((e) => e.data.action);
    expect(actions).toEqual(expect.arrayContaining(['absence_recorded', 'substitution_approved']));
  });

  test(':approve перевіряє тиждень з уже погодженими накладками: два уроки класу в слоті, замісник двічі (Z1-3, Z3-4)', async () => {
    const { id, t1, t2, t4, c1, c2 } = await liveSchool();
    // Дві відсутності в понеділок, задачі пораховано незалежно: обидві пропозиції переносять урок 5-А на урок 3.
    const a = (await absent(id, { teacher_id: t1, date_from: '2026-11-16', date_to: '2026-11-16', lesson_nos: [1] })).job_ids[0]!;
    const b = (await absent(id, { teacher_id: t2, date_from: '2026-11-16', date_to: '2026-11-16', lesson_nos: [2] })).job_ids[0]!;
    expect((await complete(id, a, [{ class_id: c1, lesson_no: 1, kind: 'moved', moved_to: { date: '2026-11-16', lesson_no: 3 }, step: 2 }])).state).toBe('done');
    expect((await complete(id, b, [{ class_id: c1, lesson_no: 2, kind: 'moved', moved_to: { date: '2026-11-16', lesson_no: 3 }, step: 2 }])).state).toBe('done');
    expect((await ctx.as(id, 'POST', `/substitutions/${a}:approve`, {})).statusCode).toBe(200);
    const res = await ctx.as(id, 'POST', `/substitutions/${b}:approve`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'conflicts', conflicts: [expect.objectContaining({ rule: 'class_double_booked', class_id: c1, lesson_no: 3 })] });

    // Коваль (t4) відсутній у середу; Петренко веде 5-А урок 2 у середу, тож вільний на уроці 1 обох класів.
    const c = (await absent(id, { teacher_id: t4, date_from: '2026-11-18', date_to: '2026-11-18' })).job_ids[0]!;
    const d = (await absent(id, { teacher_id: t1, date_from: '2026-11-18', date_to: '2026-11-18' })).job_ids[0]!;
    expect((await complete(id, c, [{ class_id: c2, lesson_no: 1, kind: 'teacher', teacher_id: t2 }])).state).toBe('done');
    expect((await complete(id, d, [{ class_id: c1, lesson_no: 1, kind: 'teacher', teacher_id: t2 }])).state).toBe('done');
    expect((await ctx.as(id, 'POST', `/substitutions/${c}:approve`, {})).statusCode).toBe(200);
    const twice = await ctx.as(id, 'POST', `/substitutions/${d}:approve`, {});
    expect(twice.json().conflicts).toContainEqual(expect.objectContaining({ rule: 'teacher_double_booked', teacher_id: t2, lesson_no: 1 }));
  });

  test(':approve на минулу дату → 409 date_passed (Z3-7)', async () => {
    const { id, t1, t2, c1 } = await liveSchool();
    const { job_ids } = await absent(id, { teacher_id: t1, date_from: '2026-11-16', date_to: '2026-11-17' });
    await complete(id, job_ids[0]!, [{ class_id: c1, lesson_no: 1, kind: 'teacher', teacher_id: t2 }]);
    ctx.clock.now = new Date('2026-11-17T06:00:00Z');
    expect((await ctx.as(id, 'POST', `/substitutions/${job_ids[0]}:approve`, {})).json()).toMatchObject({ code: 'date_passed' });
  });

  test('самостійна робота → у тілі :approve можна «скасовано»', async () => {
    const { id, t1, c1 } = await liveSchool();
    const selfJob = (await absent(id, { teacher_id: t1, date_from: '2026-11-19', date_to: '2026-11-19' })).job_ids[0]!;
    const job = await complete(id, selfJob, [{ class_id: c1, lesson_no: 1, kind: 'self_study', step: 3 }]);
    expect(job.result.proposals).toEqual([expect.objectContaining({ kind: 'self_study', step: 3 })]);
    const res = await ctx.as(id, 'POST', `/substitutions/${selfJob}:approve`, { cancel: [{ class_id: c1, lesson_no: 1 }] });
    expect(res.json()[0]).toMatchObject({ kind: 'cancelled', state: 'approved' });
  });

  test('перенесений урок на іншу дату тижня → сторінка класу за QR', async () => {
    const { id, t1, c1 } = await liveSchool();
    const jobId = (await absent(id, { teacher_id: t1, date_from: '2026-11-16', date_to: '2026-11-16' })).job_ids[0]!;
    await complete(id, jobId, [{ class_id: c1, lesson_no: 1, kind: 'moved', moved_to: { date: '2026-11-20', lesson_no: 1 }, step: 3 }]);
    const [p] = (await ctx.as(id, 'GET', '/substitutions?date=2026-11-16')).json();
    expect(p).toMatchObject({ kind: 'moved', moved_to: { date: '2026-11-20', lesson_no: 1 }, step: 3 });
    // Той самий перенос видно й на дату, куди урок переїжджає (#6, п. 5).
    expect((await ctx.as(id, 'GET', '/substitutions?date=2026-11-20')).json()).toEqual([expect.objectContaining({ date: '2026-11-16', kind: 'moved', moved_to: { date: '2026-11-20', lesson_no: 1 } })]);
    expect((await ctx.as(id, 'POST', `/substitutions/${jobId}:approve`, {})).statusCode).toBe(200);
    const token = (await ctx.as(id, 'GET', '/access-tokens?type=class')).json().find((t: { target_id: string }) => t.target_id === c1);
    const page = (await ctx.app.inject({ method: 'GET', url: '/api/v1/public/timetable', headers: { 'x-access-token': token.url.split('#')[1] } })).json();
    const [mon, , , , fri] = page.weeks[0].days;
    expect(mon.lessons.some((l: { lesson_no: number }) => l.lesson_no === 1)).toBe(false);
    expect(fri.lessons).toContainEqual(expect.objectContaining({ lesson_no: 1, subject: 'Математика', substitution: true }));
  });

  test(':reject, скасування відсутності знімає погоджені накладки', async () => {
    const { id, t1, t2, c1 } = await liveSchool();
    const { absence_id, job_ids } = await absent(id, { teacher_id: t1, date_from: '2026-11-16', date_to: '2026-11-17' });
    await complete(id, job_ids[0]!, [{ class_id: c1, lesson_no: 1, kind: 'teacher', teacher_id: t2 }]);
    await complete(id, job_ids[1]!, [{ class_id: c1, lesson_no: 1, kind: 'teacher', teacher_id: t2 }]);
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
    const { id, t1, c1 } = await liveSchool();
    const { absence_id, job_ids } = await absent(id, { teacher_id: t1, date_from: '2026-11-16', date_to: '2026-11-16' });
    await ctx.as(id, 'DELETE', `/absences/${absence_id}`);
    await complete(id, job_ids[0]!, [{ class_id: c1, lesson_no: 1, kind: 'self_study', step: 2 }]);
    expect((await ctx.as(id, 'GET', '/substitutions?date=2026-11-16')).json()[0]).toMatchObject({ state: 'rejected' });
  });

  test('нова публікація: погоджені заміни старої версії → warnings.lost_substitutions', async () => {
    const { id, t1, t2, c1 } = await liveSchool();
    const jobId = (await absent(id, { teacher_id: t1, date_from: '2026-11-26', date_to: '2026-11-26' })).job_ids[0]!;
    await complete(id, jobId, [{ class_id: c1, lesson_no: 1, kind: 'teacher', teacher_id: t2 }]);
    await ctx.as(id, 'POST', `/substitutions/${jobId}:approve`, {});
    const next = (await ctx.build(id)).job.result.timetable_id;
    const res = await ctx.as(id, 'POST', `/timetables/${next}:publish`, { ...ORDER, effective_from: '2026-11-23' });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings.lost_substitutions).toEqual([{ date: '2026-11-26', class_id: c1, lesson_no: 1 }]);
  });
});

describe('публікація і заміни', () => {
  test('нова публікація замість запланованої: заміни запланованої версії → warnings.lost_substitutions (Z2-3)', async () => {
    ctx.clock.now = new Date('2026-11-09T10:00:00Z');
    const s = ctx.newSchool();
    const a = (await ctx.build(s.id)).job.result.timetable_id;
    await ctx.as(s.id, 'POST', `/timetables/${a}:publish`, { ...ORDER, effective_from: '2026-11-16' });
    const [t1, t2] = s.snap.teachers.map((t) => t.teacher_id);
    const c1 = s.snap.classes[0]!.class_id;
    const jobId = (await absent(s.id, { teacher_id: t1, date_from: '2026-11-17', date_to: '2026-11-17' })).job_ids[0]!;
    await complete(s.id, jobId, [{ class_id: c1, lesson_no: 1, kind: 'teacher', teacher_id: t2 }]);
    expect((await ctx.as(s.id, 'POST', `/substitutions/${jobId}:approve`, {})).statusCode).toBe(200);
    const b = (await ctx.build(s.id)).job.result.timetable_id;
    const res = await ctx.as(s.id, 'POST', `/timetables/${b}:publish`, { ...ORDER, effective_from: '2026-11-23' });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings.lost_substitutions).toEqual([{ date: '2026-11-17', class_id: c1, lesson_no: 1 }]);
  });

  test(':publish, коли обов\'язкове поле профілю обнулили після побудови → 422 profile_incomplete (Z5-2)', async () => {
    ctx.clock.now = new Date('2026-11-09T10:00:00Z');
    const s = ctx.newSchool();
    const tt = (await ctx.build(s.id)).job.result.timetable_id;
    s.snap.profile.shelter_capacity = null;
    s.snap.snapshot_version = 6;
    const res = await ctx.as(s.id, 'POST', `/timetables/${tt}:publish`, { ...ORDER, effective_from: '2026-11-16' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'profile_incomplete', fields: ['shelter_capacity'] });
  });
});

describe('експорт вчителя (етап 2)', () => {
  test('уроки у версіях, відсутності без причини, заміни; запис у журнал', async () => {
    const { id, t1: teacherId } = await liveSchool();
    const t1 = { teacher_id: teacherId };
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
