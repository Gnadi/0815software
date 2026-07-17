import express, { type NextFunction, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { UNITS, type FieldError, type Unit } from '../shared/types.js';
import {
  checkCredentials,
  clearedCookie,
  createToken,
  requireAuth,
  sessionCookie,
  type AuthConfig,
} from './auth.js';
import { stockCsv } from './csv.js';
import {
  DomainError,
  movementHistory,
  recordAdjustment,
  recordReceipt,
  stockByWarehouse,
  stockOverview,
  transfer,
} from './ledger.js';
import {
  createPurchaseOrder,
  deleteDraft,
  listPurchaseOrders,
  markOrdered,
  purchaseOrderDetail,
  receivePurchaseOrder,
} from './purchase-orders.js';

// ── Tiny validation helpers ────────────────────────────────────────────

function body(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null
    ? (req.body as Record<string, unknown>)
    : {};
}

function fail(details: FieldError[]): never {
  throw new DomainError(422, 'Validation failed', details);
}

function id(raw: unknown, field: string, errors: FieldError[]): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) errors.push({ field, message: `${field} must be a positive integer id` });
  return n;
}

function quantity(raw: unknown, field: string, errors: FieldError[], allowNegative = false): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (typeof raw === 'boolean' || raw === '' || raw === undefined || raw === null || Number.isNaN(n) || !Number.isFinite(n)) {
    errors.push({ field, message: `${field} must be a number` });
    return NaN;
  }
  if (!allowNegative && n <= 0) errors.push({ field, message: `${field} must be greater than zero` });
  if (allowNegative && n === 0) errors.push({ field, message: `${field} must not be zero` });
  return n;
}

function optText(raw: unknown, field: string, errors: FieldError[], maxLength = 200): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    errors.push({ field, message: `${field} must be a string` });
    return null;
  }
  if (raw.length > maxLength) errors.push({ field, message: `${field} must be at most ${maxLength} characters` });
  return raw;
}

interface ProductInput {
  sku: string;
  name: string;
  unit: Unit;
  reorder_point: number;
}

function validateProduct(input: Record<string, unknown>): ProductInput {
  const errors: FieldError[] = [];
  const sku = typeof input.sku === 'string' ? input.sku.trim() : '';
  if (sku === '') errors.push({ field: 'sku', message: 'SKU is required' });
  else if (!/^[A-Z0-9-]{2,32}$/.test(sku)) {
    errors.push({ field: 'sku', message: 'SKU must be 2–32 uppercase letters, digits or dashes' });
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '' || name.length > 160) errors.push({ field: 'name', message: 'Name is required (max 160 characters)' });
  const unit = (input.unit ?? 'pcs') as Unit;
  if (!UNITS.includes(unit)) errors.push({ field: 'unit', message: `Unit must be one of: ${UNITS.join(', ')}` });
  const reorder = input.reorder_point === undefined || input.reorder_point === null || input.reorder_point === ''
    ? 0
    : Number(input.reorder_point);
  if (Number.isNaN(reorder) || reorder < 0) {
    errors.push({ field: 'reorder_point', message: 'Reorder point must be a number ≥ 0' });
  }
  if (errors.length > 0) fail(errors);
  return { sku, name, unit, reorder_point: reorder };
}

export interface AppOptions {
  db: Database.Database;
  auth: AuthConfig;
  /** Absolute path to the built client (dist/client). Omit to serve API only. */
  staticDir?: string;
}

