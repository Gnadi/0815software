import type Database from 'better-sqlite3';
import type { DeliveryNote } from '../shared/types.js';
import { getDeliveryNote, getOrderStored, orderDetail, recordReservation, recordStock } from './orders.js';
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
    await platform.issueGoods({ orderReference: note.order_number, reference: note.number, warehouseCode: settings.stock_warehouse, actor, lines });
    return recordStock(db, noteId, { status: 'booked', warehouse: settings.stock_warehouse }, actor);
  } catch (err) {
    const error = err instanceof PeerError || err instanceof Error ? err.message : String(err);
    return recordStock(db, noteId, { status: 'failed', warehouse: settings.stock_warehouse, error }, actor);
  }
}

/**
 * Reserve an order's article lines in MOD-03 — when it is confirmed, and
 * again whenever its article numbers change. MOD-03 holds the total each
 * product needs for the order and derives what is still reserved from the
 * deliveries, so this sends the ordered quantities, never a remainder.
 *
 * Like booking, it never refuses the order: a shortage is recorded as
 * `short` with what is missing, a failure as `failed`, and either can be
 * retried. Nothing is asked (or recorded) with reserving switched off,
 * MOD-03 not wired, or no article lines and no earlier reservation.
 */
export async function reserveForOrder(
  db: Database.Database,
  platform: PlatformHooks,
  orderId: number,
  actor: string,
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  const settings = readSettings(db);
  if ((!settings.stock_reservation && !force) || !platform.inventoryConfigured) return;
  const order = orderDetail(db, orderId);
  if (order.status === 'cancelled') return;
  const bySku = new Map<string, number>();
  for (const line of order.lines) if (line.sku) bySku.set(line.sku, (bySku.get(line.sku) ?? 0) + line.quantity);
  // Nothing to reserve and nothing reserved before: nothing to say.
  if (bySku.size === 0 && order.reservation === null) return;
  if (!settings.stock_warehouse) {
    recordReservation(db, orderId, 'failed', 'No warehouse is set in Settings', actor);
    return;
  }
  try {
    const { short } = await platform.reserveStock({
      reference: order.number,
      warehouseCode: settings.stock_warehouse,
      actor,
      lines: [...bySku].map(([sku, quantity]) => ({ sku, quantity })),
    });
    if (short.length > 0) {
      recordReservation(db, orderId, 'short', `missing ${short.map((s) => `${s.missing} × ${s.sku}`).join(', ')} in ${settings.stock_warehouse}`, actor);
    } else {
      recordReservation(db, orderId, 'reserved', `in ${settings.stock_warehouse}`, actor);
    }
  } catch (err) {
    recordReservation(db, orderId, 'failed', err instanceof PeerError || err instanceof Error ? err.message : String(err), actor);
  }
}

/** Give a cancelled order's reservation back. Best-effort, recorded either way. */
export async function releaseForOrder(db: Database.Database, platform: PlatformHooks, orderId: number, actor: string): Promise<void> {
  const order = getOrderStored(db, orderId);
  if (order.reservation_status !== 'reserved' && order.reservation_status !== 'short' && order.reservation_status !== 'failed') return;
  if (!platform.inventoryConfigured) return;
  try {
    await platform.releaseStock({ reference: order.number, actor });
    recordReservation(db, orderId, 'released', null, actor);
  } catch (err) {
    recordReservation(db, orderId, 'failed', `release: ${err instanceof Error ? err.message : String(err)}`, actor);
  }
}
