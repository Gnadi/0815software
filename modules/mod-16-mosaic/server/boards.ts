import type Database from 'better-sqlite3';
import {
  GRID_COLUMNS,
  MAX_PANE_H,
  MAX_PANE_W,
  MIN_PANE_H,
  MIN_PANE_W,
  type Board,
  type Pane,
  type PanePlacement,
} from '../shared/types.js';
import { catalogueEntry } from '../shared/catalogue.js';

/**
 * Boards and panes — the only thing this module owns.
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
  return rows.map((row) => ({ ...row, panes: panesOf(db, row.id) }));
}

function panesOf(db: Database.Database, boardId: number): Pane[] {
  return db
    .prepare('SELECT id, board_id, module_id, x, y, w, h FROM panes WHERE board_id = ? ORDER BY y, x, id')
    .all(boardId) as Pane[];
}

/** A board this owner owns, or 404. Never another owner's, ever. */
export function getBoard(db: Database.Database, owner: string, id: number): Board {
  const row = db.prepare('SELECT id, owner, name, position FROM boards WHERE id = ? AND owner = ?').get(id, owner) as
    | BoardRow
    | undefined;
  if (!row) throw new DomainError(404, 'Board not found');
  return { ...row, panes: panesOf(db, row.id) };
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
  createBoard(db, owner, STARTER_BOARD);
  // Deliberately empty. There is no honest starter pane: which modules a
  // customer licensed is not knowable from here, and a pane naming a module
  // that is not in the stack would greet everyone with a broken frame. The
  // empty board says so and points at ADD PANE.
  return listBoards(db, owner);
}

export interface PaneInput {
  module_id?: unknown;
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
 * Validate a pane.
 *
 * The module must be one this shell knows AND one that declares itself
 * framable. The second check is the load-bearing one: MOD-01, MOD-07 and
 * MOD-09 authenticate their own end users, so a staff shell has no identity to
 * assert in them and the frame would show a login form nobody here can fill.
 * Refusing at the API rather than only hiding it in the picker means a stale
 * client, or someone with curl, gets the same answer.
 */
function validPane(input: PaneInput): Omit<Pane, 'id' | 'board_id'> {
  const moduleId = typeof input.module_id === 'string' ? input.module_id.trim() : '';
  const entry = catalogueEntry(moduleId);
  if (!entry) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'module_id', message: 'module_id must name a module in the catalogue' },
    ]);
  }
  if (!entry.embeddable) {
    throw new DomainError(422, 'Validation failed', [
      {
        field: 'module_id',
        message: `${entry.label} authenticates its own end users, so it cannot be framed by a staff shell`,
      },
    ]);
  }

  const w = intIn(input.w, 'w', MIN_PANE_W, MAX_PANE_W, 6);
  const x = intIn(input.x, 'x', 0, GRID_COLUMNS - MIN_PANE_W, 0);
  if (x + w > GRID_COLUMNS) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'w', message: `a pane at column ${x} can be at most ${GRID_COLUMNS - x} wide` },
    ]);
  }

  return {
    module_id: entry.id,
    x,
    y: intIn(input.y, 'y', 0, 500, 0),
    w,
    h: intIn(input.h, 'h', MIN_PANE_H, MAX_PANE_H, 6),
  };
}

/**
 * Where a new pane goes when the caller did not say.
 *
 * Beside the others, not on top of them. Every pane defaults to (0, 0), so
 * without this the second one lands exactly under the first and the third under
 * that — three applications stacked in one rectangle, each needing to be
 * dragged out by hand before the board is usable at all. "Side by side" is the
 * entire premise of this module; it should not be a chore.
 *
 * The rule is the one a person would use: continue the current row while the
 * pane fits, otherwise start a new one below everything placed so far. It does
 * not hunt for gaps — a board where somebody has already arranged things is
 * theirs, and dropping a pane into a hole they left open would be a surprise.
 */
