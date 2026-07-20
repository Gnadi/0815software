import type { Report, Schedule, ScheduleInterval } from '../shared/types.js';
import { executeRun, type RunContext } from './runs.js';

const INTERVAL_MS: Record<ScheduleInterval, number> = {
  hourly: 3600_000,
  daily: 86_400_000,
};

/**
 * Next-due time for a schedule, DERIVED from its cadence and last run —
 * never stored, so it can never drift. A schedule that has never run is
 * due immediately (returns its creation time). There is deliberately NO
 * catch-up backfill: if the server was down across several intervals, the
 * schedule runs ONCE on the next tick and the clock restarts from there.
 */
export function nextDueAt(schedule: Pick<Schedule, 'interval' | 'last_run_at' | 'created_at'>): string {
  if (!schedule.last_run_at) return schedule.created_at;
  const last = Date.parse(schedule.last_run_at);
  return new Date(last + INTERVAL_MS[schedule.interval]).toISOString();
}

export function isDue(
  schedule: Pick<Schedule, 'interval' | 'last_run_at' | 'created_at' | 'enabled'>,
  now = Date.now(),
): boolean {
  if (!schedule.enabled) return false;
  return Date.parse(nextDueAt(schedule)) <= now;
}

/**
 * One scheduler tick: find every enabled, due schedule and run it once,
 * stamping `last_run_at`. Exposed (not just the interval timer) so tests
 * can drive it deterministically. Returns the ids of the runs it created.
 */
export function tick(ctx: RunContext, now = Date.now()): number[] {
  const schedules = ctx.db
    .prepare('SELECT * FROM schedules WHERE enabled = 1')
    .all() as Schedule[];
  const created: number[] = [];
  for (const schedule of schedules) {
    if (!isDue(schedule, now)) continue;
    const report = ctx.db.prepare('SELECT * FROM reports WHERE id = ?').get(schedule.report_id) as
      | Report
      | undefined;
    if (!report) continue;
    const runId = executeRun(ctx, report, 'scheduled', schedule.id);
    ctx.db
      .prepare('UPDATE schedules SET last_run_at = ? WHERE id = ?')
      .run(new Date(now).toISOString(), schedule.id);
    created.push(runId);
  }
  return created;
}

/**
 * Start the in-process scheduler: a plain setInterval that calls tick()
 * every `tickSeconds`. Returns a stop function. This runs only while the
 * server process is up — there is no external cron; see the README's
 * scheduling limitations section.
 */
export function startScheduler(ctx: RunContext, tickSeconds: number): () => void {
  const handle = setInterval(() => {
    try {
      tick(ctx);
    } catch (err) {
      console.error('[mod-08] scheduler tick failed:', (err as Error).message);
    }
  }, tickSeconds * 1000);
  // Don't keep the event loop alive just for the scheduler.
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}
