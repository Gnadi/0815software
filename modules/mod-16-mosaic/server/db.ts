import Database from 'better-sqlite3';

/**
 * Open (or create) the database and ensure the schema exists.
 *
 * This module stores LAYOUTS and nothing else — which module sits where, and
 * how big. Not a byte of what a pane displays lives here, because a pane is
 * not a rendering of a module's data: it IS the module, running in its own
 * process behind its own login, drawn into a frame. There is nothing to cache
 * and nothing that could disagree with the real thing.
 *
 * Two rules the rest follows:
 *
 * 1. BOARDS ARE PER PERSON. Every row is owned by an actor — a PS-01 identity
 *    when SSO is configured, the local admin otherwise. Two people sharing a
 *    stack do not share an arrangement, and neither can see the other's.
 *
 * 2. A PANE IS A REFERENCE. `module_id` names something in the stack. Remove
 *    that module and the pane stays on the board, rendering as unavailable —
 *    deleting someone's layout because a module was down for a minute would be
 *    the worse failure.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      owner      TEXT NOT NULL,
      name       TEXT NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_boards_owner ON boards (owner, position);

    CREATE TABLE IF NOT EXISTS panes (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id  INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      -- Never null: a pane without a module is an empty rectangle. The
      -- Workspace's widgets can belong to the shell itself; these cannot.
      module_id TEXT NOT NULL,
      x         INTEGER NOT NULL DEFAULT 0,
      y         INTEGER NOT NULL DEFAULT 0,
      w         INTEGER NOT NULL DEFAULT 6,
      h         INTEGER NOT NULL DEFAULT 6,
      -- The same module twice on one board is allowed on purpose: two views of
      -- one application side by side is a reason people want a tiling shell.
      CHECK (w > 0 AND h > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_panes_board ON panes (board_id);

    -- One row per person: which board they were last on. View state, which is
    -- why losing this file costs an arrangement and never a record.
    CREATE TABLE IF NOT EXISTS preferences (
      owner        TEXT PRIMARY KEY,
      active_board INTEGER REFERENCES boards(id) ON DELETE SET NULL
    );
  `);

  return db;
}