function nextFreeSpot(existing: Pane[], w: number): { x: number; y: number } {
  if (existing.length === 0) return { x: 0, y: 0 };

  // The row the most recent pane sits on, and how far right it reaches.
  const lastY = Math.max(...existing.map((p) => p.y));
  const onLastRow = existing.filter((p) => p.y === lastY);
  const rightEdge = Math.max(...onLastRow.map((p) => p.x + p.w));

  if (rightEdge + w <= GRID_COLUMNS) return { x: rightEdge, y: lastY };
  return { x: 0, y: lastY + Math.max(...onLastRow.map((p) => p.h)) };
}

export function addPane(db: Database.Database, owner: string, boardId: number, input: PaneInput): Pane {
  const board = getBoard(db, owner, boardId);
  const pane = validPane(input);
  // An explicit placement wins; an absent one is laid out beside what is there.
  const placed =
    input.x === undefined && input.y === undefined
      ? { ...pane, ...nextFreeSpot(board.panes, pane.w) }
      : pane;
  const info = db
    .prepare('INSERT INTO panes (board_id, module_id, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?)')
    .run(boardId, placed.module_id, placed.x, placed.y, placed.w, placed.h);
  return db
    .prepare('SELECT id, board_id, module_id, x, y, w, h FROM panes WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as Pane;
}

export function deletePane(db: Database.Database, owner: string, boardId: number, paneId: number): void {
  getBoard(db, owner, boardId);
  const info = db.prepare('DELETE FROM panes WHERE id = ? AND board_id = ?').run(paneId, boardId);
  if (info.changes === 0) throw new DomainError(404, 'Pane not found');
}

/**
 * Apply a whole board's layout in one transaction.
 *
 * The client sends the resulting arrangement rather than a sequence of moves.
 * One transaction means a board is never half-rearranged — applying these one
 * at a time can leave a layout that is neither the old one nor the new one,
 * which nobody can undo.
 */
export function placePanes(
  db: Database.Database,
  owner: string,
  boardId: number,
  placements: PanePlacement[],
): Board {
  const board = getBoard(db, owner, boardId);
  const known = new Set(board.panes.map((p) => p.id));

  for (const placement of placements) {
    if (!known.has(placement.id)) throw new DomainError(404, `Pane ${placement.id} is not on this board`);
    const w = intIn(placement.w, 'w', MIN_PANE_W, MAX_PANE_W, MIN_PANE_W);
    const x = intIn(placement.x, 'x', 0, GRID_COLUMNS - MIN_PANE_W, 0);
    if (x + w > GRID_COLUMNS) {
      throw new DomainError(422, 'Validation failed', [
        { field: 'w', message: `a pane at column ${x} can be at most ${GRID_COLUMNS - x} wide` },
      ]);
    }
  }

  const update = db.prepare('UPDATE panes SET x = ?, y = ?, w = ?, h = ? WHERE id = ? AND board_id = ?');
  db.transaction((rows: PanePlacement[]) => {
    for (const p of rows) {
      update.run(
        intIn(p.x, 'x', 0, GRID_COLUMNS - MIN_PANE_W, 0),
        intIn(p.y, 'y', 0, 500, 0),
        intIn(p.w, 'w', MIN_PANE_W, MAX_PANE_W, MIN_PANE_W),
        intIn(p.h, 'h', MIN_PANE_H, MAX_PANE_H, MIN_PANE_H),
        p.id,
        boardId,
      );
    }
  })(placements);

  return getBoard(db, owner, boardId);
}

// ── Preferences: which board this person was last on ───────────────────

export function readPreferences(db: Database.Database, owner: string): { active_board: number | null } {
  const row = db.prepare('SELECT active_board FROM preferences WHERE owner = ?').get(owner) as
    | { active_board: number | null }
    | undefined;
  return { active_board: row?.active_board ?? null };
}

export function writeActiveBoard(db: Database.Database, owner: string, boardId: number): void {
  getBoard(db, owner, boardId);
  db.prepare(
    `INSERT INTO preferences (owner, active_board) VALUES (?, ?)
     ON CONFLICT(owner) DO UPDATE SET active_board = excluded.active_board`,
  ).run(owner, boardId);
}
