// Побудова (:build), задачі й solve.status, сторож, версії, /load, :publish (409 stale), :copy, PATCH.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { handleSolveStatus, runWatchdog } from '../src/domain/jobs.js';
import { maintDb, ORDER, PUBLISH_FROM, testApp, uuid, type TestCtx } from './helpers.js';
import type { Db } from '../src/db/index.js';

let ctx: TestCtx;
let maint: Db;
beforeAll(async () => {
  ctx = await testApp();
  maint = maintDb();
});
afterAll(async () => {
  await ctx.close();
  await maint.destroy();
});

/** Схеми contracts v0.2.0 (devDependency) — щоб подія timetable точно відповідала контракту. */
function contractsValidator() {
  const require = createRequire(import.meta.url);
  const dir = join(dirname(require.resolve('@lad/contracts/package.json')), 'schemas', 'events');
  const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
  for (const f of readdirSync(dir)) ajv.addSchema(JSON.parse(readFileSync(join(dir, f), 'utf8')));
  return (id: string) => ajv.getSchema(`https://lad.example/contracts/schemas/events/${id}`)!;
}

describe(':build', () => {
  test('202 + job_id; solve.build.requested відповідає contracts; без назв і підписів', async () => {
    const { id, snap } = ctx.newSchool();
    const res = await ctx.as(id, 'POST', '/timetables:build');
    expect(res.statusCode).toBe(202);
    const jobId = res.json().job_id;
    const [event] = await ctx.events(id, 'solve.build.requested');
    const validate = contractsValidator()('solve.build.requested.v1.json');
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    expect(event).toMatchObject({
      source: 'timetable-service',
      school_id: id,
      data: { job_id: jobId, kind: 'main', model: '1.1', snapshot_version: 5, time_limit_s: 60, school_days: [1, 2, 3, 4, 5], lessons_per_day: 4, staff: 5, capacity: { passport: 200 } },
    });
    expect(new Date(event!.data.queue_deadline_at as string).getTime() - ctx.clock.now.getTime()).toBe(600_000);
    const text = JSON.stringify(event);
    for (const t of snap.teachers) expect(text).not.toContain(t.label);
    for (const c of snap.classes) expect(text).not.toContain(c.name);
    // Пріоритетні галузі за МОН: математика й мова — так, фізкультура — ні.
    const subjects = event!.data.subjects as { id: string; priority_area: boolean; no_shelter: boolean }[];
    expect(subjects.map((s) => s.priority_area)).toEqual([true, true, false]);

    const job = (await ctx.as(id, 'GET', `/jobs/${jobId}`)).json();
    expect(job).toMatchObject({ job_id: jobId, kind: 'build_main', state: 'queued', snapshot_version: 5, started_at: null });
  });

  test('друга побудова, поки йде перша → 409 build_in_progress з job_id активної', async () => {
    const { id } = ctx.newSchool();
    const first = (await ctx.as(id, 'POST', '/timetables:build')).json().job_id;
    const second = await ctx.as(id, 'POST', '/timetables:build');
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'build_in_progress', job_id: first });
    await ctx.as(id, 'PUT', '/alert-plan/bells', [{ lesson_no: 1, start: '08:30', end: '09:00' }]);
    expect((await ctx.as(id, 'POST', '/alert-plan:build')).json()).toMatchObject({ code: 'build_in_progress', job_id: first });
  });

  test('неповний профіль → 422 profile_incomplete з переліком полів', async () => {
    const { id } = ctx.newSchool({ lessons_per_day: null, shelter_capacity: null });
    const res = await ctx.as(id, 'POST', '/timetables:build');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'profile_incomplete', fields: ['lessons_per_day', 'shelter_capacity'] });
  });

  test('передперевірка: персонал понад паспорт → одразу infeasible, у Kafka не йде', async () => {
    const { id } = ctx.newSchool({ shelter_capacity: 3 });
    const jobId = (await ctx.as(id, 'POST', '/timetables:build')).json().job_id;
    const job = (await ctx.as(id, 'GET', `/jobs/${jobId}`)).json();
    expect(job).toMatchObject({ state: 'infeasible', conflicts: [{ rule: 'staff_over_passport', condition: 'passport', value: 5, limit: 3 }] });
    expect(await ctx.events(id, 'solve.build.requested')).toEqual([]);
    expect((await ctx.as(id, 'POST', '/timetables:build')).statusCode).toBe(202);
  });

  test('передперевірка: годин класу більше за слоти, вчитель понад ліміт чи без доступних днів', async () => {
    const { id, snap } = ctx.newSchool({ lessons_per_day: 1 });
    snap.teachers[0]!.weekly_hours_limit = 2;
    snap.teachers[1]!.unavailable_days = [1, 2, 3, 4, 5];
    const jobId = (await ctx.as(id, 'POST', '/timetables:build')).json().job_id;
    const rules = (await ctx.as(id, 'GET', `/jobs/${jobId}`)).json().conflicts.map((c: { rule: string }) => c.rule);
    expect(rules).toEqual(expect.arrayContaining(['class_hours_exceed_slots', 'teacher_weekly_limit', 'teacher_unavailable_all_days']));
  });

  test('school-service недоступний → 503 school_unavailable', async () => {
    const { id } = ctx.newSchool();
    ctx.school.down = true;
    try {
      const res = await ctx.as(id, 'POST', '/timetables:build');
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'school_unavailable' });
    } finally {
      ctx.school.down = false;
    }
  });
});

