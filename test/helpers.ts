// Помічники тестів: токени, підробний school-service (знімки в пам'яті), фіксований годинник,
// заглушка solver (жадібна розстановка) і доступ до outbox.
import { Writable } from 'node:stream';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import Fastify from 'fastify';
import { inject } from 'vitest';
import { buildApp, LOG_REDACT } from '../src/app.js';
import { createTokenVerifier } from '../src/auth.js';
import { DEFAULT_POLICY, type Policy } from '../src/config.js';
import { createDb, type Db } from '../src/db/index.js';
import type { Envelope } from '../src/db/events.js';
import type { Deps } from '../src/domain/context.js';
import { handleSolveStatus } from '../src/domain/jobs.js';
import type { SchoolSnapshot } from '../src/school-client.js';

export const ISSUER = 'http://localhost/idp/realms/lad';
export const QR_SECRET = 'test-qr-secret-0123456789abcdef0123456789';
/** Понеділок 09.11.2026, 12:00 за Києвом. */
export const NOW = new Date('2026-11-09T10:00:00Z');
export const silentLog = Fastify({ logger: { level: 'silent' } }).log;

export async function createTestTokens() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
  const verifyToken = createTokenVerifier({ issuer: ISSUER, clientId: 'web', keys: createLocalJWKSet({ keys: [jwk] }) });
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT({ azp: 'web', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(ISSUER).setSubject('user-1').setIssuedAt().setExpirationTime('15m').sign(privateKey);
  return {
    verifyToken,
    sign,
    sysadmin: () => sign({ preferred_username: 'sysadmin', realm_access: { roles: ['sysadmin'] } }),
    scheduler: (schoolId: string) => sign({ preferred_username: 'demo', school_id: schoolId, realm_access: { roles: ['scheduler'] } }),
  };
}

export function captureLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: { level: 'debug', stream, redact: LOG_REDACT } };
}

export const appDb = (): Db => createDb(inject('pg').app, 4);
export const relayDb = (): Db => createDb(inject('pg').relay, 2);
export const maintDb = (): Db => createDb(inject('pg').maint, 2);
export function superDb(): Db {
  const { admin, owner } = inject('pg');
  const url = new URL(admin);
  url.pathname = new URL(owner).pathname;
  return createDb(url.toString(), 1);
}

export const uuid = () => crypto.randomUUID();

/** Невеликий заклад: 2 класи, 3 предмети, 4 вчителі, план на 7 і 6 годин; місткість із запасом. */
export function makeSnapshot(schoolId: string, over: Partial<SchoolSnapshot['profile']> = {}): SchoolSnapshot {
  const c1 = uuid();
  const c2 = uuid();
  const math = uuid();
  const ukr = uuid();
  const pe = uuid();
  const t1 = uuid();
  const t2 = uuid();
  const t3 = uuid();
  const t4 = uuid();
  return {
    school_id: schoolId,
    snapshot_version: 5,
    profile: { name: 'Ліцей № 17', lessons_per_day: 4, saturday: false, shelter_capacity: 200, non_teaching_staff: 5, shelter_seats: 150, ...over },
    bells: [
      { lesson_no: 1, start: '08:30', end: '09:15' },
      { lesson_no: 2, start: '09:25', end: '10:10' },
      { lesson_no: 3, start: '10:30', end: '11:15' },
      { lesson_no: 4, start: '11:25', end: '12:10' },
    ],
    classes: [
      { class_id: c1, name: '5-А', students: 28, in_person_priority: true, archived_at: null },
      { class_id: c2, name: '9-Б', students: 25, in_person_priority: false, archived_at: null },
    ],
    subjects: [
      { subject_id: math, name: 'Математика', short_name: 'Мат', education_area: 'math', not_in_shelter: false, archived_at: null },
      { subject_id: ukr, name: 'Українська мова', short_name: 'Укр', education_area: 'language_literature', not_in_shelter: false, archived_at: null },
      { subject_id: pe, name: 'Фізкультура', short_name: 'Фіз', education_area: 'physical', not_in_shelter: true, archived_at: null },
    ],
    teachers: [
      { teacher_id: t1, teacher_no: 1, label: 'Іваненко О. П.', weekly_hours_limit: 20, unavailable_days: [], deleted_at: null },
      { teacher_id: t2, teacher_no: 2, label: 'Петренко М. І.', weekly_hours_limit: 20, unavailable_days: [], deleted_at: null },
      { teacher_id: t3, teacher_no: 3, label: 'Сидоренко В. В.', weekly_hours_limit: 20, unavailable_days: [5], deleted_at: null },
      { teacher_id: t4, teacher_no: 4, label: 'Коваль Н. В.', weekly_hours_limit: 20, unavailable_days: [], deleted_at: null },
    ],
    curriculum: [
      { class_id: c1, subject_id: math, teacher_id: t1, hours_per_week: 4 },
      { class_id: c1, subject_id: ukr, teacher_id: t2, hours_per_week: 3 },
      { class_id: c2, subject_id: math, teacher_id: t4, hours_per_week: 3 },
      { class_id: c2, subject_id: pe, teacher_id: t3, hours_per_week: 3 },
    ],
  };
}

