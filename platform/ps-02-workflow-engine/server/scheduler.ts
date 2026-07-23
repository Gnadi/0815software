import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';
import { startInstance } from './events.js';

/**
 * Interval scheduler, modelled on mod-08: a schedule trigger fires when
 * `now - last_run_at >= interval_seconds`. There is NO catch-up backfill —
 * a trigger that missed several intervals fires exactly once on the next
 * due tick. The clock is injected so tests are deterministic.
 */

interface ScheduleTriggerRow {
  id: number;
  workflow_key: string;
  config: string; // { interval_seconds: number }
  last_run_at: string | null;
}

function intervalSeconds(config: string): number {
  const parsed = JSON.parse(config) as { interval_seconds?: number };
  return typeof parsed.interval_seconds === 'number' && parsed.interval_seconds > 0
    ? parsed.interval_seconds
    : 3600;
}

export function isDue(lastRunAt: string | null, intervalSec: number, now: number): boolean {
  if (lastRunAt === null) return true;
  return now - Date.parse(lastRunAt) >= intervalSec * 1000;
}

export function nextDueAt(lastRunAt: string | null, intervalSec: number, now: number): string {
  const base = lastRunAt === null ? now : Date.parse(lastRunAt);
  return nowIso(base + intervalSec * 1000);
}

/** Fire every due schedule trigger once and stamp its last_run_at. */
export function runSchedules(db: Database.Database, now = Date.now()): number {
  const triggers = db
    .prepare(`SELECT id, workflow_key, config, last_run_at FROM triggers WHERE type = 'schedule' AND enabled = 1`)
    .all() as ScheduleTriggerRow[];

  let fired = 0;
  for (const trigger of triggers) {
    if (!isDue(trigger.last_run_at, intervalSeconds(trigger.config), now)) continue;
    startInstance(db, { key: trigger.workflow_key, triggerId: trigger.id, now });
    db.prepare('UPDATE triggers SET last_run_at = ? WHERE id = ?').run(nowIso(now), trigger.id);
    fired++;
  }
  return fired;
}
