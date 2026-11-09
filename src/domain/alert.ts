// Розклад тривог (розділи 05, 06, 10): шаблон kind='alert' (модель 1.2), власні дзвінки, погодження
// наказом, активації з дати й повернення; облік тривалості тривог і рекомендація за порогом.
import { ensureSchoolState, withSchool, type BellRow, type Db, type Trx } from '../db/index.js';
import { fail } from '../problem.js';
import { addDays, isSchoolDay, isValidDate, todayKyiv } from '../time.js';
import { recordAudit, type Ctx, type Deps } from './context.js';
import { hasCurrentOrFutureActivation, readAlertBells, syncSchoolState } from './jobs.js';
import { project } from './projection.js';
import { approvedSubstitutionsOn } from './resolve.js';
import { check, conflictsOf, readData } from './store.js';

export interface AlertPlanView {
  timetable_id: string | null;
  state: 'draft' | 'approved';
  bells: BellRow[];
  order: { order_no: string; order_date: string | null; approved_by: string | null } | null;
  activations: { activation_id: string; from: string; to: string | null }[];
}

async function planIn(trx: Trx): Promise<AlertPlanView> {
  const [plan, bells, activations] = await Promise.all([
    trx.selectFrom('alert_plan').selectAll().executeTakeFirst(),
    readAlertBells(trx),
    trx.selectFrom('alert_activations').select(['activation_id', 'date_from', 'date_to']).orderBy('date_from').execute(),
  ]);
  return {
    timetable_id: plan?.timetable_id ?? null,
    state: plan?.state ?? 'draft',
    bells,
    order: plan?.order_no ? { order_no: plan.order_no, order_date: plan.order_date, approved_by: plan.approved_by } : null,
    activations: activations.map((a) => ({ activation_id: a.activation_id, from: a.date_from, to: a.date_to })),
  };
}

export const getAlertPlan = (db: Db, schoolId: string) => withSchool(db, schoolId, planIn);

const backToDraft = (trx: Trx) =>
  trx.updateTable('alert_plan').set({ state: 'draft', order_no: null, order_date: null, approved_by: null, updated_at: new Date() }).execute();

async function activeBuild(trx: Trx): Promise<boolean> {
  const row = await trx
    .selectFrom('jobs')
    .select('job_id')
    .where('kind', '=', 'build_alert')
    .where('state', 'in', ['queued', 'running'])
    .executeTakeFirst();
  return row !== undefined;
}

/** PUT /alert-plan/bells: дзвінки тривог № 1..N без пропусків; 409, поки є чинна чи майбутня активація. */
export async function putAlertBells(deps: Deps, ctx: Ctx, bells: BellRow[]): Promise<AlertPlanView> {
  const sorted = [...bells].sort((a, b) => a.lesson_no - b.lesson_no);
  sorted.forEach((b, i) => {
    if (b.lesson_no !== i + 1) fail(400, 'validation_failed', 'Некоректні дзвінки тривог', 'Номери уроків — 1, 2, 3… без пропусків і повторів');
    if (b.start >= b.end) fail(400, 'validation_failed', 'Некоректні дзвінки тривог', `Урок №${b.lesson_no}: початок має бути раніше кінця`);
    const prev = sorted[i - 1];
    if (prev && b.start < prev.end) fail(400, 'validation_failed', 'Некоректні дзвінки тривог', `Урок №${b.lesson_no} перетинається з попереднім`);
  });
  return withSchool(deps.db, ctx.schoolId, async (trx) => {
    if (await hasCurrentOrFutureActivation(trx, todayKyiv(deps.now()))) {
      fail(409, 'alert_plan_active', 'Розклад тривог діє за наказом', 'Поки є чинна або майбутня активація, дзвінки не змінюються');
    }
    await trx.deleteFrom('alert_bells').execute();
    if (sorted.length > 0) {
      await trx
        .insertInto('alert_bells')
        .values(sorted.map((b) => ({ school_id: ctx.schoolId, lesson_no: b.lesson_no, starts_at: b.start, ends_at: b.end })))
        .execute();
    }
    await backToDraft(trx);
    return planIn(trx);
  });
}

export interface OrderInput {
  order_no: string;
  order_date: string;
  approved_by: string;
}

