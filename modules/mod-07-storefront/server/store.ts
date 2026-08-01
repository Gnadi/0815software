import type Database from 'better-sqlite3';
import { computeTotals, lineGrossCents } from '../shared/money.js';
import {
  NEXT_STATUS,
  type Cart,
  type CartLine,
  type Category,
  type FieldError,
  type GuestOrder,
  type OrderDetail,
  type OrderEvent,
  type OrderLine,
  type OrderRow,
  type OrderStatus,
  type PaymentStatus,
  type Product,
  type ShopProduct,
  type ShortageItem,
} from '../shared/types.js';

/** A LIKE pattern that matches the term literally — see the ESCAPE clauses below. */
export function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** Error with an HTTP status, optional per-field details, and optional shortage items. */
export class DomainError extends Error {
  status: number;
  details: FieldError[];
  items?: ShortageItem[];

  constructor(status: number, message: string, details: FieldError[] = [], items?: ShortageItem[]) {
    super(message);
    this.status = status;
    this.details = details;
    this.items = items;
  }
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function requireRow<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new DomainError(404, `${what} not found`);
  return row;
}

// ── Catalogue ──────────────────────────────────────────────────────────

export function getCategory(db: Database.Database, id: number): Category {
  return requireRow(
    db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as Category | undefined,
    'Category',
  );
}

export function getProduct(db: Database.Database, id: number): Product {
  return requireRow(
    db.prepare('SELECT * FROM products WHERE id = ?').get(id) as Product | undefined,
    'Product',
  );
}

export interface ShopListOptions {
  categoryId?: number;
  search?: string;
}

/** Products as the public shop sees them: never archived, joined category. */
export function shopProducts(db: Database.Database, opts: ShopListOptions = {}): ShopProduct[] {
  const clauses = ['p.archived = 0'];
  const params: (string | number)[] = [];
  if (opts.categoryId !== undefined) {
    clauses.push('p.category_id = ?');
    params.push(opts.categoryId);
  }
  const search = opts.search?.trim();
  if (search) {
    clauses.push('(p.name LIKE ? ESCAPE \'\\\' OR p.description LIKE ? ESCAPE \'\\\' OR p.sku LIKE ? ESCAPE \'\\\')');
    const like = likeTerm(search);
    params.push(like, like, like);
  }
  return db
    .prepare(
      `SELECT p.id, p.sku, p.name, p.description, p.unit_price_cents, p.vat_rate,
              p.stock, p.category_id, p.accent, p.created_at, c.name AS category_name
       FROM products p JOIN categories c ON c.id = p.category_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY c.position, c.name, p.name`,
    )
    .all(...params) as ShopProduct[];
}

export function shopProduct(db: Database.Database, id: number): ShopProduct {
  return requireRow(
    db
      .prepare(
        `SELECT p.id, p.sku, p.name, p.description, p.unit_price_cents, p.vat_rate,
                p.stock, p.category_id, p.accent, p.created_at, c.name AS category_name
         FROM products p JOIN categories c ON c.id = p.category_id
         WHERE p.id = ? AND p.archived = 0`,
      )
      .get(id) as ShopProduct | undefined,
    'Product',
  );
}

// ── Cart ───────────────────────────────────────────────────────────────

export function createCart(db: Database.Database): number {
  const now = nowIso();
  const info = db.prepare('INSERT INTO carts (created_at, updated_at) VALUES (?, ?)').run(now, now);
  return Number(info.lastInsertRowid);
}

export function cartExists(db: Database.Database, cartId: number): boolean {
  return db.prepare('SELECT 1 FROM carts WHERE id = ?').get(cartId) !== undefined;
}

interface CartLineRow {
  product_id: number;
  quantity: number;
  sku: string;
  name: string;
  unit_price_cents: number;
  vat_rate: number;
  accent: string | null;
  stock: number;
  archived: 0 | 1;
}

function cartLineRows(db: Database.Database, cartId: number): CartLineRow[] {
  return db
    .prepare(
      `SELECT l.product_id, l.quantity, p.sku, p.name, p.unit_price_cents,
              p.vat_rate, p.accent, p.stock, p.archived
       FROM cart_lines l JOIN products p ON p.id = l.product_id
       WHERE l.cart_id = ? ORDER BY l.id`,
    )
    .all(cartId) as CartLineRow[];
}