describe('solve.status', () => {
  test('started → running, completed FEASIBLE → validator-lib ACCEPTED → версія validated', async () => {
    const { id, snap } = ctx.newSchool();
    const { jobId, job } = await ctx.build(id);
    expect(job).toMatchObject({ job_id: jobId, state: 'done', result: { timetable_id: expect.any(String) } });
    expect(job.started_at).not.toBeNull();
    const list = (await ctx.as(id, 'GET', '/timetables')).json();
    expect(list).toEqual([
      expect.objectContaining({ timetable_id: job.result.timetable_id, kind: 'main', model: '1.1', state: 'validated', effective_from: null, data_changed_since_build: false }),
    ]);
    const detail = (await ctx.as(id, 'GET', `/timetables/${job.result.timetable_id}`)).json();
    expect(detail.classes).toEqual(snap.classes.map((c) => ({ class_id: c.class_id, name: c.name })));
    expect(detail.teachers.map((t: { label: string }) => t.label)).toContain('Іваненко О. П.');
    expect(detail.lessons).toHaveLength(13);
    expect(detail.day_formats[0]).toEqual({ class_id: expect.any(String), day: expect.any(Number), format: expect.stringMatching(/in_person|remote/) });
  });

  test('розв’язок з порушенням → rejected зі звітом validator-lib', async () => {
    const { id } = ctx.newSchool();
    const { job } = await ctx.build(id, 'main', (r) => {
      r.lessons.pop();
    });
    expect(job.state).toBe('rejected');
    expect(job.error).toBe('validator_rejected');
    expect(job.conflicts.map((c: { rule: string }) => c.rule)).toContain('plan_hours_mismatch');
  });

  test('INFEASIBLE, UNKNOWN, MODEL_INVALID, EXPIRED → infeasible, timeout, failed, failed', async () => {
    const cases = [
      ['INFEASIBLE', 'infeasible'],
      ['UNKNOWN', 'timeout'],
      ['MODEL_INVALID', 'failed'],
      ['EXPIRED', 'failed'],
    ] as const;
    for (const [status, expected] of cases) {
      const { id } = ctx.newSchool();
      const jobId = (await ctx.as(id, 'POST', '/timetables:build')).json().job_id;
      await handleSolveStatus(
        ctx.deps,
        ctx.status(id, 'solve.completed', {
          job_id: jobId,
          status,
          lessons: [],
          day_formats: [],
          conflicts: status === 'INFEASIBLE' ? [{ rule: 'packing' }] : [],
          ...(status === 'MODEL_INVALID' ? { error: { code: 'invalid_payload' } } : {}),
        }),
      );
      const job = (await ctx.as(id, 'GET', `/jobs/${jobId}`)).json();
      expect(job.state, status).toBe(expected);
      if (status === 'INFEASIBLE') expect(job.conflicts).toEqual([{ rule: 'packing' }]);
      if (status === 'MODEL_INVALID') expect(job.error).toBe('invalid_payload');
    }
  });

  test('повтор event_id, started після кінцевого, completed для невідомої задачі — без змін', async () => {
    const { id } = ctx.newSchool();
    const jobId = (await ctx.as(id, 'POST', '/timetables:build')).json().job_id;
    const started = ctx.status(id, 'solve.started', { job_id: jobId, started_at: ctx.clock.now.toISOString() });
    expect(await handleSolveStatus(ctx.deps, started)).toBe('processed');
    expect(await handleSolveStatus(ctx.deps, started)).toBe('duplicate');
    expect(await handleSolveStatus(ctx.deps, ctx.status(id, 'solve.started', { job_id: jobId, started_at: ctx.clock.now.toISOString() }))).toBe('ignored');
    await handleSolveStatus(ctx.deps, ctx.status(id, 'solve.completed', { job_id: jobId, status: 'UNKNOWN', lessons: [], day_formats: [], conflicts: [] }));
    expect(await handleSolveStatus(ctx.deps, ctx.status(id, 'solve.completed', { job_id: jobId, status: 'FEASIBLE', lessons: [], day_formats: [], conflicts: [] }))).toBe('ignored');
    expect(await handleSolveStatus(ctx.deps, ctx.status(id, 'solve.completed', { job_id: uuid(), status: 'FEASIBLE' }))).toBe('ignored');
    expect((await ctx.as(id, 'GET', `/jobs/${jobId}`)).json().state).toBe('timeout');
  });

  test('зламаний solve.status — InvalidEventError (DLQ)', async () => {
    const { id } = ctx.newSchool();
    await expect(handleSolveStatus(ctx.deps, ctx.status(id, 'solve.completed', {}))).rejects.toThrow(/job_id/);
    await expect(handleSolveStatus(ctx.deps, ctx.status(id, 'solve.completed', { job_id: uuid(), status: 'MAYBE' }))).rejects.toThrow(/статус/);
    await expect(handleSolveStatus(ctx.deps, { ...ctx.status(id, 'solve.started', { job_id: uuid() }), type: 'solve.paused' })).rejects.toThrow(/тип/);
    await expect(handleSolveStatus(ctx.deps, ctx.status(id, 'solve.started', { job_id: uuid(), started_at: 'вчора' }))).rejects.toThrow(/started_at/);
  });
});

