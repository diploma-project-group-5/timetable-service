// Фонові завдання під роллю timetable_maint (розділи 05, 13): сторож задач раз на хвилину,
// щоденна чистка надісланих рядків outbox і рядків inbox, старших за 7 днів (у solve.* є підписи).
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import type { Db } from './db/index.js';
import { runWatchdog } from './domain/jobs.js';

export async function cleanup(maintDb: Db, now: Date = new Date()): Promise<{ outbox: number; inbox: number }> {
  const outbox = await maintDb
    .deleteFrom('outbox')
    .where('published_at', 'is not', null)
    .where('published_at', '<', sql<Date>`${now}::timestamptz - interval '7 days'`)
    .executeTakeFirst();
  const inbox = await maintDb.deleteFrom('inbox').where('received_at', '<', sql<Date>`${now}::timestamptz - interval '7 days'`).executeTakeFirst();
  return { outbox: Number(outbox.numDeletedRows), inbox: Number(inbox.numDeletedRows) };
}

export function scheduleMaintenance(maintDb: Db, log: FastifyBaseLogger): () => void {
  const watchdog = setInterval(() => {
    runWatchdog(maintDb)
      .then((n) => n > 0 && log.warn({ failed: n }, 'сторож закрив прострочені задачі'))
      .catch((err) => log.error({ err }, 'сторож задач не спрацював'));
  }, 60_000);
  const daily = () =>
    cleanup(maintDb)
      .then((r) => log.info(r, 'щоденна чистка'))
      .catch((err) => log.error({ err }, 'щоденна чистка не вдалася'));
  const first = setTimeout(daily, 60_000);
  const day = setInterval(daily, 24 * 60 * 60 * 1000);
  for (const t of [watchdog, first, day]) t.unref();
  return () => {
    clearInterval(watchdog);
    clearTimeout(first);
    clearInterval(day);
  };
}
