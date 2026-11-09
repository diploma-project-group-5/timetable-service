// Помилки у форматі application/problem+json (розділ 07): type, title, status, detail, code, conflicts[].
import type { FastifyReply } from 'fastify';

export type ProblemCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'profile_incomplete'
  | 'build_in_progress'
  | 'stale'
  | 'published_readonly'
  | 'conflicts'
  | 'effective_from_too_early'
  | 'not_school_day'
  | 'already_published'
  | 'alert_plan_active'
  | 'alert_plan_locked'
  | 'alert_plan_missing'
  | 'alert_plan_not_approved'
  | 'activation_overlap'
  | 'invalid_date'
  | 'no_timetable'
  | 'teacher_not_found'
  | 'no_lessons'
  | 'job_not_ready'
  | 'slot_taken'
  | 'school_unavailable'
  | 'internal';

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ProblemCode;
  detail?: string;
  conflicts?: unknown[];
  [extra: string]: unknown;
}

export function problem(status: number, code: ProblemCode, title: string, detail?: string, extra: Record<string, unknown> = {}): Problem {
  return { type: `urn:lad:problem:${code}`, title, status, code, ...(detail ? { detail } : {}), ...extra };
}

export function sendProblem(reply: FastifyReply, p: Problem): FastifyReply {
  return reply.code(p.status).type('application/problem+json').send(p);
}

export class ProblemError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ProblemError';
  }
}

export const fail = (status: number, code: ProblemCode, title: string, detail?: string, extra: Record<string, unknown> = {}): never => {
  throw new ProblemError(problem(status, code, title, detail, extra));
};
