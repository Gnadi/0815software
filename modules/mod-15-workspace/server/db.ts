import Database from 'better-sqlite3';

/**
 * Open (or create) the database and ensure the schema exists.
 *
 * The Workspace stores almost nothing, and that is the design. It holds
 * LAYOUTS — which widgets you put where — and never a copy of what a widget
 * shows. Every figure on the board is fetched live from the module that owns
 * it, so there is no cache to invalidate, no second source of truth for a
 * number, and nothing here that could disagree with a module's own screens.
 *
 * Three rules everything else follows:
 *
 * 1. BOARDS ARE PER PERSON. Every row is owned by an actor — a PS-01 identity
 *    when SSO is configured, the local admin otherwise. Two people sharing a
 *    stack do not share a layout, and neither can see the other's.
 *
 * 2. A WIDGET IS A REFERENCE, NOT A COPY. `module_id` + `widget_key` name
 *    something in a peer's summary. If that peer is removed from the stack, or
 *    stops offering that key, the widget stays on the board and renders as
 *    unavailable — deleting someone's layout because a module was down for a
 *    minute would be the worse failure.
 *
 * 3. NO CACHED PEER DATA. Deliberately absent: any table holding summaries,
 *    tiles or activity. It would make the board fast and wrong, and "wrong but
 *    fast" is not a trade a dashboard gets to make.
 *
 *    `server/peers.ts` does share a fan-out that is already IN FLIGHT between
 *    simultaneous readers, which is deduplication rather than caching: nothing
 *    is retained once the request settles, and every figure is still one a
 *    module produced for that very request.
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

    CREATE TABLE IF NOT EXISTS widgets (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL
                   CHECK (kind IN ('tile', 'list', 'activity', 'launcher', 'embed')),
      module_id  TEXT,
      widget_key TEXT,
      x          INTEGER NOT NULL DEFAULT 0,
      y          INTEGER NOT NULL DEFAULT 0,
      w          INTEGER NOT NULL DEFAULT 3,
      h          INTEGER NOT NULL DEFAULT 2,
      -- The shell's own widgets name no module; a peer-fed one names both.
      -- A half-filled reference is unrepresentable rather than merely unlikely.
      CHECK ((kind IN ('activity', 'launcher')) = (module_id IS NULL)),
      CHECK ((widget_key IS NULL) OR (module_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_widgets_board ON widgets (board_id);

    -- One row per person: which board they were last on, and the context bar's
    -- current selection. Both are view state, which is why losing this file
    -- costs a preference and never a record.
    CREATE TABLE IF NOT EXISTS preferences (
      owner        TEXT PRIMARY KEY,
      active_board INTEGER REFERENCES boards(id) ON DELETE SET NULL,
      context      TEXT NOT NULL DEFAULT '{}'
    );
  `);

  return db;
}