/** POST /alert-plan:approve: погодження шаблону наказом; 409 build_in_progress, поки рахується build_alert. */
export async function approveAlertPlan(deps: Deps, ctx: Ctx, body: OrderInput): Promise<AlertPlanView> {
  if (!isValidDate(body.order_date)) fail(422, 'invalid_date', 'Некоректна дата', 'order_date: YYYY-MM-DD');
  return withSchool(deps.db, ctx.schoolId, async (trx) => {
    if (await activeBuild(trx)) fail(409, 'build_in_progress', 'План тривог ще будується');
    const plan = await trx.selectFrom('alert_plan').selectAll().forUpdate().executeTakeFirst();
    if (!plan?.timetable_id) fail(409, 'alert_plan_missing', 'Шаблону розкладу тривог ще немає', 'Спершу побудуйте план (:build)');
    await trx
      .updateTable('alert_plan')
      .set({ state: 'approved', order_no: body.order_no.trim(), order_date: body.order_date, approved_by: body.approved_by.trim(), updated_at: new Date() })
      .execute();
    await recordAudit(trx, ctx, 'alert_plan_approved', plan!.timetable_id, { order_no: body.order_no.trim(), order_date: body.order_date }, deps.now());
    return planIn(trx);
  });
}

/**
 * POST /alert-plan:activate {from}: з навчальної дати не раніше сьогодні, без 7-денного очікування.
 * Та сама перевірка на свіжому знімку, що й на :publish (модель 1.2): порушення → 409 stale.
 */
export async function activateAlertPlan(deps: Deps, ctx: Ctx, from: string) {
  if (!isValidDate(from)) fail(422, 'invalid_date', 'Некоректна дата', 'from: YYYY-MM-DD');
  const fresh = await deps.fetchSnapshot(ctx.schoolId, ctx.correlationId);
  const now = deps.now();
  const today = todayKyiv(now);
  if (from < today) fail(422, 'invalid_date', 'Дата в минулому', 'Активувати можна з сьогодні або пізніше');
  if (!isSchoolDay(from, fresh.profile.saturday)) fail(422, 'not_school_day', 'Не навчальний день');
  return withSchool(deps.db, ctx.schoolId, async (trx) => {
    await ensureSchoolState(trx, ctx.schoolId, true);
    await syncSchoolState(trx, ctx.schoolId, fresh);
    if (await activeBuild(trx)) fail(409, 'build_in_progress', 'План тривог ще будується');
    const plan = await trx.selectFrom('alert_plan').selectAll().executeTakeFirst();
    if (!plan?.timetable_id || plan.state !== 'approved') {
      fail(409, 'alert_plan_not_approved', 'План тривог не погоджено', 'Спершу погодьте план наказом');
    }
    const template = await trx.selectFrom('timetables').select(['snapshot_version']).where('timetable_id', '=', plan!.timetable_id!).executeTakeFirstOrThrow();
    if (template.snapshot_version !== fresh.snapshot_version) {
      const bells = await readAlertBells(trx);
      const { input } = project(fresh, 'alert', deps.policy.priorityAreas, bells);
      const outcome = check(input, await readData(trx, plan!.timetable_id!));
      if (outcome.status !== 'ACCEPTED') {
        fail(409, 'stale', 'Дані закладу змінилися', 'План тривог порушує поточні дані — перебудуйте його', { conflicts: conflictsOf(outcome) });
      }
    }
    const activationId = crypto.randomUUID();
    try {
      await trx.insertInto('alert_activations').values({ school_id: ctx.schoolId, activation_id: activationId, date_from: from, date_to: null }).execute();
    } catch (err) {
      if ((err as { code?: string }).code === '23P01') fail(409, 'activation_overlap', 'Перетин з іншою активацією');
      throw err;
    }
    const lost = await approvedSubstitutionsOn(trx, { from, timetableKind: 'main' });
    await recordAudit(trx, ctx, 'alert_plan_activated', activationId, { from, timetable_id: plan!.timetable_id }, now);
    return { activation_id: activationId, warnings: { lost_substitutions: lost } };
  });
}

/**
 * POST /alert-plan/activations/{id}:end {from}: з цієї дати знову діє основний розклад; дата пізніша
 * за початок активації і не раніше сьогодні (інакше 422). Ще не чинна активація — скасовується.
 */