export interface BuildRequest {
  job_id: string;
  kind: 'main' | 'alert';
  school_days: number[];
  lessons_per_day: number;
  classes: { id: string; students: number; priority: boolean }[];
  subjects: { id: string; priority_area: boolean; no_shelter: boolean }[];
  teachers: { id: string; weekly_limit: number; unavailable_days: number[] }[];
  rows: { class_id: string; subject_id: string; teacher_id: string; hours: number }[];
}

/**
 * Заглушка solver: жадібно ставить години рядків плану у вільні слоти класу й вчителя. Дні з
 * уроками очні; для моделі 1.2 урок «не в укритті» робить день класу дистанційним — з усіма
 * уроками того дня (вчитель тоді має бути в одному форматі, у тестових даних це виконується).
 */
export function solve(req: BuildRequest) {
  const lessons: { class_id: string; day: number; lesson_no: number; subject_id: string; teacher_id: string }[] = [];
  const busy = new Set<string>();
  for (const r of req.rows) {
    const t = req.teachers.find((x) => x.id === r.teacher_id)!;
    let left = r.hours;
    for (const day of req.school_days) {
      if (t.unavailable_days.includes(day)) continue;
      for (let no = 1; no <= req.lessons_per_day && left > 0; no++) {
        if (busy.has(`c:${r.class_id}:${day}:${no}`) || busy.has(`t:${r.teacher_id}:${day}:${no}`)) continue;
        // Не більше одного уроку рядка на день, щоб розкласти рівномірно.
        if (lessons.some((l) => l.class_id === r.class_id && l.subject_id === r.subject_id && l.day === day)) break;
        lessons.push({ class_id: r.class_id, day, lesson_no: no, subject_id: r.subject_id, teacher_id: r.teacher_id });
        busy.add(`c:${r.class_id}:${day}:${no}`);
        busy.add(`t:${r.teacher_id}:${day}:${no}`);
        left--;
      }
    }
  }
  const noShelter = new Set(req.subjects.filter((s) => s.no_shelter).map((s) => s.id));
  const dayFormats = req.classes.flatMap((c) =>
    req.school_days.map((day) => {
      const own = lessons.filter((l) => l.class_id === c.id && l.day === day);
      const remote = own.length === 0 || (req.kind === 'alert' && own.some((l) => noShelter.has(l.subject_id)));
      return { class_id: c.id, day, in_person: !remote };
    }),
  );
  return { lessons, day_formats: dayFormats };
}

