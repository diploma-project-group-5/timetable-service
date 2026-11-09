// Розклад тривог, облік тривог, QR і публічна сторінка, канікули, school.data.changed.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { handleSchoolDataChanged } from '../src/domain/misc.js';
import { encodeToken } from '../src/domain/qr.js';
import { ORDER, PUBLISH_FROM, QR_SECRET, testApp, uuid, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await testApp();
});
afterAll(() => ctx.close());

const ALERT_BELLS = [
  { lesson_no: 1, start: '09:00', end: '09:35' },
  { lesson_no: 2, start: '09:45', end: '10:20' },
  { lesson_no: 3, start: '10:30', end: '11:05' },
];

async function alertReady() {
  const s = ctx.newSchool();
  await ctx.as(s.id, 'PUT', '/alert-plan/bells', ALERT_BELLS);
  const built = await ctx.build(s.id, 'alert');
  return { ...s, ...built };
}

describe('розклад тривог', () => {
  test('дзвінки тривог: 1..N без пропусків, без перетинів', async () => {
    const { id } = ctx.newSchool();
    expect((await ctx.as(id, 'PUT', '/alert-plan/bells', ALERT_BELLS)).json()).toEqual(ALERT_BELLS);
    expect((await ctx.as(id, 'GET', '/alert-plan/bells')).json()).toEqual(ALERT_BELLS);
    expect((await ctx.as(id, 'PUT', '/alert-plan/bells', [ALERT_BELLS[1]])).statusCode).toBe(400);
    expect((await ctx.as(id, 'PUT', '/alert-plan/bells', [{ lesson_no: 1, start: '10:00', end: '09:00' }])).statusCode).toBe(400);
    expect((await ctx.as(id, 'PUT', '/alert-plan/bells', [ALERT_BELLS[0], { lesson_no: 2, start: '09:30', end: '10:00' }])).statusCode).toBe(400);
  });

  test('без дзвінків тривог чи навчальних місць → 422 profile_incomplete', async () => {
    const { id } = ctx.newSchool({ shelter_seats: null });
    const res = await ctx.as(id, 'POST', '/alert-plan:build');
    expect(res.json()).toMatchObject({ code: 'profile_incomplete', fields: ['shelter_seats', 'alert_bells'] });
  });

  test('побудова за моделлю 1.2 → шаблон kind=alert у плані draft; «не в укритті» → дистанційний день', async () => {
    const { id, req, job } = await alertReady();
    expect(req).toMatchObject({ kind: 'alert', lessons_per_day: 3 });
    const [event] = await ctx.events(id, 'solve.build.requested');
    expect(event!.data).toMatchObject({ model: '1.2', capacity: { seats: 150, passport: 200 } });
    expect(job).toMatchObject({ state: 'done', result: { alert_plan: true } });
    const plan = (await ctx.as(id, 'GET', '/alert-plan')).json();
    expect(plan).toMatchObject({ timetable_id: job.result.timetable_id, state: 'draft', bells: ALERT_BELLS, order: null, activations: [] });
    const load = (await ctx.as(id, 'GET', `/timetables/${plan.timetable_id}/load`)).json();
    expect(load.model).toBe('1.2');
    expect(load.days[0].seats).toMatchObject({ limit: 150 });
    // Шаблон тривог не з'являється серед версій основного розкладу.
    expect((await ctx.as(id, 'GET', '/timetables')).json()).toEqual([]);
  });

  test('погодження, активація з дати, перетин → 409, :build і дзвінки під час активації → 409, повернення', async () => {
    const { id, job } = await alertReady();
    const tt = job.result.timetable_id;
    expect((await ctx.as(id, 'POST', '/alert-plan:activate', { from: '2026-11-10' })).json()).toMatchObject({ code: 'alert_plan_not_approved' });
    const approved = await ctx.as(id, 'POST', '/alert-plan:approve', ORDER);
    expect(approved.json()).toMatchObject({ state: 'approved', order: { order_no: '15-од' } });

    expect((await ctx.as(id, 'POST', '/alert-plan:activate', { from: '2026-11-08' })).json()).toMatchObject({ code: 'invalid_date' });
    expect((await ctx.as(id, 'POST', '/alert-plan:activate', { from: '2026-11-14' })).json()).toMatchObject({ code: 'not_school_day' });
    const act = await ctx.as(id, 'POST', '/alert-plan:activate', { from: '2026-11-10' });
    expect(act.statusCode).toBe(200);
    expect(act.json()).toMatchObject({ activation_id: expect.any(String), warnings: { lost_substitutions: [] } });
    const activationId = act.json().activation_id;
    expect((await ctx.as(id, 'POST', '/alert-plan:activate', { from: '2026-11-12' })).json()).toMatchObject({ code: 'activation_overlap' });
    expect((await ctx.as(id, 'POST', '/alert-plan:build')).json()).toMatchObject({ code: 'alert_plan_active' });
    expect((await ctx.as(id, 'PUT', '/alert-plan/bells', ALERT_BELLS)).json()).toMatchObject({ code: 'alert_plan_active' });
    expect((await ctx.as(id, 'PATCH', `/timetables/${tt}/lessons/${uuid()}/1/1`, { day: 1, lesson_no: 2 })).json()).toMatchObject({ code: 'alert_plan_active' });

    // Активація ще не почалась (сьогодні 09.11, з 10.11) — :end її скасовує.
    const cancel = await ctx.as(id, 'POST', `/alert-plan/activations/${activationId}:end`, { from: '2026-11-11' });
    expect(cancel.json()).toMatchObject({ cancelled: true });
    expect((await ctx.as(id, 'GET', '/alert-plan')).json().activations).toEqual([]);

    const now = await ctx.as(id, 'POST', '/alert-plan:activate', { from: '2026-11-09' });
    const current = now.json().activation_id;
    expect((await ctx.as(id, 'POST', `/alert-plan/activations/${current}:end`, { from: '2026-11-09' })).json()).toMatchObject({ code: 'invalid_date' });
    const ended = await ctx.as(id, 'POST', `/alert-plan/activations/${current}:end`, { from: '2026-11-12' });
    expect(ended.json()).toMatchObject({ cancelled: false, warnings: { lost_substitutions: [] } });
    expect((await ctx.as(id, 'GET', '/alert-plan')).json().activations).toEqual([{ activation_id: current, from: '2026-11-09', to: '2026-11-12' }]);
    expect((await ctx.as(id, 'POST', `/alert-plan/activations/${uuid()}:end`, { from: '2026-11-12' })).statusCode).toBe(404);

    const actions = (await ctx.events(id, 'audit.recorded')).map((e) => e.data.action);
    expect(actions).toEqual(['alert_plan_approved', 'alert_plan_activated', 'alert_plan_activation_cancelled', 'alert_plan_activated', 'alert_plan_ended']);
  });

  test(':activate на змінених даних, що порушують ліміт 1.2 → 409 stale з умовою', async () => {
    const { id, snap } = await alertReady();
    await ctx.as(id, 'POST', '/alert-plan:approve', ORDER);
    snap.snapshot_version = 9;
    snap.profile.shelter_seats = 10;
    const res = await ctx.as(id, 'POST', '/alert-plan:activate', { from: '2026-11-10' });
    expect(res.json()).toMatchObject({ code: 'stale' });
    expect(res.json().conflicts).toContainEqual(expect.objectContaining({ rule: 'capacity_exceeded', condition: 'seats' }));
  });

  test('результат build_alert, коли план уже погоджено → rejected alert_plan_locked', async () => {
    const { id } = await alertReady();
    await ctx.as(id, 'POST', '/alert-plan:approve', ORDER);
    const { job } = await ctx.build(id, 'alert');
    expect(job).toMatchObject({ state: 'rejected', error: 'alert_plan_locked' });
  });

  test(':approve без шаблону → 409 alert_plan_missing; під час build_alert → 409 build_in_progress', async () => {
    const { id } = ctx.newSchool();
    expect((await ctx.as(id, 'POST', '/alert-plan:approve', ORDER)).json()).toMatchObject({ code: 'alert_plan_missing' });
    await ctx.as(id, 'PUT', '/alert-plan/bells', ALERT_BELLS);
    await ctx.as(id, 'POST', '/alert-plan:build');
    expect((await ctx.as(id, 'POST', '/alert-plan:approve', ORDER)).json()).toMatchObject({ code: 'build_in_progress' });
  });
});