export function createApp({ db, auth, staticDir }: AppOptions): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // ── Public routes ────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/login', (req, res) => {
    const { username, password } = body(req);
    if (!checkCredentials(auth, username, password)) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    res.setHeader('Set-Cookie', sessionCookie(auth, createToken(auth)));
    res.json({ ok: true, username: auth.username });
  });

  // ── Everything below requires a valid session ────────────────────────
  app.use('/api', requireAuth(auth));

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  app.get('/api/me', (_req, res) => {
    res.json({ username: auth.username });
  });

  app.get('/api/warehouses', (_req, res) => {
    res.json({ warehouses: db.prepare('SELECT * FROM warehouses ORDER BY id').all() });
  });

  app.get('/api/suppliers', (_req, res) => {
    res.json({ suppliers: db.prepare('SELECT * FROM suppliers ORDER BY name').all() });
  });

  // ── Stock overview + CSV export ──────────────────────────────────────
  const overviewOpts = (req: Request) => ({
    search: typeof req.query.search === 'string' ? req.query.search : undefined,
    lowOnly: req.query.low === '1' || req.query.low === 'true',
  });

  app.get('/api/stock', (req, res) => {
    res.json({ rows: stockOverview(db, overviewOpts(req)) });
  });

  app.get('/api/stock/export.csv', (req, res) => {
    const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY id').all() as {
      id: number;
      code: string;
      name: string;
    }[];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="stock-levels.csv"');
    res.send(stockCsv(warehouses, stockOverview(db, overviewOpts(req))));
  });

  // ── Products ─────────────────────────────────────────────────────────
  app.get('/api/products', (_req, res) => {
    res.json({ products: db.prepare('SELECT * FROM products ORDER BY sku').all() });
  });

  app.post('/api/products', (req, res) => {
    const values = validateProduct(body(req));
    const info = db
      .prepare('INSERT INTO products (sku, name, unit, reorder_point) VALUES (?, ?, ?, ?)')
      .run(values.sku, values.name, values.unit, values.reorder_point);
    res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid));
  });

  app.get('/api/products/:id', (req, res) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!product) throw new DomainError(404, 'Product not found');
    res.json({ product, stock: stockByWarehouse(db, Number(req.params.id)) });
  });

  app.put('/api/products/:id', (req, res) => {
    const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
    if (!existing) throw new DomainError(404, 'Product not found');
    const values = validateProduct(body(req));
    db.prepare('UPDATE products SET sku = ?, name = ?, unit = ?, reorder_point = ? WHERE id = ?').run(
      values.sku,
      values.name,
      values.unit,
      values.reorder_point,
      req.params.id,
    );
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
  });

  app.delete('/api/products/:id', (req, res) => {
    const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
    if (!existing) throw new DomainError(404, 'Product not found');
    const used = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM movements WHERE product_id = @id)
               + (SELECT COUNT(*) FROM purchase_order_lines WHERE product_id = @id) AS n`,
      )
      .get({ id: req.params.id }) as { n: number };
    if (used.n > 0) {
      throw new DomainError(409, 'Product has ledger movements or purchase order lines and cannot be deleted');
    }
    db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/products/:id/movements', (req, res) => {
    const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
    if (!existing) throw new DomainError(404, 'Product not found');
    res.json({ movements: movementHistory(db, Number(req.params.id)) });
  });

  // ── Ledger movements ─────────────────────────────────────────────────
  app.post('/api/movements', (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const type = input.type;
    if (type !== 'receipt' && type !== 'adjustment') {
      fail([{ field: 'type', message: 'Type must be "receipt" or "adjustment" (transfers: POST /api/transfers, PO receipts: receive the purchase order)' }]);
    }
    const productId = id(input.product_id, 'product_id', errors);
    const warehouseId = id(input.warehouse_id, 'warehouse_id', errors);
    const qty = quantity(input.quantity, 'quantity', errors, type === 'adjustment');
    const reference = optText(input.reference, 'reference', errors, 60);
    const note = optText(input.note, 'note', errors, 500);
    if (errors.length > 0) fail(errors);

    const movementInput = { productId, warehouseId, quantity: qty, reference, note };
    const movementId =
      type === 'receipt' ? recordReceipt(db, movementInput) : recordAdjustment(db, movementInput);
    res.status(201).json(db.prepare('SELECT * FROM movements WHERE id = ?').get(movementId));
  });

  app.post('/api/transfers', (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const productId = id(input.product_id, 'product_id', errors);
    const fromWarehouseId = id(input.from_warehouse_id, 'from_warehouse_id', errors);
    const toWarehouseId = id(input.to_warehouse_id, 'to_warehouse_id', errors);
    const qty = quantity(input.quantity, 'quantity', errors);
    const reference = optText(input.reference, 'reference', errors, 60);
    const note = optText(input.note, 'note', errors, 500);
    if (errors.length > 0) fail(errors);

    const result = transfer(db, { productId, fromWarehouseId, toWarehouseId, quantity: qty, reference, note });
    res.status(201).json({ ok: true, ...result });
  });

  // ── Purchase orders ──────────────────────────────────────────────────
  app.get('/api/purchase-orders', (_req, res) => {
    res.json({ purchase_orders: listPurchaseOrders(db) });
  });

  app.post('/api/purchase-orders', (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const supplierId = id(input.supplier_id, 'supplier_id', errors);
    const rawLines = Array.isArray(input.lines) ? (input.lines as Record<string, unknown>[]) : [];
    if (rawLines.length === 0) errors.push({ field: 'lines', message: 'At least one line is required' });
    const lines = rawLines.map((line, i) => ({
      productId: id(line.product_id, `lines[${i}].product_id`, errors),
      quantity: quantity(line.quantity, `lines[${i}].quantity`, errors),
    }));
    if (errors.length > 0) fail(errors);

    const poId = createPurchaseOrder(db, { supplierId, lines });
    res.status(201).json(purchaseOrderDetail(db, poId));
  });

  app.get('/api/purchase-orders/:id', (req, res) => {
    res.json(purchaseOrderDetail(db, Number(req.params.id)));
  });

  app.post('/api/purchase-orders/:id/order', (req, res) => {
    markOrdered(db, Number(req.params.id));
    res.json(purchaseOrderDetail(db, Number(req.params.id)));
  });

  app.post('/api/purchase-orders/:id/receive', (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const warehouseId = id(input.warehouse_id, 'warehouse_id', errors);
    const rawLines = Array.isArray(input.lines) ? (input.lines as Record<string, unknown>[]) : [];
    // Lines left empty / at 0 in the receive form are simply skipped.
    const lines = rawLines
      .filter((line) => !(line.quantity === undefined || line.quantity === null || line.quantity === '' || Number(line.quantity) === 0))
      .map((line, i) => ({
        lineId: id(line.line_id, `lines[${i}].line_id`, errors),
        quantity: quantity(line.quantity, `lines[${i}].quantity`, errors),
      }));
    if (errors.length > 0) fail(errors);

    receivePurchaseOrder(db, Number(req.params.id), { warehouseId, lines });
    res.json(purchaseOrderDetail(db, Number(req.params.id)));
  });

  app.delete('/api/purchase-orders/:id', (req, res) => {
    deleteDraft(db, Number(req.params.id));
    res.json({ ok: true });
  });

  // ── Static client (production build) ─────────────────────────────────
  if (staticDir) {
    app.use(express.static(staticDir));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api')) {
        res.sendFile('index.html', { root: staticDir });
        return;
      }
      next();
    });
  }

  // ── Error mapping ────────────────────────────────────────────────────
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof DomainError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
      res.status(422).json({
        error: 'Validation failed',
        details: [{ field: 'sku', message: 'Value must be unique' }],
      });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
