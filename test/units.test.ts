// Без бази: машина станів задачі проти contracts/vectors/job-lifecycle, час за Europe/Kyiv,
// QR-токен (HMAC), проєкція і конфігурація.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';
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

  test('бракує змінних, короткий секрет, строк черги < 10 хв → помилка', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL.*QR_HMAC_SECRET/);
    expect(() => loadConfig({ ...base, QR_HMAC_SECRET: 'short' })).toThrow(/32/);
    expect(() => loadConfig({ ...base, QUEUE_ALLOWANCE_S: '60' })).toThrow(/QUEUE_ALLOWANCE_S/);
    expect(() => loadConfig({ ...base, PORT: 'x' })).toThrow(/PORT/);
  });
});