describe('облік тривог', () => {
  test('серія навчальних днів понад поріг і рекомендація; майбутня дата → 422', async () => {
    const { id } = ctx.newSchool();
    await ctx.build(id); // синхронізує «Стан закладу» (субота вимкнена)
    // Пт 06.11, Чт 05.11, Ср 04.11 — по 150 хв; вихідні пропускаються; сьогодні (09.11) ще не внесено.
    for (const d of ['2026-11-04', '2026-11-05', '2026-11-06']) expect((await ctx.as(id, 'PUT', `/alert-hours/${d}`, { minutes: 150 })).statusCode).toBe(200);
    await ctx.as(id, 'PUT', '/alert-hours/2026-11-03', { minutes: 30 });
    const res = (await ctx.as(id, 'GET', '/alert-hours?from=2026-11-01&to=2026-11-30')).json();
    expect(res).toMatchObject({ current_streak_days: 3, recommendation: true, threshold_minutes: 120, threshold_days: 3 });
    expect(res.days).toHaveLength(4);
    await ctx.as(id, 'PUT', '/alert-hours/2026-11-09', { minutes: 60 });
    expect((await ctx.as(id, 'GET', '/alert-hours?from=2026-11-01&to=2026-11-30')).json()).toMatchObject({ current_streak_days: 0, recommendation: false });
    expect((await ctx.as(id, 'PUT', '/alert-hours/2026-11-10', { minutes: 10 })).json()).toMatchObject({ code: 'invalid_date' });
    expect((await ctx.as(id, 'PUT', '/alert-hours/2026-11-08', { minutes: 2000 })).statusCode).toBe(400);
    expect((await ctx.as(id, 'GET', '/alert-hours?from=2026-11-30&to=2026-11-01')).statusCode).toBe(400);
  });
});

