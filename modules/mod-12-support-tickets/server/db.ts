import Database from 'better-sqlite3';

/**
 * Open (or create) the database and ensure the schema exists.
 *
 * The design rules everything else hangs off (MOD-06's ledger philosophy,
 * adapted to a help desk):
 *
 * 1. NO STORED DERIVED STATE. A `tickets` row holds only the immutable
 *    facts of intake: its ref, the requester, the subject and body, and
 *    when it arrived. A ticket's CURRENT status, priority and assignee —
 *    and its first-response and resolution times — are folded from the
 *    `ticket_events` stream at read time (server/tickets.ts). They can
 *    never drift because they are never written down.
 *
 * 2. THE TIMELINE IS APPEND-ONLY. Every triage action — a status change,
 *    a priority change, an assignment, a public reply, an internal note —
 *    is a new `ticket_events` row. Rows are never updated or deleted, so
 *    the audit trail (including who was assigned when) survives forever.
 *
 * 3. SLA IS DERIVED FROM THE WALL CLOCK. Breach is computed on every read
 *    from `now` versus the due times (created_at + the priority's target)
 *    and the derived actuals. No breach flag is ever stored.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ref             TEXT NOT NULL UNIQUE,
      requester_name  TEXT NOT NULL,
      requester_email TEXT NOT NULL,
      subject         TEXT NOT NULL,
      body            TEXT NOT NULL,
      created_at      TEXT NOT NULL
    );

    -- Append-only timeline. One row per action; never updated or deleted.
    -- payload is JSON carrying the type-specific fields (from/to status,
    -- priority change, assignee, comment body). visibility is set only on
    -- comment rows: 'public' replies reach the requester, 'internal' notes
    -- never do.
    CREATE TABLE IF NOT EXISTS ticket_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      type       TEXT NOT NULL
                   CHECK (type IN ('created','status_change','priority_change','assignment','comment')),
      actor      TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('agent','requester','system')),
      visibility TEXT CHECK (visibility IN ('public','internal')),
      payload    TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      -- visibility belongs to comments only
      CHECK ((type = 'comment') = (visibility IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events (ticket_id, created_at, id);

    -- Per-year sequence for the human ref (TKT-<year>-<seq>).
    CREATE TABLE IF NOT EXISTS ticket_counters (
      year     INTEGER PRIMARY KEY,
      last_seq INTEGER NOT NULL
    );
  `);

  return db;
}
