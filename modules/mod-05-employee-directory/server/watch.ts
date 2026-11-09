import type Database from 'better-sqlite3';
import type { People } from './people.js';

/**
 * The notification watcher (copy-in): reads what this module has APPENDED
 * since it last looked — its event logs are append-only — and turns the rows
 * that matter to someone into notifications (`server/inbox-rules.ts`). Plus,
 * once a minute, the checks that depend on the clock (an SLA about to break,
 * a deadline tomorrow).
 *
 * Reading the log rather than hooking every route is the point: a ticket can
 * arrive by the web form, by mail or by the mailbox poller, and all three
 * leave the same row behind. One reader catches them all, and a route added
 * next year is covered without anyone remembering to call anything.
 *
 * The position in each log is kept in `notify_cursors`, so a restart picks up
 * where it stopped and a fresh install starts at the end — never a flood of
 * last year's events. Every notification carries a key, so reading a row
 * twice (a crash between sending and saving the cursor) tells nobody twice.
 */

export function ensureCursorTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS notify_cursors (stream TEXT PRIMARY KEY, last_id INTEGER NOT NULL)`);
}

/**
 * Hand every row of `table` after the saved position to `handle`, oldest
 * first, then move the position. On the very first read the position is set
 * to the newest row and nothing is handed over.
 */
export function consume<T extends { id: number }>(
  db: Database.Database,
  stream: string,
  table: string,
  handle: (row: T) => void,
  limit = 500,
): number {
  ensureCursorTable(db);
  const saved = db.prepare('SELECT last_id FROM notify_cursors WHERE stream = ?').get(stream) as { last_id: number } | undefined;
  if (!saved) {
    const max = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get() as { m: number }).m;
    db.prepare('INSERT INTO notify_cursors (stream, last_id) VALUES (?, ?)').run(stream, max);
    return 0;
  }
  const rows = db.prepare(`SELECT * FROM ${table} WHERE id > ? ORDER BY id LIMIT ?`).all(saved.last_id, limit) as T[];
  for (const row of rows) handle(row);
  if (rows.length > 0) db.prepare('UPDATE notify_cursors SET last_id = ? WHERE stream = ?').run(rows[rows.length - 1]!.id, stream);
  return rows.length;
}

export type WatchStep = (db: Database.Database, people: People, nowMs: number) => void;

/** Run `step` now and every `everyMs`, only when notifications are configured. */
export function startWatch(db: Database.Database, people: People, step: WatchStep, everyMs = 60_000): () => void {
  if (!people.enabled) return () => {};
  const run = () => {
    try {
      step(db, people, Date.now());
    } catch (err) {
      console.warn('[watch] notification check failed:', err);
    }
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
