import type Database from 'better-sqlite3';
import {
  GRID_COLUMNS,
  MAX_WIDGET_H,
  MAX_WIDGET_W,
  MIN_WIDGET_H,
  MIN_WIDGET_W,
  WIDGET_KINDS,
  type Board,
  type ShellContext,
  type Widget,
  type WidgetKind,
  type WidgetPlacement,
} from '../shared/types.js';

/**
 * Boards, widgets and the context bar — everything the Workspace itself owns.
 *
 * Every function here is scoped to an OWNER and takes it as its first argument.
 * That is not a convention, it is the isolation: two people on one stack have
 * separate boards, and there is no query in this file that can reach a row
 * belonging to someone else. Asking for another owner's board returns "not
 * found", the same answer as a board that never existed.
 */

export class DomainError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: { field: string; message: string }[],
  ) {
    super(message);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** The board every new person starts with, so nobody meets an empty screen. */
const STARTER_BOARD = 'Overview';

interface BoardRow {
  id: number;
  owner: string;
  name: string;
  position: number;
}

export function listBoards(db: Database.Database, owner: string): Board[] {
  const rows = db
    .prepare('SELECT id, owner, name, position FROM boards WHERE owner = ? ORDER BY position, id')
    .all(owner) as BoardRow[];
  return rows.map((row) => ({ ...row, widgets: widgetsOf(db, row.id) }));
}

function widgetsOf(db: Database.Database, boardId: number): Widget[] {
  return db
    .prepare('SELECT id, board_id, kind, module_id, widget_key, x, y, w, h FROM widgets WHERE board_id = ? ORDER BY y, x, id')
    .all(boardId) as Widget[];
}

/** A board this owner owns, or 404. Never another owner's, ever. */
export function getBoard(db: Database.Database, owner: string, id: number): Board {
  const row = db.prepare('SELECT id, owner, name, position FROM boards WHERE id = ? AND owner = ?').get(id, owner) as
    | BoardRow
    | undefined;
  if (!row) throw new DomainError(404, 'Board not found');
  return { ...row, widgets: widgetsOf(db, row.id) };
}

function validName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '' || name.length > 60) {
    throw new DomainError(422, 'Validation failed', [{ field: 'name', message: 'Name is required (max 60 characters)' }]);
  }
  return name;
}

export function createBoard(db: Database.Database, owner: string, rawName: unknown): Board {
  const name = validName(rawName);
  const next = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM boards WHERE owner = ?').get(owner) as {
    n: number;
  };
  const info = db
    .prepare('INSERT INTO boards (owner, name, position, created_at) VALUES (?, ?, ?, ?)')
    .run(owner, name, next.n, nowIso());
  return getBoard(db, owner, Number(info.lastInsertRowid));
}

export function renameBoard(db: Database.Database, owner: string, id: number, rawName: unknown): Board {
  getBoard(db, owner, id);
  db.prepare('UPDATE boards SET name = ? WHERE id = ? AND owner = ?').run(validName(rawName), id, owner);
  return getBoard(db, owner, id);
}

export function deleteBoard(db: Database.Database, owner: string, id: number): void {
  getBoard(db, owner, id);
  // The last board is not deletable: an owner with no boards would land on a
  // screen with no way back to one, which reads as the app being broken.
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM boards WHERE owner = ?').get(owner) as { n: number };
  if (n <= 1) throw new DomainError(409, 'The last board cannot be deleted');
  db.prepare('DELETE FROM boards WHERE id = ? AND owner = ?').run(id, owner);
}

/**
 * The board an owner should see, creating a starter one on first sight.
 *
 * Called on every board read rather than at login, so a person whose only board
 * was deleted by a concurrent session still gets a working screen instead of an
 * empty one.
 */
export function ensureBoards(db: Database.Database, owner: string): Board[] {
  const existing = listBoards(db, owner);
  if (existing.length > 0) return existing;
  const board = createBoard(db, owner, STARTER_BOARD);
  // A launcher and the activity feed: the two widgets that are useful with no
  // peers configured at all, so a fresh standalone install still shows something
  // true rather than an empty grid.
  addWidget(db, owner, board.id, { kind: 'launcher', x: 0, y: 0, w: 12, h: 2 });
  addWidget(db, owner, board.id, { kind: 'activity', x: 0, y: 2, w: 6, h: 4 });
  return listBoards(db, owner);
}

