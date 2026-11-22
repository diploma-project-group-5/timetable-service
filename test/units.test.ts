// Без бази: машина станів задачі проти contracts/vectors/job-lifecycle, час за Europe/Kyiv,
// QR-токен (HMAC), проєкція і конфігурація, effectiveWeek проти contracts/vectors/substitution.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { validate } from '@lad/validator-lib';
import { loadConfig } from '../src/config.js';
import { inputFromRequest, judgeSubstitution, type SubstitutionRequest } from '../src/domain/substitutions.js';
import { effectiveWeek, type WeekGiven } from '../src/domain/week.js';
import { onCompleted, onStarted, watchdogExpires, type SolveStatus } from '../src/domain/job-state.js';
import { encodeToken, mac, macMatches, parseToken } from '../src/domain/qr.js';
import { addDays, datesBetween, formatUa, isoWeek, isoWeekday, isSchoolDay, isValidDate, todayKyiv, weekStart } from '../src/time.js';
import type { JobState } from '../src/db/index.js';

interface Vector {
  name: string;
  job: { job_id: string; created_at: string; queue_deadline_at: string; time_limit_s: number };
  run_deadline_margin_s: number;
  steps: ({ event: { type: string; event_id: string; data: { status?: SolveStatus; started_at?: string } } } | { watchdog_at: string })[];
  expected: { state: JobState; ignored_steps: number[] };
}

function vectors(): Vector[] {
  const require = createRequire(import.meta.url);
  const dir = join(dirname(require.resolve('@lad/contracts/package.json')), 'vectors', 'job-lifecycle');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Vector);
}

describe('машина станів задачі (contracts/vectors/job-lifecycle)', () => {
  const all = vectors();
  test('вектори знайдено', () => expect(all.length).toBeGreaterThanOrEqual(12));

  test.each(all.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const job = { state: 'queued' as JobState, time_limit_s: v.job.time_limit_s, queue_deadline_at: new Date(v.job.queue_deadline_at), run_deadline_at: null as Date | null };
    const seen = new Set<string>();
    const ignored: number[] = [];
    v.steps.forEach((step, i) => {
      if ('watchdog_at' in step) {
        if (watchdogExpires(job, new Date(step.watchdog_at))) job.state = 'failed';
        else ignored.push(i);
        return;
      }
      const e = step.event;
      if (seen.has(e.event_id)) {
        ignored.push(i);
        return;
      }
      seen.add(e.event_id);
      if (e.type === 'solve.started') {
        const d = onStarted(job, new Date(e.data.started_at!), v.run_deadline_margin_s);
        if (!d.accept) ignored.push(i);
        else Object.assign(job, { state: 'running', run_deadline_at: d.run_deadline_at });
      } else {
        const next = onCompleted(job, e.data.status!);
        if (next === null) ignored.push(i);
        else job.state = next;
      }
    });
    expect(job.state).toBe(v.expected.state);
    expect(ignored).toEqual(v.expected.ignored_steps);
  });
});

describe('час за Europe/Kyiv', () => {
  test('23:30 і 00:30 за Києвом — різні дати; літній і зимовий час', () => {
    // Зима (UTC+2): 21:30Z = 23:30 Київ того ж дня; 22:30Z = 00:30 наступного.
    expect(todayKyiv(new Date('2026-11-09T21:30:00Z'))).toBe('2026-11-09');
    expect(todayKyiv(new Date('2026-11-09T22:30:00Z'))).toBe('2026-11-10');
    // Літо (UTC+3): 20:30Z = 23:30, 21:30Z = 00:30.
    expect(todayKyiv(new Date('2026-07-01T20:30:00Z'))).toBe('2026-07-01');
    expect(todayKyiv(new Date('2026-07-01T21:30:00Z'))).toBe('2026-07-02');
    // Ніч переходу на літній час (29.03.2026) і назад (25.10.2026) не зсуває арифметику дат.
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(addDays('2026-10-24', 7)).toBe('2026-10-31');
  });

  test('ISO-тиждень, день тижня, понеділок тижня, навчальний день', () => {
    expect(isoWeek('2026-11-09')).toBe('2026-W46');
    expect(isoWeek('2027-01-01')).toBe('2026-W53');
    expect(isoWeek('2026-01-01')).toBe('2026-W01');
    expect(isoWeekday('2026-11-15')).toBe(7);
    expect(weekStart('2026-11-15')).toBe('2026-11-09');
    expect(isSchoolDay('2026-11-14', false)).toBe(false);
    expect(isSchoolDay('2026-11-14', true)).toBe(true);
    expect(datesBetween('2026-11-09', '2026-11-11')).toEqual(['2026-11-09', '2026-11-10', '2026-11-11']);
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2028-02-29')).toBe(true);
    expect(isValidDate('2026-1-1')).toBe(false);
    expect(formatUa('2026-11-16')).toBe('16.11.2026');
  });
});