export class FakeSchool {
  snapshots = new Map<string, SchoolSnapshot>();
  calls = 0;
  down = false;
  fetch = async (schoolId: string) => {
    this.calls++;
    if (this.down) throw new (await import('../src/school-client.js')).SchoolUnavailableError('school-service недоступний');
    const s = this.snapshots.get(schoolId);
    if (!s) throw new Error(`немає знімка для ${schoolId}`);
    return structuredClone(s);
  };
}

export async function testApp(opts: { policy?: Partial<Policy> } = {}) {
  const tokens = await createTestTokens();
  const db = appDb();
  const relay = relayDb();
  const school = new FakeSchool();
  const clock = { now: NOW };
  const logs = captureLogs();
  const deps: Deps = {
    db,
    fetchSnapshot: school.fetch,
    policy: { ...DEFAULT_POLICY, ...opts.policy },
    qrSecret: QR_SECRET,
    publicUrl: 'https://lad.example',
    now: () => clock.now,
  };
  const app = buildApp({ ...deps, verifyToken: tokens.verifyToken, logger: logs.logger });
  await app.ready();

  async function as(schoolId: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
    return app.inject({
      method,
      url: `/api/v1/timetable${url}`,
      headers: { authorization: `Bearer ${await tokens.scheduler(schoolId)}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }

  async function events(schoolId: string, topic: string): Promise<Envelope[]> {
    const rows = await relay.selectFrom('outbox').select('payload').where('school_id', '=', schoolId).where('topic', '=', topic).orderBy('created_at').execute();
    return rows.map((r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Envelope);
  }

  /** Подія від solver у тому вигляді, як її віддає консюмер. */
  function status(schoolId: string, type: 'solve.started' | 'solve.completed', data: Record<string, unknown>): Envelope {
    return { event_id: uuid(), type, schema_version: '1.0', source: 'solver', time: clock.now.toISOString(), correlation_id: 'solver', school_id: schoolId, data };
  }

  /** Повний прогін побудови: :build → запит у outbox → started → completed із заглушки solver. */
  async function build(schoolId: string, kind: 'main' | 'alert' = 'main', mutate?: (r: ReturnType<typeof solve>) => void) {
    const res = await as(schoolId, 'POST', kind === 'main' ? '/timetables:build' : '/alert-plan:build');
    if (res.statusCode !== 202) throw new Error(`build: ${res.statusCode} ${res.body}`);
    const jobId = res.json().job_id as string;
    const req = (await events(schoolId, 'solve.build.requested')).map((e) => e.data as unknown as BuildRequest).find((d) => d.job_id === jobId)!;
    await handleSolveStatus(deps, status(schoolId, 'solve.started', { job_id: jobId, started_at: clock.now.toISOString() }));
    const result = solve(req);
    mutate?.(result);
    await handleSolveStatus(
      deps,
      status(schoolId, 'solve.completed', { job_id: jobId, status: 'FEASIBLE', ...result, conflicts: [], stats: { wall_time_ms: 1234 } }),
    );
    const job = (await as(schoolId, 'GET', `/jobs/${jobId}`)).json();
    return { jobId, job, req, result };
  }

  /** Заклад зі знімком у підробному school-service. */
  function school_(over: Partial<SchoolSnapshot['profile']> = {}) {
    const id = uuid();
    const snap = makeSnapshot(id, over);
    school.snapshots.set(id, snap);
    return { id, snap };
  }

  async function close() {
    await app.close();
    await db.destroy();
    await relay.destroy();
  }

  return { app, db, deps, tokens, logs, school, clock, as, events, status, build, newSchool: school_, close };
}

export type TestCtx = Awaited<ReturnType<typeof testApp>>;

/** Найближчий навчальний день не раніше ніж через 7 днів від NOW (понеділок 16.11.2026). */
export const PUBLISH_FROM = '2026-11-16';
export const ORDER = { order_no: '15-од', order_date: '2026-11-09', approved_by: 'Директор Коваль Н. В.' };
