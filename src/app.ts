// HTTP-застосунок timetable-service: /api/v1/timetable/* для укладача (розділ 10) і
// /api/v1/public/* без JWT, за X-Access-Token (розділ 11). Шлюз не зрізає префікс.
//
// Дії над ресурсом — через двокрапку (розділ 07): /timetables:build, /timetables/{id}:publish.
// Маршрутизатор Fastify не відділяє параметр від «:дії», тож {id}:{дія} розбирається тут.
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { sql } from 'kysely';
import { actorOf, requireScheduler, type TokenVerifier } from './auth.js';
import { activateAlertPlan, approveAlertPlan, endActivation, getAlertHours, getAlertPlan, putAlertBells, putAlertHours } from './domain/alert.js';
import type { Ctx, Deps } from './domain/context.js';
import { getJob, startBuild } from './domain/jobs.js';
import { exportTeacher, getHolidays, putHolidays } from './domain/misc.js';
import { publicTimetable } from './domain/public.js';
import { listAccessTokens, rotateAccessToken, verifyAccess } from './domain/qr.js';
import { approveSubstitution, cancelAbsence, createAbsence, listAbsences, listSubstitutions, rejectSubstitution } from './domain/substitutions.js';
import { copyVersion, getLoad, getVersion, listVersions, moveLesson, publishVersion } from './domain/versions.js';
import { SchoolUnavailableError } from './school-client.js';
import { isValidDate } from './time.js';
import { problem, ProblemError, sendProblem } from './problem.js';

export interface AppDeps extends Deps {
  verifyToken: TokenVerifier;
  logger?: FastifyServerOptions['logger'];
}

export const API_PREFIX = '/api/v1/timetable';
export const PUBLIC_PREFIX = '/api/v1/public';
export const LOG_REDACT = ['req.headers.authorization', 'req.headers["x-access-token"]'];

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const UUID_RE = new RegExp(UUID);
const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const TIME = '^([01]\\d|2[0-3]):[0-5]\\d$';

const Order = {
  order_no: Type.String({ minLength: 1, maxLength: 100 }),
  order_date: Type.String({ pattern: DATE }),
  approved_by: Type.String({ minLength: 1, maxLength: 200 }),
};
const PublishBody = Type.Object({ ...Order, effective_from: Type.String({ pattern: DATE }) }, { additionalProperties: false });
const OrderBody = Type.Object(Order, { additionalProperties: false });
const FromBody = Type.Object({ from: Type.String({ pattern: DATE }) }, { additionalProperties: false });
const MoveBody = Type.Object({ day: Type.Integer({ minimum: 1, maximum: 6 }), lesson_no: Type.Integer({ minimum: 1, maximum: 10 }) }, { additionalProperties: false });
const Bell = Type.Object(
  { lesson_no: Type.Integer({ minimum: 1, maximum: 10 }), start: Type.String({ pattern: TIME }), end: Type.String({ pattern: TIME }) },
  { additionalProperties: false },
);
const HoursBody = Type.Object({ minutes: Type.Integer({ minimum: 0, maximum: 1440 }) }, { additionalProperties: false });
const HolidaysBody = Type.Object(
  { holiday_from: Type.Union([Type.String({ pattern: DATE }), Type.Null()]), holiday_to: Type.Union([Type.String({ pattern: DATE }), Type.Null()]) },
  { additionalProperties: false },
);
const AbsenceBody = Type.Object(
  {
    teacher_id: Type.String({ pattern: UUID }),
    date_from: Type.String({ pattern: DATE }),
    date_to: Type.String({ pattern: DATE }),
    lesson_nos: Type.Optional(Type.Union([Type.Array(Type.Integer({ minimum: 1, maximum: 10 }), { maxItems: 10 }), Type.Null()])),
  },
  { additionalProperties: false },
);
const ApproveBody = Type.Object(
  {
    cancel: Type.Optional(
      Type.Array(Type.Object({ class_id: Type.String({ pattern: UUID }), lesson_no: Type.Integer({ minimum: 1, maximum: 10 }) }, { additionalProperties: false }), {
        maxItems: 100,
      }),
    ),
  },
  { additionalProperties: false },
);

function ctxOf(request: FastifyRequest): Ctx {
  const a = actorOf(request);
  return { schoolId: a.schoolId, actor: a.actor, correlationId: request.id };
}

const notFound = () => new ProblemError(problem(404, 'not_found', 'Не знайдено'));

function uuidOf(value: string): string {
  if (!UUID_RE.test(value)) throw notFound();
  return value.toLowerCase();
}