describe('сторож', () => {
  test('queued після queue_deadline_at і running після run_deadline_at → failed; пізній completed відкидається', async () => {
    const a = ctx.newSchool();
    const b = ctx.newSchool();
    const queued = (await ctx.as(a.id, 'POST', '/timetables:build')).json().job_id;
    const running = (await ctx.as(b.id, 'POST', '/timetables:build')).json().job_id;
    await handleSolveStatus(ctx.deps, ctx.status(b.id, 'solve.started', { job_id: running, started_at: ctx.clock.now.toISOString() }));
    // run_deadline_at = started + 60 + 90 с; queue_deadline_at = створення + 600 с.
    expect(await runWatchdog(maint, new Date(ctx.clock.now.getTime() + 149_000))).toBe(0);
    await runWatchdog(maint, new Date(ctx.clock.now.getTime() + 151_000));
    expect((await ctx.as(b.id, 'GET', `/jobs/${running}`)).json()).toMatchObject({ state: 'failed', error: 'deadline_exceeded' });
    expect((await ctx.as(a.id, 'GET', `/jobs/${queued}`)).json().state).toBe('queued');
    await runWatchdog(maint, new Date(ctx.clock.now.getTime() + 601_000));
    expect((await ctx.as(a.id, 'GET', `/jobs/${queued}`)).json().state).toBe('failed');
    expect(await handleSolveStatus(ctx.deps, ctx.status(b.id, 'solve.completed', { job_id: running, status: 'FEASIBLE', lessons: [], day_formats: [], conflicts: [] }))).toBe('ignored');
    // Після сторожа можна будувати знову.
    expect((await ctx.as(b.id, 'POST', '/timetables:build')).statusCode).toBe(202);
  });
});

