// Модель часу (розділ 04): «сьогодні», ISO-тиждень і «не раніше ніж через 7 днів» — за Europe/Kyiv.
// Календарні значення — рядки 'YYYY-MM-DD'; арифметика днів — у UTC, тож перехід на літній чи
// зимовий час дату не зсуває.

export const TZ = 'Europe/Kyiv';

const kyivDate = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Сьогоднішня дата в Києві: запит о 23:30 і о 00:30 за Києвом дає різні дати. */
export const todayKyiv = (now: Date = new Date()): string => kyivDate.format(now);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

const toUtc = (date: string) => new Date(`${date}T00:00:00Z`);
const fromUtc = (d: Date) => d.toISOString().slice(0, 10);

export const addDays = (date: string, days: number): string => {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
};

/** ISO-день тижня: 1 = понеділок … 7 = неділя. */
export const isoWeekday = (date: string): number => {
  const wd = toUtc(date).getUTCDay();
  return wd === 0 ? 7 : wd;
};

/** Понеділок ISO-тижня дати. */
export const weekStart = (date: string): string => addDays(date, 1 - isoWeekday(date));

/** ISO-тиждень, наприклад '2026-W45'. */
export function isoWeek(date: string): string {
  const thursday = addDays(date, 4 - isoWeekday(date));
  const year = Number(thursday.slice(0, 4));
  const jan1 = toUtc(`${year}-01-01`);
  const week = Math.floor((toUtc(thursday).getTime() - jan1.getTime()) / 86_400_000 / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Навчальні дні — пн–пт, субота за прапорцем профілю (розділ 04). */
export const schoolDays = (saturday: boolean): number[] => (saturday ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5]);

export const isSchoolDay = (date: string, saturday: boolean): boolean => schoolDays(saturday).includes(isoWeekday(date));

/** Дні між from і to включно. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 'YYYY-MM-DD' → 'DD.MM.YYYY' для тексту банера. */
export const formatUa = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
