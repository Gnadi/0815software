import type Database from 'better-sqlite3';
import type { FieldError, Item, ItemEvent, ItemStatus } from '../shared/types.js';

/** A refusal the API maps to a status code and `{ error, details }`. */
export class DomainError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: FieldError[],
  ) {
    super(message);
  }
}

/** Which status changes are allowed. One table, so the lifecycle is readable. */
const TRANSITIONS: Record<ItemStatus, readonly ItemStatus[]> = {
  open: ['done', 'archived'],
  done: ['open', 'archived'],
  archived: [],
};

export interface ItemInput {
  title: string;
  notes: string | null;
}

export function listItems(db: Database.Database, includeArchived = false): Item[] {
  return db
    .prepare(`SELECT * FROM items ${includeArchived ? '' : "WHERE status != 'archived'"} ORDER BY id DESC`)
    .all() as Item[];
}

export function getItem(db: Database.Database, id: number): Item {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Item | undefined;
  if (!item) throw new DomainError(404, 'Item not found');
  return item;
}

export function itemHistory(db: Database.Database, id: number): ItemEvent[] {
  getItem(db, id);
  return db.prepare('SELECT * FROM item_events WHERE item_id = ? ORDER BY id').all(id) as ItemEvent[];
}

function record(db: Database.Database, itemId: number, type: string, actor: string, at: string): void {
  db.prepare('INSERT INTO item_events (item_id, type, actor, at) VALUES (?, ?, ?, ?)').run(itemId, type, actor, at);
}

export function createItem(db: Database.Database, input: ItemInput, actor: string, now = new Date()): Item {
  const at = now.toISOString();
  return db.transaction((): Item => {
    const info = db
      .prepare('INSERT INTO items (title, notes, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.title, input.notes, 'open', at, at);
    const id = Number(info.lastInsertRowid);
    record(db, id, 'created', actor, at);
    return getItem(db, id);
  })();
}

export function updateItem(db: Database.Database, id: number, input: ItemInput, actor: string, now = new Date()): Item {
  const item = getItem(db, id);
  if (item.status === 'archived') throw new DomainError(409, 'An archived item cannot be changed');
  const at = now.toISOString();
  return db.transaction((): Item => {
    db.prepare('UPDATE items SET title = ?, notes = ?, updated_at = ? WHERE id = ?').run(input.title, input.notes, at, id);
    record(db, id, 'updated', actor, at);
    return getItem(db, id);
  })();
}

export function transitionItem(db: Database.Database, id: number, to: ItemStatus, actor: string, now = new Date()): Item {
  const item = getItem(db, id);
  if (!TRANSITIONS[item.status].includes(to)) {
    throw new DomainError(409, `Cannot move an item from ${item.status} to ${to}`);
  }
  const at = now.toISOString();
  return db.transaction((): Item => {
    db.prepare('UPDATE items SET status = ?, updated_at = ? WHERE id = ?').run(to, at, id);
    record(db, id, `status:${to}`, actor, at);
    return getItem(db, id);
  })();
}

export function deleteItem(db: Database.Database, id: number): void {
  getItem(db, id);
  db.prepare('DELETE FROM items WHERE id = ?').run(id);
}