describe('версії', () => {
  test('/load: навантаження по днях, причини форматів, підсумок, звіт перевірки', async () => {
    const { id } = ctx.newSchool();
    const { job } = await ctx.build(id);
    const load = (await ctx.as(id, 'GET', `/timetables/${job.result.timetable_id}/load`)).json();
    expect(load.model).toBe('1.1');
    expect(load.days).toHaveLength(5);
    expect(load.days[0]).toMatchObject({ day: 1, passport: { limit: 200, ok: true }, ok: true });
    expect(load.days[0].seats).toBeUndefined();
    expect(load.class_days[0]).toMatchObject({ format: expect.any(String), reason: expect.any(String) });
    expect(load.summary).toMatchObject({ build_ms: 1234, peak: { day: expect.any(Number), limit: 200 }, classes_without_in_person_days: [] });
    expect(load.validation).toEqual({ ok: true, conflicts: [] });
  });

  test('чужа або неіснуюча версія → 404; не-uuid → 404', async () => {
    const { id } = ctx.newSchool();
    const { job } = await ctx.build(id);
    const other = ctx.newSchool();
    expect((await ctx.as(other.id, 'GET', `/timetables/${job.result.timetable_id}`)).statusCode).toBe(404);
    expect((await ctx.as(other.id, 'GET', `/timetables/${job.result.timetable_id}/load`)).statusCode).toBe(404);
    expect((await ctx.as(id, 'GET', '/timetables/abc')).statusCode).toBe(404);
    expect((await ctx.as(id, 'POST', `/timetables/${job.result.timetable_id}:delete`)).statusCode).toBe(404);
    expect((await ctx.as(other.id, 'GET', `/jobs/${job.job_id}`)).statusCode).toBe(404);
  });
});

