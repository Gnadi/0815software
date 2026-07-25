import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';
import { DomainError } from './errors.js';
import { PERIODS, type NextNumber, type Period, type SequenceConfig } from '../shared/types.js';

const DEFAULT_FORMAT = '{YYYY}-{seq:0000}';

function isPeriod(v: unknown): v is Period {
  return typeof v === 'string' && (PERIODS as readonly string[]).includes(v);
}

/** The period key the counter resets on, derived from the clock. */
export function periodKey(period: Period, now: number): string {
  if (period === 'none') return '';
  const d = new Date(now);
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  if (period === 'year') return y;
  if (period === 'month') return `${y}-${m}`;
  return `${y}-${m}-${day}`;
}

/** Render a format string with the sequence value and calendar tokens. */
export function formatNumber(format: string, seq: number, now: number): string {
  const d = new Date(now);
  const y = String(d.getUTCFullYear());
  return format
    .replace(/\{seq(?::(0+))?\}/g, (_m, pad: string | undefined) => (pad ? String(seq).padStart(pad.length, '0') : String(seq)))
    .replace(/\{YYYY\}/g, y)
    .replace(/\{YY\}/g, y.slice(-2))
    .replace(/\{MM\}/g, String(d.getUTCMonth() + 1).padStart(2, '0'))
    .replace(/\{DD\}/g, String(d.getUTCDate()).padStart(2, '0'));
}

interface SeqRow {
  scope: string;
  format: string;
  period: Period;
  created_at: string;
}

export function getConfig(db: Database.Database, scope: string): SequenceConfig | undefined {
  const row = db.prepare('SELECT * FROM sequences WHERE scope = ?').get(scope) as SeqRow | undefined;
  return row ? { scope: row.scope, format: row.format, period: row.period, created_at: row.created_at } : undefined;
}

export function listConfigs(db: Database.Database): SequenceConfig[] {
  return db.prepare('SELECT * FROM sequences ORDER BY scope').all() as SequenceConfig[];
}

/** Configure (or reconfigure) a scope's format and period. */
export function configure(
  db: Database.Database,
  scope: string,
  format: string,
  period: unknown = 'none',
  now = Date.now(),
): SequenceConfig {
  if (!/\{seq(:0+)?\}/.test(format)) {
    throw new DomainError(422, 'Validation failed', [{ field: 'format', message: 'must contain a {seq} token' }]);
  }
  if (!isPeriod(period)) {
    throw new DomainError(422, 'Validation failed', [{ field: 'period', message: `must be one of: ${PERIODS.join(', ')}` }]);
  }
  db.prepare(
    `INSERT INTO sequences (scope, format, period, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET format = excluded.format, period = excluded.period`,
  ).run(scope, format, period, nowIso(now));
  return getConfig(db, scope)!;
}

/**
 * Atomically allocate the next number for a scope. Gapless within the current
 * period; a new period key restarts at 1. Auto-creates a default config for an
 * unknown scope so `next` always works.
 */
export function next(db: Database.Database, scope: string, now = Date.now()): NextNumber {
  return db.transaction((): NextNumber => {
    let config = getConfig(db, scope);
    if (!config) config = configure(db, scope, DEFAULT_FORMAT, 'none', now);
    const key = periodKey(config.period, now);
    const seq = (
      db
        .prepare(
          `INSERT INTO counters (scope, period_key, last_seq) VALUES (?, ?, 1)
           ON CONFLICT(scope, period_key) DO UPDATE SET last_seq = last_seq + 1
           RETURNING last_seq`,
        )
        .get(scope, key) as { last_seq: number }
    ).last_seq;
    return { scope, value: seq, period_key: key, formatted: formatNumber(config.format, seq, now) };
  })();
}

/** Read a scope's current value without incrementing (for display/preview). */
export function peek(db: Database.Database, scope: string, now = Date.now()): { scope: string; last_value: number; period_key: string } {
  const config = getConfig(db, scope);
  const key = periodKey(config?.period ?? 'none', now);
  const row = db.prepare('SELECT last_seq FROM counters WHERE scope = ? AND period_key = ?').get(scope, key) as
    | { last_seq: number }
    | undefined;
  return { scope, last_value: row?.last_seq ?? 0, period_key: key };
}