/** '{uuid}:{дія}' → [id, дія]; невідома дія чи не-uuid — 404. */
function action(param: string, allowed: readonly string[]): [string, string] {
  const i = param.lastIndexOf(':');
  if (i < 0) throw notFound();
  const verb = param.slice(i + 1);
  if (!allowed.includes(verb)) throw notFound();
  return [uuidOf(param.slice(0, i)), verb];
}

/** Перевірка тіла для маршрутів з кількома діями (схему не можна закріпити за маршрутом). */
function body<T extends TSchema>(schema: T, value: unknown): Type.Static<T> {
  if (!Value.Check(schema, value ?? {})) {
    const first = [...Value.Errors(schema, value ?? {})][0];
    throw new ProblemError(problem(400, 'validation_failed', 'Некоректні дані', first ? `${first.instancePath || '/'} ${first.message}` : undefined));
  }
  return (value ?? {}) as Type.Static<T>;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? { level: process.env.LOG_LEVEL ?? 'info', redact: LOG_REDACT },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  installErrorHandlers(app);

  app.get('/health', async (_request, reply) => {
    try {
      await sql`select 1`.execute(deps.db);
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'db_unavailable' });
    }
  });

  app.all(`${API_PREFIX}/internal/*`, async (_request, reply) => sendProblem(reply, problem(404, 'not_found', 'Не знайдено')));

  // ───────────── публічний доступ за QR ─────────────
  app.get(`${PUBLIC_PREFIX}/timetable`, async (request, reply) => {
    reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex').header('referrer-policy', 'no-referrer');
    const raw = request.headers['x-access-token'];
    const access = await verifyAccess(deps.db, deps.qrSecret, Array.isArray(raw) ? raw[0] : raw);
    // Невідомий, відкликаний чи з неправильним HMAC — однакова відповідь.
    if (!access) return sendProblem(reply, problem(404, 'not_found', 'Посилання недійсне. Зверніться до закладу'));
    return publicTimetable(deps.db, access.schoolId, access.token, deps.now());
  });
  app.all(`${PUBLIC_PREFIX}/*`, async (_request, reply) => sendProblem(reply, problem(404, 'not_found', 'Не знайдено')));

  // ───────────── кабінет укладача ─────────────
  app.register(
    async (r) => {
      r.addHook('preHandler', requireScheduler(deps.verifyToken));
      const t = r.withTypeProvider<TypeBoxTypeProvider>();
      const accepted = (reply: FastifyReply, payload: unknown) => reply.code(202).send(payload);

      // Задачі й версії
      t.post('/timetables::build', async (req, reply) => accepted(reply, await startBuild(deps, ctxOf(req), 'main')));
      t.get('/jobs/:id', async (req) => getJob(deps.db, actorOf(req).schoolId, uuidOf((req.params as { id: string }).id)));
      t.get('/timetables', async (req) => listVersions(deps, actorOf(req).schoolId));
      t.get('/timetables/:id', async (req) => getVersion(deps, actorOf(req).schoolId, uuidOf((req.params as { id: string }).id)));
      t.get('/timetables/:id/load', async (req) => getLoad(deps, actorOf(req).schoolId, uuidOf((req.params as { id: string }).id)));
      t.post('/timetables/:action', async (req, reply) => {
        const [id, verb] = action((req.params as { action: string }).action, ['publish', 'copy']);
        if (verb === 'copy') return reply.code(201).send(await copyVersion(deps, ctxOf(req), id));
        return publishVersion(deps, ctxOf(req), id, body(PublishBody, req.body));
      });
      t.patch('/timetables/:id/lessons/:classId/:day/:lessonNo', { schema: { body: MoveBody } }, async (req) => {
        const p = req.params as { id: string; classId: string; day: string; lessonNo: string };
        const day = Number(p.day);
        const lessonNo = Number(p.lessonNo);
        if (!Number.isInteger(day) || !Number.isInteger(lessonNo)) throw notFound();
        return moveLesson(deps, ctxOf(req), uuidOf(p.id), { class_id: uuidOf(p.classId), day, lesson_no: lessonNo }, req.body);
      });

      // Розклад тривог
      t.get('/alert-plan', async (req) => getAlertPlan(deps.db, actorOf(req).schoolId));
      t.post('/alert-plan::build', async (req, reply) => accepted(reply, await startBuild(deps, ctxOf(req), 'alert')));
      t.get('/alert-plan/bells', async (req) => (await getAlertPlan(deps.db, actorOf(req).schoolId)).bells);
      t.put('/alert-plan/bells', { schema: { body: Type.Array(Bell, { maxItems: 10 }) } }, async (req) => (await putAlertBells(deps, ctxOf(req), req.body)).bells);
      t.post('/alert-plan::approve', { schema: { body: OrderBody } }, async (req) => approveAlertPlan(deps, ctxOf(req), req.body));
      t.post('/alert-plan::activate', { schema: { body: FromBody } }, async (req) => activateAlertPlan(deps, ctxOf(req), req.body.from));
      t.post('/alert-plan/activations/:action', async (req) => {
        const [id] = action((req.params as { action: string }).action, ['end']);
        return endActivation(deps, ctxOf(req), id, body(FromBody, req.body).from);
      });
      t.get('/alert-hours', { schema: { querystring: Type.Object({ from: Type.String({ pattern: DATE }), to: Type.String({ pattern: DATE }) }) } }, async (req) => {
        const { from, to } = req.query;
        if (!isValidDate(from) || !isValidDate(to) || from > to) throw new ProblemError(problem(400, 'validation_failed', 'Некоректний період'));
        return getAlertHours(deps, actorOf(req).schoolId, from, to);
      });
      t.put('/alert-hours/:date', { schema: { body: HoursBody } }, async (req) =>
        putAlertHours(deps, ctxOf(req), (req.params as { date: string }).date, req.body.minutes),
      );

      // Відсутності, заміни, експорт (етап 2)
      t.post('/absences', { schema: { body: AbsenceBody } }, async (req, reply) =>
        accepted(reply, await createAbsence(deps, ctxOf(req), { ...req.body, teacher_id: req.body.teacher_id.toLowerCase() })),
      );
      t.get('/absences', async (req) => listAbsences(deps, actorOf(req).schoolId));
      t.delete('/absences/:id', async (req) => {
        await cancelAbsence(deps, ctxOf(req), uuidOf((req.params as { id: string }).id));
        return { cancelled: true };
      });
      t.get('/substitutions', { schema: { querystring: Type.Object({ date: Type.String({ pattern: DATE }) }) } }, async (req) =>
        listSubstitutions(deps.db, actorOf(req).schoolId, req.query.date),
      );
      t.post('/substitutions/:action', async (req) => {
        const [jobId, verb] = action((req.params as { action: string }).action, ['approve', 'reject']);
        if (verb === 'reject') return rejectSubstitution(deps, ctxOf(req), jobId);
        const cancel = (body(ApproveBody, req.body).cancel ?? []).map((c) => ({ ...c, class_id: c.class_id.toLowerCase() }));
        return approveSubstitution(deps, ctxOf(req), jobId, cancel);
      });
      t.get('/teachers/:id/export', async (req, reply) =>
        reply.header('cache-control', 'no-store').send(await exportTeacher(deps, ctxOf(req), uuidOf((req.params as { id: string }).id))),
      );

      // Канікули (етап 2)
      t.get('/holidays', async (req) => getHolidays(deps, actorOf(req).schoolId));
      t.put('/holidays', { schema: { body: HolidaysBody } }, async (req) => putHolidays(deps, ctxOf(req), req.body));

      // QR у кабінеті
      t.get('/access-tokens', { schema: { querystring: Type.Object({ type: Type.Union([Type.Literal('class'), Type.Literal('teacher')]) }) } }, async (req, reply) =>
        reply.header('cache-control', 'no-store').send(await listAccessTokens(deps, ctxOf(req), req.query.type)),
      );
      t.post('/access-tokens/:action', async (req, reply) => {
        const [id] = action((req.params as { action: string }).action, ['rotate']);
        return reply.header('cache-control', 'no-store').send(await rotateAccessToken(deps, ctxOf(req), id));
      });
    },
    { prefix: API_PREFIX },
  );

  return app;
}

export function installErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ProblemError) return sendProblem(reply, err.problem);
    if (err instanceof SchoolUnavailableError) {
      request.log.error({ err }, 'school-service недоступний');
      return sendProblem(reply, problem(503, 'school_unavailable', 'Дані закладу тимчасово недоступні', 'Спробуйте ще раз за хвилину'));
    }
    const e = err as { validation?: unknown; statusCode?: number; message: string; code?: string };
    if (e.code === '22P02' || e.code === '22007' || e.code === '22008') {
      return sendProblem(reply, problem(400, 'validation_failed', 'Некоректні дані'));
    }
    if (e.validation || (e.statusCode && e.statusCode >= 400 && e.statusCode < 500)) {
      return sendProblem(reply, problem(400, 'validation_failed', 'Некоректні дані', e.message));
    }
    request.log.error({ err }, 'необроблена помилка');
    return sendProblem(reply, problem(500, 'internal', 'Внутрішня помилка'));
  });
  app.setNotFoundHandler((_request, reply) => sendProblem(reply, problem(404, 'not_found', 'Не знайдено')));
}