describe(':publish', () => {
  test('зарано, не навчальний день, погана дата → 422', async () => {
    const { id } = ctx.newSchool();
    const { job } = await ctx.build(id);
    const url = `/timetables/${job.result.timetable_id}:publish`;
    const early = await ctx.as(id, 'POST', url, { ...ORDER, effective_from: '2026-11-13' });
    expect(early.json()).toMatchObject({ code: 'effective_from_too_early', earliest: '2026-11-16' });
    expect((await ctx.as(id, 'POST', url, { ...ORDER, effective_from: '2026-11-21' })).json()).toMatchObject({ code: 'not_school_day' });
    expect((await ctx.as(id, 'POST', url, { ...ORDER, effective_from: '2026-02-30' })).json()).toMatchObject({ code: 'invalid_date' });
    expect((await ctx.as(id, 'POST', url, { ...ORDER })).statusCode).toBe(400);
  });

  test('публікація → published, фаза scheduled, audit.recorded, warnings.lost_substitutions = []', async () => {
    const { id } = ctx.newSchool();
    const { job } = await ctx.build(id);
    const res = await ctx.as(id, 'POST', `/timetables/${job.result.timetable_id}:publish`, { ...ORDER, effective_from: PUBLISH_FROM });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      timetable: { timetable_id: job.result.timetable_id, state: 'published', effective_from: PUBLISH_FROM, phase: 'scheduled' },
      warnings: { lost_substitutions: [] },
    });
    const detail = (await ctx.as(id, 'GET', `/timetables/${job.result.timetable_id}`)).json();
    expect(detail.order).toEqual({ order_no: '15-од', order_date: '2026-11-09', approved_by: 'Директор Коваль Н. В.' });
    const [audit] = await ctx.events(id, 'audit.recorded');
    expect(audit!.data).toMatchObject({ actor: 'demo', action: 'timetable_published', target: job.result.timetable_id, details: { effective_from: PUBLISH_FROM } });
    expect((await ctx.as(id, 'POST', `/timetables/${job.result.timetable_id}:publish`, { ...ORDER, effective_from: PUBLISH_FROM })).json()).toMatchObject({ code: 'already_published' });
  });

  test('нова публікація заміняє заплановану: та повертається у validated', async () => {
    const { id } = ctx.newSchool();
    const first = (await ctx.build(id)).job.result.timetable_id;
    await ctx.as(id, 'POST', `/timetables/${first}:publish`, { ...ORDER, effective_from: PUBLISH_FROM });
    const second = (await ctx.build(id)).job.result.timetable_id;
    await ctx.as(id, 'POST', `/timetables/${second}:publish`, { ...ORDER, effective_from: '2026-11-17' });
    const list = (await ctx.as(id, 'GET', '/timetables')).json();
    expect(list.find((v: { timetable_id: string }) => v.timetable_id === first)).toMatchObject({ state: 'validated', effective_from: null });
    expect(list.find((v: { timetable_id: string }) => v.timetable_id === second)).toMatchObject({ state: 'published', phase: 'scheduled' });
  });

  test('чинна, архівна й запланована фази обчислюються з дати', async () => {
    const { id } = ctx.newSchool();
    const a = (await ctx.build(id)).job.result.timetable_id;
    await ctx.as(id, 'POST', `/timetables/${a}:publish`, { ...ORDER, effective_from: PUBLISH_FROM });
    ctx.clock.now = new Date('2026-11-16T08:00:00Z');
    try {
      const b = (await ctx.build(id)).job.result.timetable_id;
      await ctx.as(id, 'POST', `/timetables/${b}:publish`, { ...ORDER, effective_from: '2026-11-23' });
      ctx.clock.now = new Date('2026-11-24T08:00:00Z');
      const list = (await ctx.as(id, 'GET', '/timetables')).json();
      expect(list.find((v: { timetable_id: string }) => v.timetable_id === a).phase).toBe('archived');
      expect(list.find((v: { timetable_id: string }) => v.timetable_id === b).phase).toBe('current');
    } finally {
      ctx.clock.now = new Date('2026-11-09T10:00:00Z');
    }
  });

  test('дані змінились і порушують версію → 409 stale з conflicts; змінились без порушень → публікується', async () => {
    const { id, snap } = ctx.newSchool();
    const tt = (await ctx.build(id)).job.result.timetable_id;
    snap.snapshot_version = 6;
    snap.profile.shelter_capacity = 40; // 28 + 25 учнів + 5 персоналу + вчителі > 40
    const res = await ctx.as(id, 'POST', `/timetables/${tt}:publish`, { ...ORDER, effective_from: PUBLISH_FROM });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'stale' });
    expect(res.json().conflicts.map((c: { rule: string }) => c.rule)).toContain('capacity_exceeded');
    snap.snapshot_version = 7;
    snap.profile.shelter_capacity = 500;
    expect((await ctx.as(id, 'POST', `/timetables/${tt}:publish`, { ...ORDER, effective_from: PUBLISH_FROM })).statusCode).toBe(200);
  });

  test('архівований клас після побудови → stale (class_not_active)', async () => {
    const { id, snap } = ctx.newSchool();
    const tt = (await ctx.build(id)).job.result.timetable_id;
    snap.snapshot_version = 6;
    snap.classes[1]!.archived_at = new Date().toISOString();
    const res = await ctx.as(id, 'POST', `/timetables/${tt}:publish`, { ...ORDER, effective_from: PUBLISH_FROM });
    expect(res.json().conflicts.map((c: { rule: string }) => c.rule)).toContain('class_not_active');
  });
});

