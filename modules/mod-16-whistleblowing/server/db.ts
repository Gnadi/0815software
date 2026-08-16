import Database from 'better-sqlite3';

/**
 * Open (or create) the database and ensure the schema exists.
 *
 * The rules everything else hangs off:
 *
 * 1. **NO STORED DERIVED STATE.** A `cases` row holds only the immutable
 *    facts of intake: its ref, category, the report itself, whatever contact
 *    details the reporter chose to give, the hash of their access code, and
 *    when it arrived. The case's CURRENT status and outcome, and both
 *    statutory deadlines, are folded from the `case_events` stream at read
 *    time. They cannot drift because they are never written down.
 *
 * 2. **THE TRAIL IS APPEND-ONLY.** Every acknowledgement, status change,
 *    message and erasure is a new `case_events` row. Rows are never updated
 *    or deleted. In a procedure that may end up in front of a labour court,
 *    "who knew what, when" is the record that matters.
 *
 * 3. **NOTHING IDENTIFIES THE REPORTER.** There is no IP column, no user
 *    agent, no session, no `created_by`. Not "we do not display it" —
 *    there is nowhere to put it. The only reporter-linked value in the whole
 *    schema is `code_hash`, and a hash cannot be turned back into the code
 *    somebody is holding.
 *
 * 4. **ERASURE IS A WRITE, NOT A DELETE.** § 11 Abs. 5 HinSchG says the
 *    documentation is erased three years after the procedure is concluded.
 *    The report body, the contact details and every message body are set to
 *    NULL; the case skeleton and its event trail survive so the organisation
 *    can still prove it ran a compliant procedure — and so the erasure
 *    itself is on the record.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS cases (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ref         TEXT NOT NULL UNIQUE,
      category    TEXT NOT NULL,
      -- subject, body and contact are nullable ONLY because erasure nulls
      -- them together. A live case always has a subject and a body.
      subject     TEXT,
      body        TEXT,
      contact     TEXT,
      -- sha256 of the reporter's access code. The code itself is never
      -- stored, anywhere, in any form.
      code_hash   TEXT NOT NULL UNIQUE,
      received_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cases_code ON cases (code_hash);

    -- Append-only. One row per action; never updated or deleted.
    --   status_change : from_status -> to_status, outcome set when closing
    --   message       : body + visibility ('reporter' is the two-way channel)
    --   erased        : the § 11 Abs. 5 erasure, recorded as it happens
    CREATE TABLE IF NOT EXISTS case_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      type        TEXT NOT NULL
                    CHECK (type IN ('received','status_change','message','erased')),
      actor       TEXT NOT NULL,
      actor_type  TEXT NOT NULL CHECK (actor_type IN ('handler','reporter','system')),
      from_status TEXT,
      to_status   TEXT,
      outcome     TEXT,
      visibility  TEXT CHECK (visibility IN ('reporter','internal')),
      body        TEXT,
      created_at  TEXT NOT NULL,
      -- visibility belongs to messages, and only to messages
      CHECK ((type = 'message') = (visibility IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_events_case ON case_events (case_id, id);

    -- Per-year sequence for the human ref (WB-<year>-<seq>).
    CREATE TABLE IF NOT EXISTS case_counters (
      year     INTEGER PRIMARY KEY,
      last_seq INTEGER NOT NULL
    );
  `);

  return db;
}