describe('QR-токен', () => {
  const secret = 'x'.repeat(32);
  const school = '5d0b6a1e-7c3f-4b2a-9e41-0a1d2c3b4e5f';
  const token = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

  test('school_id.token_id.MAC; MAC base64url 43 символи; розбір', () => {
    const t = encodeToken(secret, school, 'class', token, 1);
    expect(t).toMatch(/^[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(parseToken(t)).toEqual({ schoolId: school, tokenId: token, mac: t.split('.')[2] });
    for (const bad of [undefined, '', 'a.b', 'a.b.c', `${school}.${token}.short`, 'x'.repeat(300)]) expect(parseToken(bad)).toBeNull();
  });

  test('однакові token_id і generation у двох закладах дають різні MAC; scope і generation входять у MAC', () => {
    const other = '11111111-2222-4333-8444-555555555555';
    expect(mac(secret, school, 'class', token, 1)).not.toBe(mac(secret, other, 'class', token, 1));
    expect(mac(secret, school, 'class', token, 1)).not.toBe(mac(secret, school, 'teacher', token, 1));
    expect(mac(secret, school, 'class', token, 1)).not.toBe(mac(secret, school, 'class', token, 2));
    expect(mac(secret, school, 'class', token, 1)).not.toBe(mac('y'.repeat(32), school, 'class', token, 1));
    const m = mac(secret, school, 'class', token, 3);
    expect(macMatches(secret, school, 'class', token, 3, m)).toBe(true);
    expect(macMatches(secret, school, 'class', token, 3, m.slice(0, -1))).toBe(false);
  });
});

describe('конфігурація', () => {
  const base = {
    DATABASE_URL: 'postgres://a',
    RELAY_DATABASE_URL: 'postgres://r',
    MAINT_DATABASE_URL: 'postgres://m',
    OIDC_ISSUER: 'http://localhost/idp/realms/lad',
    OIDC_JWKS_URL: 'http://localhost/idp/realms/lad/protocol/openid-connect/certs',
    SCHOOL_INTERNAL_URL: 'http://localhost:3102/',
    QR_HMAC_SECRET: 's'.repeat(32),
  };

  test('значення за замовчуванням і політика', () => {
    expect(loadConfig(base)).toMatchObject({
      port: 3003,
      schoolInternalUrl: 'http://localhost:3102',
      publicUrl: 'http://localhost',
      kafkaBrokers: [],
      policy: { buildTimeLimitS: 60, queueAllowanceS: 600, runDeadlineMarginS: 90, publishMinDays: 7, alertThresholdMinutes: 120, alertThresholdDays: 3 },
    });
    expect(loadConfig({ ...base, PRIORITY_AREAS: 'math, science', KAFKA_BROKERS: 'kafka:9092' })).toMatchObject({
      kafkaBrokers: ['kafka:9092'],
      policy: { priorityAreas: ['math', 'science'] },
    });
  });

  test('PRIORITY_AREAS: незадана — типові; порожня чи з невідомою галуззю — помилка старту з назвою (#3)', () => {
    expect(loadConfig(base).policy.priorityAreas).toEqual(['math', 'science', 'language_literature', 'civic_history']);
    expect(loadConfig({ ...base, PRIORITY_AREAS: ' informatics ,math,math' }).policy.priorityAreas).toEqual(['informatics', 'math']);
    for (const empty of ['', ' ', ',,']) expect(() => loadConfig({ ...base, PRIORITY_AREAS: empty })).toThrow(/PRIORITY_AREAS задано, але порожнє/);
    expect(() => loadConfig({ ...base, PRIORITY_AREAS: '[]' })).toThrow(/PRIORITY_AREAS: невідома галузь \[\]/);
    expect(() => loadConfig({ ...base, PRIORITY_AREAS: 'math,maths' })).toThrow(/невідома галузь maths/);
  });

  test('бракує змінних, короткий секрет, строк черги < 10 хв → помилка', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL.*QR_HMAC_SECRET/);
    expect(() => loadConfig({ ...base, QR_HMAC_SECRET: 'short' })).toThrow(/32/);
    expect(() => loadConfig({ ...base, QUEUE_ALLOWANCE_S: '60' })).toThrow(/QUEUE_ALLOWANCE_S/);
    expect(() => loadConfig({ ...base, PORT: 'x' })).toThrow(/PORT/);
  });
});

