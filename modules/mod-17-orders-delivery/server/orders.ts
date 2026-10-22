import type Database from 'better-sqlite3';
import { lineNetCents, milli, QTY_SCALE, totalsOf } from '../shared/money.js';
import type {
  DeliveryNote,
  DeliveryNoteLine,
  FieldError,
  OrderDetail,
  OrderEvent,
  OrderLine,
  OrderRow,
  OrderStatus,
  StoredOrderStatus,
} from '../shared/types.js';

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

export const todayIso = (): string => new Date().toISOString().slice(0, 10);
const nowIso = (): string => new Date().toISOString();

// ── Numbering ──────────────────────────────────────────────────────────

const PREFIX = { order: 'AB', delivery_note: 'LS' } as const;

/**
 * The next number of a kind, gapless per year. Called inside the
 * transaction that writes the document, so a refused document consumes no
 * number and two concurrent ones cannot get the same.
 */
function nextNumber(db: Database.Database, kind: keyof typeof PREFIX, date: string): string {
  const year = Number(date.slice(0, 4));
  db.prepare(
    `INSERT INTO counters (kind, year, last_seq) VALUES (?, ?, 1)
     ON CONFLICT (kind, year) DO UPDATE SET last_seq = last_seq + 1`,
  ).run(kind, year);
  const { last_seq } = db.prepare('SELECT last_seq FROM counters WHERE kind = ? AND year = ?').get(kind, year) as { last_seq: number };
  return `${PREFIX[kind]}-${year}-${String(last_seq).padStart(4, '0')}`;
}

// ── Reading — everything about delivery is derived here ────────────────

interface OrderStored {
  id: number;
  number: string;
  status: StoredOrderStatus;
  order_date: string;
  customer_name: string;
  customer_contact: string | null;
  customer_email: string | null;
  customer_vat_id: string | null;
  customer_address: string | null;
  customer_party_id: number | null;
  customer_source: string | null;
  customer_external_id: string | null;
  customer_reference: string | null;
  source_reference: string | null;
  source_accepted_at: string | null;
  note: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  created_by: string;
  reservation_status: 'reserved' | 'short' | 'failed' | 'released' | null;
  reservation_note: string | null;
  reservation_at: string | null;
}

interface LineStored {
  id: number;
  order_id: number;
  position: number;
  description: string;
  quantity: number;
  unit_price_cents: number;
  discount_percent: number;
  vat_rate: number;
  sku: string | null;
}

interface NoteStored {
  id: number;
  number: string;
  order_id: number;
  delivered_on: string;
  note: string | null;
  created_at: string;
  created_by: string;
  invoiced_at: string | null;
  invoice_reference: string | null;
  stock_status: 'booked' | 'failed' | null;
  stock_warehouse: string | null;
  stock_at: string | null;
  stock_error: string | null;
}

export function getOrderStored(db: Database.Database, id: number): OrderStored {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderStored | undefined;
  if (!row) throw new DomainError(404, 'Order not found');
  return row;
}