export async function endActivation(deps: Deps, ctx: Ctx, activationId: string, from: string) {
  if (!isValidDate(from)) fail(422, 'invalid_date', 'Некоректна дата', 'from: YYYY-MM-DD');
  const now = deps.now();
  const today = todayKyiv(now);
  return withSchool(deps.db, ctx.schoolId, async (trx) => {
    await ensureSchoolState(trx, ctx.schoolId, true);
    const a = await trx.selectFrom('alert_activations').selectAll().where('activation_id', '=', activationId).executeTakeFirst();
    if (!a) return fail(404, 'not_found', 'Активацію не знайдено');
    if (a.date_to !== null && a.date_to <= today) fail(409, 'validation_failed', 'Активація вже завершилась');
    if (a.date_from > today) {
      // Ще не почалась: скасування. Погоджені заміни на шаблоні тривог у її датах втрачають силу.
      const lost = await approvedSubstitutionsOn(trx, { from: a.date_from, to: a.date_to, timetableKind: 'alert' });
      await trx.deleteFrom('alert_activations').where('activation_id', '=', activationId).execute();
      await recordAudit(trx, ctx, 'alert_plan_activation_cancelled', activationId, { from: a.date_from }, now);
      return { activation_id: activationId, cancelled: true, warnings: { lost_substitutions: lost } };
    }
    if (from < today || from <= a.date_from) {
      fail(422, 'invalid_date', 'Некоректна дата повернення', 'Дата повернення пізніша за початок активації і не раніше сьогодні');
    }
    if (a.date_to !== null && from > a.date_to) fail(422, 'invalid_date', 'Некоректна дата повернення', `Активація вже закінчується ${a.date_to}`);
    const lost = await approvedSubstitutionsOn(trx, { from, to: a.date_to, timetableKind: 'alert' });
    await trx.updateTable('alert_activations').set({ date_to: from }).where('activation_id', '=', activationId).execute();
    await recordAudit(trx, ctx, 'alert_plan_ended', activationId, { from }, now);
    return { activation_id: activationId, cancelled: false, warnings: { lost_substitutions: lost } };
  });
}

// ───────────── облік тривог ─────────────

export async function putAlertHours(deps: Deps, ctx: Ctx, date: string, minutes: number) {
  if (!isValidDate(date)) fail(422, 'invalid_date', 'Некоректна дата', 'YYYY-MM-DD');
  if (date > todayKyiv(deps.now())) fail(422, 'invalid_date', 'Дата в майбутньому', 'Тривалість тривог вносять за минулі дні або сьогодні');
  return withSchool(deps.db, ctx.schoolId, async (trx) => {
    await trx
      .insertInto('alert_hours')
      .values({ school_id: ctx.schoolId, date, minutes })
      .onConflict((oc) => oc.columns(['school_id', 'date']).doUpdateSet({ minutes }))
      .execute();
    return { date, minutes };
  });
}

/**
 * GET /alert-hours?from=&to=: тривалість по днях, поточна серія навчальних днів понад поріг і
 * рекомендація. Серія рахується при читанні: від сьогодні назад (сьогодні без запису пропускається —
 * дані ще не внесено), поки день має запис понад поріг.
 */
export async function getAlertHours(deps: Deps, schoolId: string, from: string, to: string) {
  const { alertThresholdMinutes: thresholdMinutes, alertThresholdDays: thresholdDays } = deps.policy;
  const today = todayKyiv(deps.now());
  return withSchool(deps.db, schoolId, async (trx) => {
    const state = await trx.selectFrom('school_state').select('saturday').executeTakeFirst();
    const saturday = state?.saturday ?? false;
    const days = await trx.selectFrom('alert_hours').select(['date', 'minutes']).where('date', '>=', from).where('date', '<=', to).orderBy('date').execute();
    const lookbackFrom = addDays(today, -60);
    const recent = await trx.selectFrom('alert_hours').select(['date', 'minutes']).where('date', '>=', lookbackFrom).where('date', '<=', today).execute();
    const byDate = new Map(recent.map((r) => [r.date, r.minutes]));
    let streak = 0;
    let d = today;
    if (!byDate.has(d)) d = addDays(d, -1);
    for (; d >= lookbackFrom; d = addDays(d, -1)) {
      if (!isSchoolDay(d, saturday)) continue;
      const m = byDate.get(d);
      if (m === undefined || m <= thresholdMinutes) break;
      streak++;
    }
    return {
      days,
      current_streak_days: streak,
      recommendation: streak >= thresholdDays,
      threshold_minutes: thresholdMinutes,
      threshold_days: thresholdDays,
    };
  });
}
