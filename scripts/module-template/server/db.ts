import Database from 'better-sqlite3';

/**
 * Open (or create) the database and ensure the schema exists.
 *
 * The example domain is deliberately small — items with a status — so it is
 * obvious what to replace. Keep the shape of what replaces it:
 *
 * - **State that can be derived is never stored.** Totals, balances, levels and
 *   deadlines are computed from the rows they come from, so they cannot drift.
 * - **History is append-only.** `item_events` is only ever inserted into; the
 *   current status of an item is its row, and how it got there is the events.
 * - **Every write names the person.** `actor` is whoever the session belongs to
 *   (`auth.ts`) — a PS-01 identity, or the local admin — never a service account.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT    NOT NULL,
      notes       TEXT,
      status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'archived')),
      created_at  TEXT    NOT NULL,
      updated_at  TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS item_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      type        TEXT    NOT NULL,
      actor       TEXT    NOT NULL,
      at          TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_item_events_item ON item_events(item_id);
  `);

  return db;
}