export interface WidgetInput {
  kind: unknown;
  module_id?: unknown;
  widget_key?: unknown;
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
}

function intIn(raw: unknown, field: string, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new DomainError(422, 'Validation failed', [
      { field, message: `${field} must be a whole number between ${min} and ${max}` },
    ]);
  }
  return value;
}

/**
 * Validate a widget, including the two shape rules the schema also enforces.
 *
 * Checked here as well as in SQLite on purpose: the CHECK constraints make a
 * bad row impossible, but they surface as a 500 with a constraint name. A
 * person adding a widget deserves the field and the reason.
 */
function validWidget(input: WidgetInput): Omit<Widget, 'id' | 'board_id'> {
  const kind = input.kind as WidgetKind;
  if (!WIDGET_KINDS.includes(kind)) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'kind', message: `kind must be one of: ${WIDGET_KINDS.join(', ')}` },
    ]);
  }

  const shellOwned = kind === 'activity' || kind === 'launcher';
  const moduleId = typeof input.module_id === 'string' && input.module_id !== '' ? input.module_id : null;
  const widgetKey = typeof input.widget_key === 'string' && input.widget_key !== '' ? input.widget_key : null;

  if (shellOwned && moduleId !== null) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'module_id', message: `a ${kind} widget belongs to the Workspace and names no module` },
    ]);
  }
  if (!shellOwned && moduleId === null) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'module_id', message: `a ${kind} widget must name the module it shows` },
    ]);
  }
  if ((kind === 'tile' || kind === 'list') && widgetKey === null) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'widget_key', message: `a ${kind} widget must name the key it shows` },
    ]);
  }

  const w = intIn(input.w, 'w', MIN_WIDGET_W, MAX_WIDGET_W, kind === 'tile' ? 3 : 6);
  const x = intIn(input.x, 'x', 0, GRID_COLUMNS - MIN_WIDGET_W, 0);
  if (x + w > GRID_COLUMNS) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'w', message: `a widget at column ${x} can be at most ${GRID_COLUMNS - x} wide` },
    ]);
  }

  return {
    kind,
    module_id: moduleId,
    widget_key: widgetKey,
    x,
    y: intIn(input.y, 'y', 0, 500, 0),
    w,
    h: intIn(input.h, 'h', MIN_WIDGET_H, MAX_WIDGET_H, kind === 'tile' ? 2 : 4),
  };
}