function deliveredByLine(db: Database.Database, orderId: number): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT dl.order_line_id, SUM(dl.quantity) AS delivered
         FROM delivery_note_lines dl JOIN delivery_notes dn ON dn.id = dl.delivery_note_id
        WHERE dn.order_id = ? GROUP BY dl.order_line_id`,
    )
    .all(orderId) as { order_line_id: number; delivered: number }[];
  return new Map(rows.map((r) => [r.order_line_id, r.delivered]));
}

function linesOf(db: Database.Database, order: OrderStored): OrderLine[] {
  const delivered = deliveredByLine(db, order.id);
  const rows = db.prepare('SELECT * FROM order_lines WHERE order_id = ? ORDER BY position').all(order.id) as LineStored[];
  return rows.map((row) => {
    const done = delivered.get(row.id) ?? 0;
    const left = Math.max(0, milli(row.quantity) - milli(done)) / QTY_SCALE;
    return {
      id: row.id,
      position: row.position,
      description: row.description,
      quantity: row.quantity,
      unit_price_cents: row.unit_price_cents,
      discount_percent: row.discount_percent,
      vat_rate: row.vat_rate,
      sku: row.sku,
      net_cents: lineNetCents(row),
      delivered_quantity: milli(done) / QTY_SCALE,
      remaining_quantity: order.status === 'cancelled' ? 0 : left,
    };
  });
}

function statusOf(stored: StoredOrderStatus, lines: OrderLine[]): OrderStatus {
  if (stored === 'cancelled') return 'cancelled';
  const anyDelivered = lines.some((l) => l.delivered_quantity > 0);
  if (lines.every((l) => milli(l.delivered_quantity) >= milli(l.quantity))) return 'delivered';
  return anyDelivered ? 'partially_delivered' : 'open';
}

function noteLines(db: Database.Database, noteId: number): DeliveryNoteLine[] {
  return db
    .prepare(
      `SELECT dl.order_line_id, ol.position, ol.description, ol.sku, dl.quantity
         FROM delivery_note_lines dl JOIN order_lines ol ON ol.id = dl.order_line_id
        WHERE dl.delivery_note_id = ? ORDER BY ol.position`,
    )
    .all(noteId) as DeliveryNoteLine[];
}

function toNote(db: Database.Database, row: NoteStored, orderNumber: string): DeliveryNote {
  return { ...row, order_number: orderNumber, lines: noteLines(db, row.id) };
}

function toRow(db: Database.Database, order: OrderStored, lines: OrderLine[]): OrderRow {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM delivery_notes WHERE order_id = ?').get(order.id) as { n: number };
  return {
    id: order.id,
    number: order.number,
    status: statusOf(order.status, lines),
    order_date: order.order_date,
    customer_name: order.customer_name,
    customer_reference: order.customer_reference,
    source_reference: order.source_reference,
    totals: totalsOf(lines),
    delivery_note_count: n,
    created_at: order.created_at,
  };
}

export function listOrders(db: Database.Database, filter: { status?: OrderStatus; search?: string } = {}): OrderRow[] {
  const orders = db.prepare('SELECT * FROM orders ORDER BY number DESC').all() as OrderStored[];
  const term = filter.search?.trim().toLowerCase();
  return orders
    .filter((o) => !term || o.number.toLowerCase().includes(term) || o.customer_name.toLowerCase().includes(term))
    .map((o) => toRow(db, o, linesOf(db, o)))
    .filter((r) => !filter.status || r.status === filter.status);
}

export function orderDetail(db: Database.Database, id: number): OrderDetail {
  const order = getOrderStored(db, id);
  const lines = linesOf(db, order);
  const notes = db.prepare('SELECT * FROM delivery_notes WHERE order_id = ? ORDER BY id').all(id) as NoteStored[];
  const events = db
    .prepare('SELECT id, type, detail, actor, at FROM order_events WHERE order_id = ? ORDER BY id')
    .all(id) as OrderEvent[];
  return {
    ...toRow(db, order, lines),
    customer: {
      name: order.customer_name,
      contact_person: order.customer_contact,
      email: order.customer_email,
      vat_id: order.customer_vat_id,
      address_lines: order.customer_address ? order.customer_address.split('\n') : [],
    },
    note: order.note,
    lines,
    delivery_notes: notes.map((n) => toNote(db, n, order.number)),
    cancelled_at: order.cancelled_at,
    cancel_reason: order.cancel_reason,
    created_by: order.created_by,
    events,
    reservation:
      order.reservation_status === null
        ? null
        : { status: order.reservation_status, note: order.reservation_note, at: order.reservation_at! },
  };
}

export function getDeliveryNote(db: Database.Database, id: number): DeliveryNote {
  const row = db.prepare('SELECT * FROM delivery_notes WHERE id = ?').get(id) as NoteStored | undefined;
  if (!row) throw new DomainError(404, 'Delivery note not found');
  return toNote(db, row, getOrderStored(db, row.order_id).number);
}

export function deliveryNoteByNumber(db: Database.Database, number: string): DeliveryNote {
  const row = db.prepare('SELECT id FROM delivery_notes WHERE number = ?').get(number) as { id: number } | undefined;
  if (!row) throw new DomainError(404, 'Delivery note not found');
  return getDeliveryNote(db, row.id);
}

/** The customer identity an order came with — passed on to billing unchanged. */
export function customerIdentity(db: Database.Database, orderId: number): { party_id: number | null; source: string | null; external_id: string | null; accepted_at: string | null } {
  const o = getOrderStored(db, orderId);
  return { party_id: o.customer_party_id, source: o.customer_source, external_id: o.customer_external_id, accepted_at: o.source_accepted_at };
}

// ── Writing ────────────────────────────────────────────────────────────

function record(db: Database.Database, orderId: number, type: string, detail: string | null, actor: string): void {
  db.prepare('INSERT INTO order_events (order_id, type, detail, actor, at) VALUES (?, ?, ?, ?, ?)').run(orderId, type, detail, actor, nowIso());
}

export interface OrderLineInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountPercent: number;
  vatRate: number;
  sku?: string | null;
}

export interface OrderInput {
  orderDate: string;
  customer: {
    name: string;
    contactPerson: string | null;
    email: string | null;
    vatId: string | null;
    addressLines: string[];
    partyId?: number | null;
    source?: string | null;
    externalId?: string | null;
  };
  customerReference: string | null;
  note: string | null;
  lines: OrderLineInput[];
  /** "<module>:<reference>" when the order came from another module. */
  sourceReference?: string | null;
  sourceAcceptedAt?: string | null;
}

/**
 * Write an order. It is confirmed as it is written — numbered, and its lines
 * fixed: what the customer ordered does not change afterwards. A different
 * order is a cancellation and a new one.
 */
export function createOrder(db: Database.Database, input: OrderInput, actor: string): number {
  return db.transaction((): number => {
    const number = nextNumber(db, 'order', input.orderDate);
    const c = input.customer;
    const info = db
      .prepare(
        `INSERT INTO orders (number, order_date, customer_name, customer_contact, customer_email, customer_vat_id,
                             customer_address, customer_party_id, customer_source, customer_external_id,
                             customer_reference, source_reference, source_accepted_at, note, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        number,
        input.orderDate,
        c.name,
        c.contactPerson,
        c.email,
        c.vatId,
        c.addressLines.length > 0 ? c.addressLines.join('\n') : null,
        c.partyId ?? null,
        c.source ?? null,
        c.externalId ?? null,
        input.customerReference,
        input.sourceReference ?? null,
        input.sourceAcceptedAt ?? null,
        input.note,
        nowIso(),
        actor,
      );
    const id = Number(info.lastInsertRowid);
    const insert = db.prepare(
      `INSERT INTO order_lines (order_id, position, description, quantity, unit_price_cents, discount_percent, vat_rate, sku)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    input.lines.forEach((l, i) => insert.run(id, i + 1, l.description, l.quantity, l.unitPriceCents, l.discountPercent, l.vatRate, l.sku ?? null));
    record(db, id, 'confirmed', input.sourceReference ? `from ${input.sourceReference}` : null, actor);
    return id;
  })();
}

/**
 * Cancel what is still to be delivered. Delivery notes already written stay
 * — they happened, and may be billed — but no further one can be.
 */
export function cancelOrder(db: Database.Database, id: number, reason: string, actor: string): void {
  db.transaction(() => {
    const order = getOrderStored(db, id);
    if (order.status === 'cancelled') throw new DomainError(409, `${order.number} is already cancelled`);
    if (statusOf(order.status, linesOf(db, order)) === 'delivered') {
      throw new DomainError(409, `${order.number} is fully delivered — there is nothing left to cancel`);
    }
    db.prepare("UPDATE orders SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ?").run(nowIso(), reason, id);
    record(db, id, 'cancelled', reason, actor);
  })();
}

export interface DeliveryInput {
  deliveredOn: string | null;
  note: string | null;
  lines: { orderLineId: number; quantity: number }[];
}

/**
 * Write a delivery note: what left on which day. Never more of a line than is
 * still open on the order — partial deliveries add up to the order, not past
 * it — and never on a cancelled order. Numbered and fixed as it is written.
 */
export function createDeliveryNote(db: Database.Database, orderId: number, input: DeliveryInput, actor: string, today = todayIso()): DeliveryNote {
  return db.transaction((): DeliveryNote => {
    const order = getOrderStored(db, orderId);
    if (order.status === 'cancelled') throw new DomainError(409, `${order.number} is cancelled — nothing more is delivered on it`);
    const lines = linesOf(db, order);
    const errors: FieldError[] = [];
    const deliveredOn = input.deliveredOn ?? today;
    if (deliveredOn < order.order_date) {
      errors.push({ field: 'delivered_on', message: `A delivery cannot predate its order (${order.order_date})` });
    }
    if (deliveredOn > today) errors.push({ field: 'delivered_on', message: 'A delivery note records a delivery that happened — not one in the future' });
    if (input.lines.length === 0) errors.push({ field: 'lines', message: 'A delivery note delivers at least one line' });
    const seen = new Set<number>();
    input.lines.forEach((l, i) => {
      const line = lines.find((x) => x.id === l.orderLineId);
      if (!line) {
        errors.push({ field: `lines[${i}].order_line_id`, message: `${order.number} has no such line` });
        return;
      }
      if (seen.has(l.orderLineId)) errors.push({ field: `lines[${i}].order_line_id`, message: `Line ${line.position} appears twice` });
      seen.add(l.orderLineId);
      if (milli(l.quantity) > milli(line.remaining_quantity)) {
        errors.push({
          field: `lines[${i}].quantity`,
          message: `Line ${line.position} has ${line.remaining_quantity} left to deliver, not ${l.quantity}`,
        });
      }
    });
    if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);

    const number = nextNumber(db, 'delivery_note', deliveredOn);
    const info = db
      .prepare('INSERT INTO delivery_notes (number, order_id, delivered_on, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(number, orderId, deliveredOn, input.note, nowIso(), actor);
    const noteId = Number(info.lastInsertRowid);
    const insert = db.prepare('INSERT INTO delivery_note_lines (delivery_note_id, order_line_id, quantity) VALUES (?, ?, ?)');
    for (const l of input.lines) insert.run(noteId, l.orderLineId, l.quantity);
    record(db, orderId, 'delivered', number, actor);
    return getDeliveryNote(db, noteId);
  })();
}

/**
 * A billing module took a delivery over. Recorded once: a second call (a
 * retry, a replayed import) changes nothing and is not an error, because the
 * billing side is itself idempotent on the delivery note number.
 */
export function markInvoiced(db: Database.Database, number: string, reference: string, actor: string): DeliveryNote {
  return db.transaction((): DeliveryNote => {
    const note = deliveryNoteByNumber(db, number);
    if (note.invoiced_at === null) {
      db.prepare('UPDATE delivery_notes SET invoiced_at = ?, invoice_reference = ? WHERE id = ?').run(nowIso(), reference, note.id);
      record(db, note.order_id, 'invoiced', `${number} → ${reference}`, actor);
    }
    return getDeliveryNote(db, note.id);
  })();
}

/**
 * Map an order line to a MOD-03 article — or unmap it (null). Not a change
 * to what was ordered: the article number only decides which stock a
 * delivery issues, so it may be set after confirmation (an offer carries
 * none) and affects the delivery notes written from then on.
 */
export function setLineSku(db: Database.Database, orderId: number, lineId: number, sku: string | null, actor: string): void {
  db.transaction(() => {
    const order = getOrderStored(db, orderId);
    const line = db.prepare('SELECT * FROM order_lines WHERE id = ? AND order_id = ?').get(lineId, orderId) as LineStored | undefined;
    if (!line) throw new DomainError(404, 'Order line not found');
    if (order.status === 'cancelled') throw new DomainError(409, `${order.number} is cancelled — nothing more is delivered on it`);
    if (line.sku === sku) return;
    db.prepare('UPDATE order_lines SET sku = ? WHERE id = ?').run(sku, lineId);
    record(db, orderId, 'sku', `line ${line.position}: ${line.sku ?? '—'} → ${sku ?? '—'}`, actor);
  })();
}

/** What MOD-03 answered for a delivery note's goods issue. */
export function recordStock(
  db: Database.Database,
  noteId: number,
  outcome: { status: 'booked'; warehouse: string } | { status: 'failed'; warehouse: string | null; error: string },
  actor: string,
): DeliveryNote {
  const note = getDeliveryNote(db, noteId);
  db.transaction(() => {
    db.prepare('UPDATE delivery_notes SET stock_status = ?, stock_warehouse = ?, stock_at = ?, stock_error = ? WHERE id = ?').run(
      outcome.status,
      outcome.warehouse,
      nowIso(),
      outcome.status === 'failed' ? outcome.error : null,
      noteId,
    );
    record(
      db,
      note.order_id,
      outcome.status === 'booked' ? 'stock_booked' : 'stock_failed',
      outcome.status === 'booked' ? `${note.number} from ${outcome.warehouse}` : `${note.number}: ${outcome.error}`,
      actor,
    );
  })();
  return getDeliveryNote(db, noteId);
}

/** What MOD-03 answered about an order's reservation — with the person, on the history. */
export function recordReservation(
  db: Database.Database,
  orderId: number,
  status: 'reserved' | 'short' | 'failed' | 'released',
  note: string | null,
  actor: string,
): void {
  db.transaction(() => {
    db.prepare('UPDATE orders SET reservation_status = ?, reservation_note = ?, reservation_at = ? WHERE id = ?').run(status, note, nowIso(), orderId);
    record(db, orderId, `stock_${status}`, note, actor);
  })();
}