/** The cart against the LIVE catalogue — prices and availability are current, never cached. */
export function cartDetail(db: Database.Database, cartId: number | null): Cart {
  const rows = cartId === null ? [] : cartLineRows(db, cartId);
  const lines: CartLine[] = rows.map((row) => ({
    product_id: row.product_id,
    sku: row.sku,
    name: row.name,
    quantity: row.quantity,
    unit_price_cents: row.unit_price_cents,
    vat_rate: row.vat_rate,
    accent: row.accent,
    available: row.archived ? 0 : row.stock,
    line_gross_cents: lineGrossCents(row),
  }));
  return {
    lines,
    totals: computeTotals(lines),
    item_count: lines.reduce((sum, l) => sum + l.quantity, 0),
  };
}

function assertAvailable(product: Product, requested: number): void {
  const available = product.archived ? 0 : product.stock;
  if (requested > available) {
    throw new DomainError(
      422,
      `Only ${available} × ${product.name} available`,
      [{ field: 'quantity', message: `Only ${available} available (requested ${requested})` }],
      [
        {
          product_id: product.id,
          sku: product.sku,
          name: product.name,
          requested,
          available,
        },
      ],
    );
  }
}

/** Add quantity to a cart line (creating it), validating against live stock. */
export function addCartItem(
  db: Database.Database,
  cartId: number,
  productId: number,
  quantity: number,
): void {
  const product = getProduct(db, productId);
  if (product.archived) throw new DomainError(404, 'Product not found');
  db.transaction(() => {
    const existing = db
      .prepare('SELECT quantity FROM cart_lines WHERE cart_id = ? AND product_id = ?')
      .get(cartId, productId) as { quantity: number } | undefined;
    const total = (existing?.quantity ?? 0) + quantity;
    assertAvailable(product, total);
    db.prepare(
      `INSERT INTO cart_lines (cart_id, product_id, quantity) VALUES (?, ?, ?)
       ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = ?`,
    ).run(cartId, productId, total, total);
    db.prepare('UPDATE carts SET updated_at = ? WHERE id = ?').run(nowIso(), cartId);
  })();
}

/** Set a cart line's quantity exactly (0 removes it), validating against live stock. */
export function setCartItem(
  db: Database.Database,
  cartId: number,
  productId: number,
  quantity: number,
): void {
  if (quantity === 0) {
    removeCartItem(db, cartId, productId);
    return;
  }
  const product = getProduct(db, productId);
  if (product.archived) throw new DomainError(404, 'Product not found');
  assertAvailable(product, quantity);
  const info = db
    .prepare('UPDATE cart_lines SET quantity = ? WHERE cart_id = ? AND product_id = ?')
    .run(quantity, cartId, productId);
  if (info.changes === 0) throw new DomainError(404, 'Cart line not found');
  db.prepare('UPDATE carts SET updated_at = ? WHERE id = ?').run(nowIso(), cartId);
}

export function removeCartItem(db: Database.Database, cartId: number, productId: number): void {
  const info = db
    .prepare('DELETE FROM cart_lines WHERE cart_id = ? AND product_id = ?')
    .run(cartId, productId);
  if (info.changes === 0) throw new DomainError(404, 'Cart line not found');
  db.prepare('UPDATE carts SET updated_at = ? WHERE id = ?').run(nowIso(), cartId);
}

// ── Checkout ───────────────────────────────────────────────────────────

export interface CheckoutInput {
  customerName: string;
  email: string;
  address: string;
  placedAt?: string;
}

/**
 * Checkout — the transaction the whole module exists for. In ONE SQLite
 * transaction (better-sqlite3 serializes writes, so it is atomic and
 * isolated):
 *
 *   1. every cart line is re-validated against CURRENT stock — if ANY
 *      line cannot be fulfilled the whole transaction throws a 422
 *      listing every offending item, and no stock has been touched;
 *   2. stock is decremented per line;
 *   3. the order ref is drawn from the gapless per-year counter;
 *   4. sku, name, unit price and VAT rate are SNAPSHOTTED into
 *      order_lines — later catalogue edits never alter this order;
 *   5. the 'placed' event is appended and the cart is deleted.
 */