describe('effectiveWeek ↔ contracts/vectors/substitution', () => {
  const dir = join(dirname(createRequire(import.meta.url).resolve('@lad/contracts/package.json')), 'vectors', 'substitution');
  const vectors = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, ...(JSON.parse(readFileSync(join(dir, f), 'utf8')) as { given?: WeekGiven; input: unknown; expected: { status: string; conflicts?: unknown[] } }) }))
    .filter((v) => v.given !== undefined);
  test('вектори з given є', () => expect(vectors.length).toBeGreaterThan(20));
  test.each(vectors)('$file: тиждень як у векторі, вердикт validator-lib як очікується', (v) => {
    const { input, unapplied } = effectiveWeek(v.given!);
    expect(unapplied).toEqual([]);
    expect(JSON.parse(JSON.stringify(input))).toEqual(v.input);
    const out = validate(input);
    expect(out.status).toBe(v.expected.status);
    if (v.expected.conflicts && out.status !== 'INVALID_INPUT') expect(out.conflicts).toEqual(v.expected.conflicts);
  });

  test('накладка на перенесений у слот урок стосується уроку шаблону; на порожній слот — не застосовується', () => {
    const snapshot = { kind: 'main', school_days: [1, 2, 3, 4, 5], lessons_per_day: 4, staff: 0, capacity: { passport: 100 }, classes: [], subjects: [], teachers: [], rows: [] } as unknown as WeekGiven['snapshot'];
    const L = (day: number, no: number, t: string) => ({ class_id: 'c', day, lesson_no: no, subject_id: 's', teacher_id: t });
    const template = { lessons: [L(1, 1, 'a'), L(2, 1, 'b')], day_formats: [] };
    const { input, unapplied } = effectiveWeek({
      snapshot,
      template,
      overlays: [
        { day: 1, class_id: 'c', lesson_no: 1, kind: 'moved', moved_to: { day: 2, lesson_no: 1 } },
        { day: 2, class_id: 'c', lesson_no: 1, kind: 'cancelled' },
        { day: 2, class_id: 'c', lesson_no: 1, kind: 'teacher', new_teacher_id: 'x' },
        { day: 3, class_id: 'c', lesson_no: 1, kind: 'self_study' },
      ],
    });
    // Скасовано урок шаблону вівторка; заміна вчителя — перенесеному з понеділка (інших уроків у слоті вже немає).
    expect(input.timetable.lessons).toEqual([{ ...L(2, 1, 'x'), origin: 'substitution' }]);
    expect(input.timetable.not_held).toEqual([{ class_id: 'c', day: 2, lesson_no: 1, subject_id: 's', kind: 'cancelled' }]);
    expect(unapplied).toEqual([{ day: 3, class_id: 'c', lesson_no: 1, kind: 'self_study' }]);
  });
});