export function addWidget(db: Database.Database, owner: string, boardId: number, input: WidgetInput): Widget {
  getBoard(db, owner, boardId);
  const widget = validWidget(input);
  const info = db
    .prepare(
      'INSERT INTO widgets (board_id, kind, module_id, widget_key, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(boardId, widget.kind, widget.module_id, widget.widget_key, widget.x, widget.y, widget.w, widget.h);
  return db
    .prepare('SELECT id, board_id, kind, module_id, widget_key, x, y, w, h FROM widgets WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as Widget;
}

export function deleteWidget(db: Database.Database, owner: string, boardId: number, widgetId: number): void {
  getBoard(db, owner, boardId);
  const info = db.prepare('DELETE FROM widgets WHERE id = ? AND board_id = ?').run(widgetId, boardId);
  if (info.changes === 0) throw new DomainError(404, 'Widget not found');
}

/**
 * Apply a whole board's layout in one transaction.
 *
 * A drag moves one widget and reflows others, so the client sends the resulting
 * arrangement rather than a sequence of moves. One transaction means a board is
 * never half-rearranged — the failure mode of applying these one at a time is a
 * layout that is neither the old one nor the new one, which nobody can undo.
 */
export function placeWidgets(
  db: Database.Database,
  owner: string,
  boardId: number,
  placements: WidgetPlacement[],
): Board {
  const board = getBoard(db, owner, boardId);
  const known = new Set(board.widgets.map((w) => w.id));

  for (const placement of placements) {
    if (!known.has(placement.id)) throw new DomainError(404, `Widget ${placement.id} is not on this board`);
    const w = intIn(placement.w, 'w', MIN_WIDGET_W, MAX_WIDGET_W, MIN_WIDGET_W);
    const x = intIn(placement.x, 'x', 0, GRID_COLUMNS - MIN_WIDGET_W, 0);
    if (x + w > GRID_COLUMNS) {
      throw new DomainError(422, 'Validation failed', [
        { field: 'w', message: `a widget at column ${x} can be at most ${GRID_COLUMNS - x} wide` },
      ]);
    }
  }

  const update = db.prepare('UPDATE widgets SET x = ?, y = ?, w = ?, h = ? WHERE id = ? AND board_id = ?');
  db.transaction((rows: WidgetPlacement[]) => {
    for (const p of rows) {
      update.run(
        intIn(p.x, 'x', 0, GRID_COLUMNS - MIN_WIDGET_W, 0),
        intIn(p.y, 'y', 0, 500, 0),
        intIn(p.w, 'w', MIN_WIDGET_W, MAX_WIDGET_W, MIN_WIDGET_W),
        intIn(p.h, 'h', MIN_WIDGET_H, MAX_WIDGET_H, MIN_WIDGET_H),
        p.id,
        boardId,
      );
    }
  })(placements);

  return getBoard(db, owner, boardId);
}

// ── Preferences: active board and the context bar ──────────────────────

interface PreferenceRow {
  active_board: number | null;
  context: string;
}

export function readPreferences(db: Database.Database, owner: string): { active_board: number | null; context: ShellContext } {
  const row = db.prepare('SELECT active_board, context FROM preferences WHERE owner = ?').get(owner) as
    | PreferenceRow
    | undefined;
  if (!row) return { active_board: null, context: {} };
  let context: ShellContext = {};
  try {
    const parsed: unknown = JSON.parse(row.context);
    // A hand-edited or corrupt row costs the context bar's selection, not the
    // whole screen — this is view state, and refusing to render a board over it
    // would be the wrong trade.
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) context = parsed as ShellContext;
  } catch {
    context = {};
  }
  return { active_board: row.active_board, context };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate the context bar's selection.
 *
 * Stricter than `parseSummaryContext`, and deliberately so: that one reads a
 * transient query string and shrugs off nonsense, this one persists a choice.
 * A stored context that no module can honour would quietly filter every board
 * this person opens from now on.
 */
export function writeContext(db: Database.Database, owner: string, raw: unknown): ShellContext {
  const input = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const context: ShellContext = {};
  const errors: { field: string; message: string }[] = [];

  if (input.party !== undefined && input.party !== null && input.party !== '') {
    const party = Number(input.party);
    if (!Number.isInteger(party) || party <= 0) errors.push({ field: 'party', message: 'party must be a PS-11 party id' });
    else context.party = party;
    const name = input.party_name;
    if (typeof name === 'string' && name.trim() !== '') context.party_name = name.trim().slice(0, 160);
  }
  for (const field of ['from', 'to'] as const) {
    const value = input[field];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !ISO_DATE.test(value)) errors.push({ field, message: `${field} must be YYYY-MM-DD` });
    else context[field] = value;
  }
  if (context.from !== undefined && context.to !== undefined && context.from > context.to) {
    errors.push({ field: 'to', message: 'the end of the range must not precede its start' });
  }
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);

  db.prepare(
    `INSERT INTO preferences (owner, active_board, context) VALUES (?, NULL, ?)
     ON CONFLICT(owner) DO UPDATE SET context = excluded.context`,
  ).run(owner, JSON.stringify(context));
  return context;
}

export function writeActiveBoard(db: Database.Database, owner: string, boardId: number): void {
  getBoard(db, owner, boardId);
  db.prepare(
    `INSERT INTO preferences (owner, active_board, context) VALUES (?, ?, '{}')
     ON CONFLICT(owner) DO UPDATE SET active_board = excluded.active_board`,
  ).run(owner, boardId);
}