export function checkout(
  db: Database.Database,
  cartId: number,
  input: CheckoutInput,
): { orderId: number; ref: string } {
  return db.transaction(() => {
    const rows = cartLineRows(db, cartId);
    if (rows.length === 0) {
      throw new DomainError(422, 'Validation failed', [
        { field: 'cart', message: 'The cart is empty' },
      ]);
    }

    const shortages: ShortageItem[] = rows
      .filter((row) => row.quantity > (row.archived ? 0 : row.stock))
      .map((row) => ({
        product_id: row.product_id,
        sku: row.sku,
        name: row.name,
        requested: row.quantity,
        available: row.archived ? 0 : row.stock,
      }));
    if (shortages.length > 0) {
      throw new DomainError(
        422,
        'Insufficient stock',
        shortages.map((s) => ({
          field: s.sku,
          message: `Only ${s.available} × ${s.name} available (requested ${s.requested})`,
        })),
        shortages,
      );
    }

    const decrement = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
    for (const row of rows) decrement.run(row.quantity, row.product_id);

    const placedAt = input.placedAt ?? nowIso();
    const year = Number(placedAt.slice(0, 4));
    const counter = db
      .prepare(
        `INSERT INTO order_counters (year, last_seq) VALUES (?, 1)
         ON CONFLICT (year) DO UPDATE SET last_seq = last_seq + 1
         RETURNING last_seq`,
      )
      .get(year) as { last_seq: number };
    const ref = `ORD-${year}-${String(counter.last_seq).padStart(4, '0')}`;

    const info = db
      .prepare(
        `INSERT INTO orders (ref, status, customer_name, email, address, created_at)
         VALUES (?, 'placed', ?, ?, ?, ?)`,
      )
      .run(ref, input.customerName, input.email, input.address, placedAt);
    const orderId = Number(info.lastInsertRowid);

    const insertLine = db.prepare(
      `INSERT INTO order_lines (order_id, position, product_id, sku, name, quantity, unit_price_cents, vat_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    rows.forEach((row, i) => {
      insertLine.run(orderId, i + 1, row.product_id, row.sku, row.name, row.quantity, row.unit_price_cents, row.vat_rate);
    });

    appendEvent(db, orderId, 'placed', placedAt, null);
    db.prepare('DELETE FROM carts WHERE id = ?').run(cartId);
    return { orderId, ref };
  })();
}

// ── Orders ─────────────────────────────────────────────────────────────

interface OrderStoredRow {
  id: number;
  ref: string;
  status: OrderStatus;
  customer_name: string;
  email: string;
  address: string;
  paid_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

function getOrder(db: Database.Database, id: number): OrderStoredRow {
  return requireRow(
    db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderStoredRow | undefined,
    'Order',
  );
}

export function getOrderByRef(db: Database.Database, ref: string): OrderStoredRow | undefined {
  return db.prepare('SELECT * FROM orders WHERE ref = ?').get(ref) as OrderStoredRow | undefined;
}

function orderLines(db: Database.Database, orderId: number): OrderLine[] {
  const rows = db
    .prepare('SELECT * FROM order_lines WHERE order_id = ? ORDER BY position, id')
    .all(orderId) as Omit<OrderLine, 'line_gross_cents'>[];
  return rows.map((row) => ({ ...row, line_gross_cents: lineGrossCents(row) }));
}

function orderEvents(db: Database.Database, orderId: number): OrderEvent[] {
  return db
    .prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY at, id')
    .all(orderId) as OrderEvent[];
}

function appendEvent(
  db: Database.Database,
  orderId: number,
  status: OrderStatus,
  at: string,
  note: string | null,
): void {
  db.prepare('INSERT INTO order_events (order_id, status, at, note) VALUES (?, ?, ?, ?)').run(
    orderId,
    status,
    at,
    note,
  );
}

function paymentStatusOf(order: OrderStoredRow): PaymentStatus {
  return order.paid_at ? 'paid' : 'unpaid';
}

function toRow(db: Database.Database, order: OrderStoredRow): { row: OrderRow; lines: OrderLine[] } {
  const lines = orderLines(db, order.id);
  const totals = computeTotals(lines);
  return {
    lines,
    row: {
      id: order.id,
      ref: order.ref,
      status: order.status,
      payment_status: paymentStatusOf(order),
      customer_name: order.customer_name,
      email: order.email,
      item_count: lines.reduce((sum, l) => sum + l.quantity, 0),
      net_cents: totals.net_cents,
      vat_cents: totals.vat_cents,
      gross_cents: totals.gross_cents,
      created_at: order.created_at,
    },
  };
}

export interface OrderListOptions {
  status?: OrderStatus;
  payment?: PaymentStatus;
  search?: string;
}

export function listOrders(db: Database.Database, opts: OrderListOptions = {}): OrderRow[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status) {
    clauses.push('status = ?');
    params.push(opts.status);
  }
  if (opts.payment) {
    clauses.push(opts.payment === 'paid' ? 'paid_at IS NOT NULL' : 'paid_at IS NULL');
  }
  const search = opts.search?.trim();
  if (search) {
    clauses.push('(ref LIKE ? ESCAPE \'\\\' OR customer_name LIKE ? ESCAPE \'\\\' OR email LIKE ? ESCAPE \'\\\')');
    const like = likeTerm(search);
    params.push(like, like, like);
  }
  const orders = db
    .prepare(
      `SELECT * FROM orders ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY ref DESC`,
    )
    .all(...params) as OrderStoredRow[];
  return orders.map((order) => toRow(db, order).row);
}

export function orderDetail(db: Database.Database, id: number): OrderDetail {
  const order = getOrder(db, id);
  const { row, lines } = toRow(db, order);
  return {
    ...row,
    address: order.address,
    paid_at: order.paid_at,
    cancelled_at: order.cancelled_at,
    lines,
    vat_breakdown: computeTotals(lines).by_rate,
    events: orderEvents(db, order.id),
  };
}

/** The guest view behind the signed lookup link — no address, no admin ids. */
export function guestOrder(db: Database.Database, orderId: number): GuestOrder {
  const order = getOrder(db, orderId);
  const lines = orderLines(db, orderId);
  return {
    ref: order.ref,
    status: order.status,
    payment_status: paymentStatusOf(order),
    customer_name: order.customer_name,
    created_at: order.created_at,
    lines: lines.map(({ sku, name, quantity, unit_price_cents, vat_rate, line_gross_cents }) => ({
      sku,
      name,
      quantity,
      unit_price_cents,
      vat_rate,
      line_gross_cents,
    })),
    totals: computeTotals(lines),
    events: orderEvents(db, orderId).map(({ status, at }) => ({ status, at })),
  };
}

/**
 * Move an order one step forward. Only the single next step is legal:
 * skipping ahead (delivered before shipped) or moving backwards is a
 * 422; touching a terminal order is a 409.
 */
export function transitionOrder(
  db: Database.Database,
  id: number,
  target: OrderStatus,
  at?: string,
): void {
  const order = getOrder(db, id);
  const next = NEXT_STATUS[order.status];
  if (next === null) {
    throw new DomainError(409, `Order ${order.ref} is ${order.status} — no further transitions`);
  }
  if (target !== next) {
    throw new DomainError(422, 'Validation failed', [
      {
        field: 'status',
        message: `Cannot go from ${order.status} to ${target} — the only next step is ${next}`,
      },
    ]);
  }
  db.transaction(() => {
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(target, id);
    appendEvent(db, id, target, at ?? nowIso(), null);
  })();
}

/**
 * Cancel an unshipped order and RESTORE its stock — decrement and
 * restore are exact mirrors, so cancel + re-place is stock-neutral.
 * Shipped/delivered orders cannot be cancelled (409): the goods left
 * the building, returns are out of scope.
 */
export function cancelOrder(db: Database.Database, id: number, at?: string): void {
  const order = getOrder(db, id);
  if (order.status === 'cancelled') {
    throw new DomainError(409, `Order ${order.ref} is already cancelled`);
  }
  if (order.status === 'shipped' || order.status === 'delivered') {
    throw new DomainError(409, `Order ${order.ref} is ${order.status} and can no longer be cancelled`);
  }
  const when = at ?? nowIso();
  db.transaction(() => {
    const restore = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
    for (const line of orderLines(db, id)) restore.run(line.quantity, line.product_id);
    db.prepare("UPDATE orders SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(when, id);
    appendEvent(db, id, 'cancelled', when, 'stock restored');
  })();
}

/** Record that payment arrived (manually, or from a future PSP webhook). */
export function markPaid(db: Database.Database, id: number, at?: string): void {
  const order = getOrder(db, id);
  if (order.status === 'cancelled') {
    throw new DomainError(409, `Order ${order.ref} is cancelled and cannot be marked paid`);
  }
  if (order.paid_at) {
    throw new DomainError(409, `Order ${order.ref} is already marked paid (${order.paid_at})`);
  }
  db.prepare('UPDATE orders SET paid_at = ? WHERE id = ?').run(at ?? nowIso(), id);
}
