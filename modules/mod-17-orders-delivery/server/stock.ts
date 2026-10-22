import type Database from 'better-sqlite3';
import type { DeliveryNote } from '../shared/types.js';
import { getDeliveryNote, recordStock } from './orders.js';
import { PeerError, type PlatformHooks } from './platform.js';
import { readSettings } from './settings.js';

/**
 * The stock side of a delivery note: a goods issue in MOD-03 for every line
 * that carries an article number.
 *
 * A delivery note records goods that already left — so a booking that fails
 * (stock short in MOD-03, MOD-03 down) never undoes or refuses it. The
 * failure is recorded on the note with MOD-03's own reason and can be
 * retried; MOD-03 books each delivery note once (idempotent on its number),
 * so a retry after a lost answer issues nothing twice.
 *
 * Nothing happens — and nothing is recorded — when booking is switched off,
 * MOD-03 is not wired, or no delivered line has an article number (services).
 */
export async function bookStock(
  db: Database.Database,
  platform: PlatformHooks,
  noteId: number,
  actor: string,
  { force = false }: { force?: boolean } = {},
): Promise<DeliveryNote> {
  const note = getDeliveryNote(db, noteId);
  const settings = readSettings(db);
  if (note.stock_status === 'booked') return note;
  // A retry asked for by a person runs even with automatic booking off.
  if ((!settings.stock_booking && !force) || !platform.inventoryConfigured) return note;
  const lines = note.lines.filter((l) => l.sku !== null).map((l) => ({ sku: l.sku!, quantity: l.quantity }));
  if (lines.length === 0) return note;
  if (!settings.stock_warehouse) {
    return recordStock(db, noteId, { status: 'failed', warehouse: null, error: 'No warehouse is set in Settings' }, actor);
  }
  try {
    await platform.issueGoods({ reference: note.number, warehouseCode: settings.stock_warehouse, actor, lines });
    return recordStock(db, noteId, { status: 'booked', warehouse: settings.stock_warehouse }, actor);
  } catch (err) {
    const error = err instanceof PeerError || err instanceof Error ? err.message : String(err);
    return recordStock(db, noteId, { status: 'failed', warehouse: settings.stock_warehouse, error }, actor);
  }
}