describe(':copy і ручна правка (етап 2)', () => {
  test('опублікована → PATCH 409 published_readonly; :copy дає validated копію, яку правлять', async () => {
    const { id } = ctx.newSchool();
    const { job, result } = await ctx.build(id);
    const tt = job.result.timetable_id;
    await ctx.as(id, 'POST', `/timetables/${tt}:publish`, { ...ORDER, effective_from: PUBLISH_FROM });
    const l = result.lessons[0]!;
    const patch = await ctx.as(id, 'PATCH', `/timetables/${tt}/lessons/${l.class_id}/${l.day}/${l.lesson_no}`, { day: l.day, lesson_no: 4 });
    expect(patch.json()).toMatchObject({ code: 'published_readonly' });

    const copy = await ctx.as(id, 'POST', `/timetables/${tt}:copy`);
    expect(copy.statusCode).toBe(201);
    expect(copy.json()).toMatchObject({ state: 'validated', copied_from: tt, snapshot_version: 5 });
    const copyId = copy.json().timetable_id;
    // Урок 1 → урок 4 того ж дня: слот вільний, правила не порушено.
    const moved = await ctx.as(id, 'PATCH', `/timetables/${copyId}/lessons/${l.class_id}/${l.day}/${l.lesson_no}`, { day: l.day, lesson_no: 4 });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().lessons).toContainEqual({ ...l, lesson_no: 4 });
  });

  test('зайнятий слот класу — обмін; конфлікт — 409 conflicts, зміна не зберігається', async () => {
    const { id } = ctx.newSchool();
    const { job, result } = await ctx.build(id);
    const tt = job.result.timetable_id;
    const [a, b] = result.lessons.filter((x) => x.class_id === result.lessons[0]!.class_id && x.day === 1);
    const swap = await ctx.as(id, 'PATCH', `/timetables/${tt}/lessons/${a!.class_id}/1/${a!.lesson_no}`, { day: 1, lesson_no: b!.lesson_no });
    expect(swap.statusCode).toBe(200);
    expect(swap.json().lessons).toEqual(expect.arrayContaining([{ ...a!, lesson_no: b!.lesson_no }, { ...b!, lesson_no: a!.lesson_no }]));
    // Перенести урок у п'ятницю (дистанційний день без уроків) — урок у дистанційний день дозволено;
    // а лишити очний день без уроків — ні: шукаємо день класу з одним уроком.
    const single = result.lessons.find((x) => result.lessons.filter((y) => y.class_id === x.class_id && y.day === x.day).length === 1)!;
    const bad = await ctx.as(id, 'PATCH', `/timetables/${tt}/lessons/${single.class_id}/${single.day}/${single.lesson_no}`, { day: 5, lesson_no: 1 });
    expect(bad.statusCode).toBe(409);
    expect(bad.json()).toMatchObject({ code: 'conflicts' });
    const after = (await ctx.as(id, 'GET', `/timetables/${tt}`)).json();
    expect(after.lessons).toContainEqual(single);
    expect((await ctx.as(id, 'PATCH', `/timetables/${tt}/lessons/${single.class_id}/${single.day}/9`, { day: 1, lesson_no: 1 })).statusCode).toBe(404);
    expect((await ctx.as(id, 'PATCH', `/timetables/${tt}/lessons/${single.class_id}/x/1`, { day: 1, lesson_no: 1 })).statusCode).toBe(404);
    const same = await ctx.as(id, 'PATCH', `/timetables/${tt}/lessons/${single.class_id}/${single.day}/${single.lesson_no}`, { day: single.day, lesson_no: single.lesson_no });
    expect(same.statusCode).toBe(200);
  });
});
