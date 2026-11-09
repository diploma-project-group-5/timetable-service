// Машина станів задачі (розділ 05; contracts/vectors/job-lifecycle):
//   solve.started — лише з queued → running (started_at, run_deadline_at);
//   solve.completed — з будь-якого некінцевого стану; подія для кінцевого стану ігнорується;
//   сторож: queued після queue_deadline_at або running після run_deadline_at → failed.
// solver комітить offset до розрахунку, тож completed може прийти без started.
import type { JobState } from '../db/index.js';

export const TERMINAL: readonly JobState[] = ['done', 'infeasible', 'rejected', 'timeout', 'failed'];
export const isTerminal = (s: JobState) => TERMINAL.includes(s);

export type SolveStatus = 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN' | 'MODEL_INVALID' | 'EXPIRED';

export interface JobTimes {
  state: JobState;
  time_limit_s: number;
  queue_deadline_at: Date;
  run_deadline_at: Date | null;
}

export type StartedDecision = { accept: false } | { accept: true; started_at: Date; run_deadline_at: Date };

export function onStarted(job: JobTimes, startedAt: Date, marginS: number): StartedDecision {
  if (job.state !== 'queued') return { accept: false };
  return { accept: true, started_at: startedAt, run_deadline_at: new Date(startedAt.getTime() + (job.time_limit_s + marginS) * 1000) };
}

/**
 * Стан після solve.completed або null, якщо подію треба відкинути. Для OPTIMAL/FEASIBLE повертає
 * 'done' — остаточно done чи rejected вирішує перевірка validator-lib.
 */
export function onCompleted(job: Pick<JobTimes, 'state'>, status: SolveStatus): JobState | null {
  if (isTerminal(job.state)) return null;
  switch (status) {
    case 'OPTIMAL':
    case 'FEASIBLE':
      return 'done';
    case 'INFEASIBLE':
      return 'infeasible';
    case 'UNKNOWN':
      return 'timeout';
    case 'MODEL_INVALID':
    case 'EXPIRED':
      return 'failed';
  }
}

/** Чи закриває сторож задачу в момент now. */
export function watchdogExpires(job: JobTimes, now: Date): boolean {
  if (job.state === 'queued') return job.queue_deadline_at.getTime() < now.getTime();
  if (job.state === 'running') return job.run_deadline_at !== null && job.run_deadline_at.getTime() < now.getTime();
  return false;
}

export const SOLVE_STATUSES: readonly SolveStatus[] = ['OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'UNKNOWN', 'MODEL_INVALID', 'EXPIRED'];
