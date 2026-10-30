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
 * 3. SLA IS DERIVED FROM THE CLOCK. Breach is computed on every read from
 *    `now`, the due times (created_at + the priority's target, counted
 *    around the clock or in business hours, minus any wait on the
 *    requester) and the derived actuals. No breach flag is ever stored; the
 *    policy a ticket is held to is the version in force when it came in.
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

    -- Files that came with an event (the opening request or a comment).
    -- Who may see one is the event's visibility — never a column of its own.
    -- Kept here, in the module's own database, so the module needs no file
    -- service and a backup of the database carries them; PS-06 gets a copy
    -- when FILES_URL is set. Append-only, like the events.
    CREATE TABLE IF NOT EXISTS attachments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id    INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      event_id     INTEGER NOT NULL REFERENCES ticket_events(id) ON DELETE CASCADE,
      filename     TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size         INTEGER NOT NULL,
      sha256       TEXT NOT NULL,
      content      BLOB NOT NULL,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_event ON attachments (event_id);

    -- Canned responses: the team's templates, kept by a manager.
    CREATE TABLE IF NOT EXISTS canned_responses (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      body       TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- The SLA policy, one row per saved version — append-only. A ticket is
    -- held to the version in force when it came in, so changing the targets
    -- tomorrow does not rewrite last month's verdicts. No row: the built-in
    -- defaults (server/sla-config.ts).
    CREATE TABLE IF NOT EXISTS sla_policies (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      policy     TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Everything else an administrator sets in the UI: satisfaction ratings,
    -- replies by email, the mailbox. One row.
    CREATE TABLE IF NOT EXISTS helpdesk_settings (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      settings   TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Satisfaction ratings: one per resolution (the status_change that
    -- resolved the ticket), so a ticket reopened and resolved again can be
    -- rated again. Append-only.
    CREATE TABLE IF NOT EXISTS csat_ratings (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id           INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      resolution_event_id INTEGER NOT NULL UNIQUE REFERENCES ticket_events(id) ON DELETE CASCADE,
      score               INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
      comment             TEXT,
      created_at          TEXT NOT NULL
    );

    -- Each message taken from the mailbox, once (dedupe_key is the
    -- Message-ID), and what became of it. A message seen again — the mailbox
    -- was not told in time that we had it — is recognised here and not
    -- turned into a second ticket.
    CREATE TABLE IF NOT EXISTS mail_ingests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key    TEXT NOT NULL UNIQUE,
      message_id    TEXT,
      connection_id INTEGER NOT NULL,
      uid           INTEGER NOT NULL,
      from_address  TEXT,
      subject       TEXT NOT NULL,
      action        TEXT NOT NULL CHECK (action IN ('created', 'appended', 'noted', 'ignored', 'failed')),
      reason        TEXT,
      ticket_ref    TEXT,
      received_at   TEXT NOT NULL
    );
  `);

  return db;
}