describe('вердикт заміни ↔ contracts/vectors/substitution-solve', () => {
  type Expected = {
    class_id: string;
    lesson_no: number;
    kind?: string;
    kind_in?: string[];
    teacher_id?: string;
    teacher_id_in?: string[];
    off_profile?: boolean;
    moved_to?: { date: string; lesson_no?: number; lesson_no_in?: number[] };
    step: number;
  };
  const dir = join(dirname(createRequire(import.meta.url).resolve('@lad/contracts/package.json')), 'vectors', 'substitution-solve');
  const vectors = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, ...(JSON.parse(readFileSync(join(dir, f), 'utf8')) as { given: { request: SubstitutionRequest }; expect: { step: number; lessons: Expected[] } }) }));

  /**
   * Відповідь рушія, яку вектор описує: з допустимих значень — перше, а номери уроків переносів на одну
   * дату — різні (усі уроки задачі має той самий відсутній вчитель).
   */
  const answer = (v: (typeof vectors)[number]) => {
    const taken = new Set<string>();
    return {
      substitution: {
        step: v.expect.step,
        proposals: v.expect.lessons.map((e) => {
          const kind = e.kind ?? e.kind_in![0]!;
          let movedTo: { date: string; lesson_no: number } | undefined;
          if (kind === 'moved') {
            const options = e.moved_to!.lesson_no !== undefined ? [e.moved_to!.lesson_no] : e.moved_to!.lesson_no_in!;
            const no = options.find((n) => !taken.has(`${e.moved_to!.date}/${n}`)) ?? options[0]!;
            taken.add(`${e.moved_to!.date}/${no}`);
            movedTo = { date: e.moved_to!.date, lesson_no: no };
          }
          return {
            date: v.given.request.date,
            class_id: e.class_id,
            lesson_no: e.lesson_no,
            kind,
            ...(kind === 'teacher' ? { teacher_id: e.teacher_id ?? e.teacher_id_in![0]!, off_profile: e.off_profile ?? false } : {}),
            ...(movedTo ? { moved_to: movedTo } : {}),
            step: e.step,
          };
        }),
      },
    };
  };

  test('вектори є', () => expect(vectors.length).toBeGreaterThan(20));

  test.each(vectors)('$file: відповідь за вектором проходить інваріант і newConflicts без нових конфліктів', (v) => {
    const j = judgeSubstitution(inputFromRequest(v.given.request), answer(v));
    expect(j.status).toBe('checked');
    if (j.status === 'checked') {
      expect(j.added).toEqual([]);
      expect(j.proposals.map((p) => p.step)).toEqual(v.expect.lessons.map((e) => e.step));
    }
  });

  test.each(vectors)('$file: без пропозиції на урок, з чужою датою чи замісником-відсутнім — не приймається', (v) => {
    const input = inputFromRequest(v.given.request);
    const good = answer(v);
    const missing = { substitution: { ...good.substitution, proposals: good.substitution.proposals.slice(1) } };
    expect(judgeSubstitution(input, missing).status).toBe('invalid_result');
    const otherDate = structuredClone(good);
    otherDate.substitution.proposals[0]!.date = '2026-11-21';
    expect(judgeSubstitution(input, otherDate).status).toBe('invalid_result');
    // Перенос за межі дня (номер уроку понад lessons_per_day) — зламаний результат.
    const outOfDay = structuredClone(good);
    outOfDay.substitution.proposals[0] = {
      date: v.given.request.date,
      class_id: good.substitution.proposals[0]!.class_id,
      lesson_no: good.substitution.proposals[0]!.lesson_no,
      kind: 'moved',
      moved_to: { date: v.given.request.date, lesson_no: v.given.request.lessons_per_day + 1 },
      step: 2,
    } as never;
    expect(judgeSubstitution(input, outOfDay).status).toBe('invalid_result');
  });

  test('step пропозиції без власного step — step задачі (#6, п. 6); суперечливий step задачі — зламаний результат', () => {
    const v = vectors.find((x) => x.file.startsWith('01-'))!;
    const input = inputFromRequest(v.given.request);
    const noOwn = answer(v);
    for (const p of noOwn.substitution.proposals) delete (p as { step?: number }).step;
    const j = judgeSubstitution(input, noOwn);
    expect(j.status === 'checked' && j.proposals.every((p) => p.step === v.expect.step)).toBe(true);
    const wrong = answer(v);
    wrong.substitution.step = 3;
    expect(judgeSubstitution(input, wrong).status).toBe('invalid_result');
  });
});