describe('QR і публічна сторінка', () => {
  const pub = (token?: string) => ctx.app.inject({ method: 'GET', url: '/api/v1/public/timetable', headers: token ? { 'x-access-token': token } : {} });

  async function published() {
    const s = ctx.newSchool();
    const { job, result } = await ctx.build(s.id);
    await ctx.as(s.id, 'POST', `/timetables/${job.result.timetable_id}:publish`, { ...ORDER, effective_from: PUBLISH_FROM });
    const classes = (await ctx.as(s.id, 'GET', '/access-tokens?type=class')).json();
    const teachers = (await ctx.as(s.id, 'GET', '/access-tokens?type=teacher')).json();
    return { ...s, tt: job.result.timetable_id, result, classes, teachers };
  }

  test('посилання QR відтворюються з HMAC; немає токена закладу без класу', async () => {
    const { id, snap, classes } = await published();
    expect(classes).toHaveLength(2);
    expect(classes[0]).toMatchObject({ scope: 'class', target_label: '5-А', generation: 1, url: expect.stringMatching(/^https:\/\/lad\.example\/c#/) });
    expect(classes[0].url).toBe(`https://lad.example/c#${encodeToken(QR_SECRET, id, 'class', classes[0].token_id, 1)}`);
    expect(classes[0].target_id).toBe(snap.classes[0]!.class_id);
    const again = (await ctx.as(id, 'GET', '/access-tokens?type=class')).json();
    expect(again.map((t: { url: string }) => t.url)).toEqual(classes.map((t: { url: string }) => t.url));
    expect((await ctx.as(id, 'GET', '/access-tokens?type=room')).statusCode).toBe(400);
  });

  test('сторінка класу: два тижні, предмети без підписів вчителів, час за дзвінками, заголовки', async () => {
    const { snap, classes } = await published();
    const token = classes[0].url.split('#')[1];
    const res = await pub(token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    const body = res.json();
    expect(body).toMatchObject({ state: 'published', target_label: '5-А', upcoming_change: 'З 16.11.2026 діє новий розклад' });
    expect(body.weeks.map((w: { week: string }) => w.week)).toEqual(['2026-W46', '2026-W47']);
    // Тиждень 46 — до effective_from: опублікованої версії ще немає → дні без уроків.
    expect(body.weeks[0].days[0]).toEqual({ date: '2026-11-09', format: null, lessons: [] });
    const monday = body.weeks[1].days[0];
    expect(monday).toMatchObject({ date: '2026-11-16', format: 'in_person' });
    expect(monday.lessons[0]).toEqual({ lesson_no: 1, start: '08:30', end: '09:15', subject: 'Математика', substitution: false });
    const text = res.body;
    for (const t of snap.teachers) expect(text).not.toContain(t.label);
    expect(text).not.toContain('Ліцей');
    expect(text).not.toContain('students');
  });

  test('сторінка вчителя: класи замість предметів', async () => {
    const { teachers } = await published();
    const ivanenko = teachers.find((t: { target_label: string }) => t.target_label === 'Іваненко О. П.');
    const body = (await pub(ivanenko.url.split('#')[1])).json();
    expect(body.target_label).toBe('Іваненко О. П.');
    expect(body.weeks[1].days[0].lessons[0]).toEqual({ lesson_no: 1, start: '08:30', end: '09:15', class_name: '5-А', substitution: false });
  });

  test('недійсний, підроблений, з чужим закладом, перевипущений токен → однакова 404', async () => {
    const { id, classes } = await published();
    const token: string = classes[0].url.split('#')[1];
    const [, tokenId, mac] = token.split('.');
    const bad = [undefined, 'abc', `${uuid()}.${tokenId}.${mac}`, `${id}.${tokenId}.${'A'.repeat(43)}`, `${id}.${uuid()}.${mac}`, `${token}.x`];
    for (const t of bad) {
      const res = await pub(t);
      expect(res.statusCode, String(t)).toBe(404);
      expect(res.json()).toMatchObject({ title: 'Посилання недійсне. Зверніться до закладу' });
    }
    const rotated = await ctx.as(id, 'POST', `/access-tokens/${classes[0].token_id}:rotate`);
    expect(rotated.json()).toMatchObject({ generation: 2, target_label: '5-А' });
    expect((await pub(token)).statusCode).toBe(404);
    expect((await pub(rotated.json().url.split('#')[1])).statusCode).toBe(200);
    expect((await pub(classes[1].url.split('#')[1])).statusCode).toBe(200);
    expect((await ctx.as(ctx.newSchool().id, 'POST', `/access-tokens/${classes[0].token_id}:rotate`)).statusCode).toBe(404);
    expect((await ctx.as(id, 'POST', `/access-tokens/${classes[0].token_id}:delete`)).statusCode).toBe(404);
  });

  test('до першої публікації — 200 not_published', async () => {
    const { id } = ctx.newSchool();
    const [cls] = (await ctx.as(id, 'GET', '/access-tokens?type=class')).json();
    expect((await pub(cls.url.split('#')[1])).json()).toEqual({ state: 'not_published', target_label: '', published_at: null, upcoming_change: null, weeks: [] });
  });

  test('розклад тривог з дати: шаблон і дзвінки тривог, банер; канікули — день без уроків', async () => {
    const { id, classes } = await published();
    await ctx.as(id, 'PUT', '/alert-plan/bells', ALERT_BELLS);
    await ctx.build(id, 'alert');
    await ctx.as(id, 'POST', '/alert-plan:approve', ORDER);
    await ctx.as(id, 'POST', '/alert-plan:activate', { from: '2026-11-17' });
    expect((await ctx.as(id, 'PUT', '/holidays', { holiday_from: '2026-11-19', holiday_to: '2026-11-20' })).statusCode).toBe(200);
    const body = (await pub(classes[0].url.split('#')[1])).json();
    expect(body.upcoming_change).toBe('З 17.11.2026 діє розклад тривог');
    const [mon, tue, , thu] = body.weeks[1].days;
    expect(mon.lessons[0].start).toBe('08:30');
    expect(tue.lessons[0]).toMatchObject({ start: '09:00', end: '09:35' });
    expect(thu).toEqual({ date: '2026-11-19', format: null, lessons: [], holiday: true, holiday_from: '2026-11-19', holiday_to: '2026-11-20' });
  });

  test('чужий маршрут /public → 404', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/public/other' })).statusCode).toBe(404);
  });
});

describe('канікули', () => {
  test('дві дати або обидві null; from > to чи одна дата → 422', async () => {
    const { id } = ctx.newSchool();
    expect((await ctx.as(id, 'GET', '/holidays')).json()).toEqual({ holiday_from: null, holiday_to: null });
    expect((await ctx.as(id, 'PUT', '/holidays', { holiday_from: '2026-12-29', holiday_to: '2027-01-11' })).json()).toEqual({ holiday_from: '2026-12-29', holiday_to: '2027-01-11' });
    expect((await ctx.as(id, 'PUT', '/holidays', { holiday_from: '2027-01-11', holiday_to: '2026-12-29' })).statusCode).toBe(422);
    expect((await ctx.as(id, 'PUT', '/holidays', { holiday_from: '2027-01-11', holiday_to: null })).statusCode).toBe(422);
    expect((await ctx.as(id, 'PUT', '/holidays', { holiday_from: '2027-02-30', holiday_to: '2027-03-01' })).statusCode).toBe(422);
    expect((await ctx.as(id, 'PUT', '/holidays', { holiday_from: null, holiday_to: null })).json()).toEqual({ holiday_from: null, holiday_to: null });
    expect((await ctx.events(id, 'audit.recorded')).map((e) => e.data.action)).toEqual(['holidays_set', 'holidays_cleared']);
  });
});

describe('school.data.changed', () => {
  test('новіший snapshot_version → «дані змінилися після побудови»; новий клас — QR; архів — відкликання', async () => {
    const { id } = ctx.newSchool();
    const tt = (await ctx.build(id)).job.result.timetable_id;
    const change = (data: Record<string, unknown>) => ({
      event_id: uuid(),
      type: 'school.data.changed',
      schema_version: '1.0',
      source: 'school-service',
      time: new Date().toISOString(),
      correlation_id: 'c',
      school_id: id,
      data,
    });
    const newClass = uuid();
    const e = change({ snapshot_version: 6, changes: [{ entity: 'class', op: 'created', id: newClass }] });
    expect(await handleSchoolDataChanged(ctx.deps, e)).toBe('processed');
    expect(await handleSchoolDataChanged(ctx.deps, e)).toBe('duplicate');
    expect((await ctx.as(id, 'GET', '/timetables')).json()[0]).toMatchObject({ timetable_id: tt, data_changed_since_build: true });
    // Старіша подія не зменшує відомий snapshot_version.
    await handleSchoolDataChanged(ctx.deps, change({ snapshot_version: 3, changes: [] }));
    expect((await ctx.as(id, 'GET', '/timetables')).json()[0].data_changed_since_build).toBe(true);
    await handleSchoolDataChanged(ctx.deps, change({ snapshot_version: 7, changes: [{ entity: 'class', op: 'archived', id: newClass }] }));
    await expect(handleSchoolDataChanged(ctx.deps, change({ changes: [] }))).rejects.toThrow(/snapshot_version/);
  });

  test('видалений вчитель: QR відкликано, у копіях версій — «Вчитель #N»', async () => {
    const { id, snap } = ctx.newSchool();
    const tt = (await ctx.build(id)).job.result.timetable_id;
    const teacher = snap.teachers[0]!;
    const before = (await ctx.as(id, 'GET', '/access-tokens?type=teacher')).json();
    expect(before.map((t: { target_id: string }) => t.target_id)).toContain(teacher.teacher_id);
    await handleSchoolDataChanged(ctx.deps, {
      event_id: uuid(),
      type: 'school.data.changed',
      schema_version: '1.0',
      source: 'school-service',
      time: new Date().toISOString(),
      correlation_id: 'c',
      school_id: id,
      data: { snapshot_version: 6, changes: [{ entity: 'teacher', op: 'deleted', id: teacher.teacher_id, teacher_no: 1 }] },
    });
    const detail = (await ctx.as(id, 'GET', `/timetables/${tt}`)).json();
    expect(detail.teachers.find((t: { teacher_id: string }) => t.teacher_id === teacher.teacher_id).label).toBe('Вчитель #1');
    expect(JSON.stringify(detail)).not.toContain('Іваненко');
  });

  test('зміна дзвінків оновлює дзвінки сторінок за QR зі свіжого знімка', async () => {
    const { id, snap } = ctx.newSchool();
    snap.bells[0] = { lesson_no: 1, start: '08:00', end: '08:45' };
    await handleSchoolDataChanged(ctx.deps, {
      event_id: uuid(),
      type: 'school.data.changed',
      schema_version: '1.0',
      source: 'school-service',
      time: new Date().toISOString(),
      correlation_id: 'c',
      school_id: id,
      data: { snapshot_version: 6, changes: [{ entity: 'bells', op: 'replaced' }] },
    });
    const { classes } = { classes: (await ctx.as(id, 'GET', '/access-tokens?type=class')).json() };
    const tt = (await ctx.build(id)).job.result.timetable_id;
    await ctx.as(id, 'POST', `/timetables/${tt}:publish`, { ...ORDER, effective_from: PUBLISH_FROM });
    const body = (await ctx.app.inject({ method: 'GET', url: '/api/v1/public/timetable', headers: { 'x-access-token': classes[0].url.split('#')[1] } })).json();
    expect(body.weeks[1].days[0].lessons[0].start).toBe('08:00');
  });
});
