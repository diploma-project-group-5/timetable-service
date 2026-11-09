// Залежності предметної логіки і контекст запиту. now() підміняється в тестах (Europe/Kyiv, сторож).
import type { Policy } from '../config.js';
import { writeOutbox } from '../db/events.js';
import type { Db, Trx } from '../db/index.js';
import type { SnapshotFetcher } from '../school-client.js';

export interface Deps {
  db: Db;
  fetchSnapshot: SnapshotFetcher;
  policy: Policy;
  qrSecret: string;
  publicUrl: string;
  now: () => Date;
}

export interface Ctx {
  schoolId: string;
  /** Логін укладача; для журналу. */
  actor: string;
  correlationId: string;
}

/**
 * Запис журналу дій закладу живе в school-service: timetable надсилає audit.recorded через outbox
 * у тій самій транзакції, що й дію, тож запис не губиться (розділ 09). Лише ідентифікатори.
 */
export async function recordAudit(
  trx: Trx,
  ctx: Ctx,
  action: string,
  target: string | null,
  details: Record<string, unknown> = {},
  at: Date = new Date(),
): Promise<void> {
  await writeOutbox(trx, {
    topic: 'audit.recorded',
    schoolId: ctx.schoolId,
    correlationId: ctx.correlationId,
    data: { at: at.toISOString(), actor: ctx.actor, action, target, details },
  });
}
