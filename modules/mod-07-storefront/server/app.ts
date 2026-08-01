import express, { type NextFunction, type Request, type Response } from 'express';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import type Database from 'better-sqlite3';
import { VAT_RATES } from '../shared/money.js';
import {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  type FieldError,
  type OrderStatus,
  type PaymentStatus,
} from '../shared/types.js';
import {
  checkCredentials,
  clearedCookie,
  createToken,
  requireAuth,
  sessionCookie,
  type AuthConfig,
} from './auth.js';
import {
  cartCookie,
  CART_COOKIE,
  clearedCartCookie,
  orderToken,
  signCartId,
  verifyCartToken,
  verifyOrderToken,
} from './tokens.js';
import { parseCookies } from './auth.js';
import {
  addCartItem,
  cancelOrder,
  cartDetail,
  cartExists,
  checkout,
  createCart,
  DomainError,
  getCategory,
  getProduct,
  guestOrder,
  listOrders,
  markPaid,
  nowIso,
  orderDetail,
  removeCartItem,
  setCartItem,
  shopProduct,
  shopProducts,
  transitionOrder,
} from './store.js';
import { ordersCsv } from './csv.js';
import { noopPlatform, type PlatformHooks } from './platform.js';
import { likeTerm } from './store.js';

// ── Tiny validation helpers ────────────────────────────────────────────

function body(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null
    ? (req.body as Record<string, unknown>)
    : {};
}

function fail(details: FieldError[]): never {
  throw new DomainError(422, 'Validation failed', details);
}

function requireText(
  raw: unknown,
  field: string,
  errors: FieldError[],
  maxLength: number,
): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '' || value.length > maxLength) {
    errors.push({ field, message: `${field} is required (max ${maxLength} characters)` });
  }
  return value;
}

function intIn(
  raw: unknown,
  field: string,
  errors: FieldError[],
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (typeof raw === 'boolean' || raw === '' || raw === null || raw === undefined ||
      !Number.isInteger(n) || n < min || n > max) {
    errors.push({ field, message: `${field} must be an integer between ${min} and ${max}` });
  }
  return n;
}

const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

interface ProductInput {
  sku: string;
  name: string;
  description: string;
  unit_price_cents: number;
  vat_rate: number;
  stock: number;
  category_id: number;
  accent: string | null;
  archived: 0 | 1;
}

function validateProduct(input: Record<string, unknown>): ProductInput {
  const errors: FieldError[] = [];
  const sku = requireText(input.sku, 'sku', errors, 40);
  const name = requireText(input.name, 'name', errors, 160);
  let description = '';
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== 'string' || input.description.length > 2000) {
      errors.push({ field: 'description', message: 'description must be a string (max 2000 characters)' });
    } else {
      description = input.description;
    }
  }
  const unit_price_cents = intIn(input.unit_price_cents, 'unit_price_cents', errors, 0, 100_000_000);
  const vat_rate = Number(input.vat_rate);
  if (!(VAT_RATES as readonly number[]).includes(vat_rate)) {
    errors.push({ field: 'vat_rate', message: `vat_rate must be one of: ${VAT_RATES.join(', ')}` });
  }
  const stock = intIn(input.stock ?? 0, 'stock', errors, 0, 1_000_000);
  const category_id = intIn(input.category_id, 'category_id', errors, 1, Number.MAX_SAFE_INTEGER);
  let accent: string | null = null;
  if (input.accent !== undefined && input.accent !== null && input.accent !== '') {
    if (typeof input.accent !== 'string' || !ACCENT_RE.test(input.accent)) {
      errors.push({ field: 'accent', message: 'accent must be a hex color like #7A9E8F' });
    } else {
      accent = input.accent;
    }
  }
  const archived = input.archived === true || input.archived === 1 ? 1 : 0;
  if (errors.length > 0) fail(errors);
  return { sku, name, description, unit_price_cents, vat_rate, stock, category_id, accent, archived };
}

export interface AppOptions {
  /** Optional transport hardening; omit it (as the tests do) to run unthrottled. */
  hardening?: HardeningConfig;
  db: Database.Database;
  auth: AuthConfig;
  /** Absolute path to the built client (dist/client). Omit to serve API only. */
  staticDir?: string;
  /** Optional PS-08 Payments integration; defaults to a no-op (standalone). */
  platform?: PlatformHooks;
}

export function createApp({ db, hardening, auth, staticDir, platform = noopPlatform }: AppOptions): express.Express {
  const app = express();

  // Transport hardening: security headers, a default-deny CORS policy and
  // per-IP rate limits. Mounted only when a config is passed — index.ts always
  // passes one, tests do not, so suites stay unthrottled and deterministic.
  if (hardening) {
    // Behind the stack's reverse proxy every socket peer is the proxy, so the
    // forwarded chain is what per-IP limiting and audit logging must read.
    if (hardening.trustProxy > 0) app.set('trust proxy', hardening.trustProxy);
    app.use(hardeningMiddleware(hardening));
  }
  app.use(express.json({ limit: '256kb' }));

  /** Verified cart id from the signed cookie, or null. Tampering = no cart. */
  const cartIdOf = (req: Request): number | null => {
    const id = verifyCartToken(auth.secret, parseCookies(req.headers.cookie)[CART_COOKIE]);
    return id !== null && cartExists(db, id) ? id : null;
  };

  /** Existing cart, or a fresh one with its signed cookie set on the response. */
  const ensureCart = (req: Request, res: Response): number => {
    const existing = cartIdOf(req);
    if (existing !== null) return existing;
    const cartId = createCart(db);
    res.setHeader('Set-Cookie', cartCookie(signCartId(auth.secret, cartId), auth.secureCookie));
    return cartId;
  };

  // ── Public: health ───────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Readiness for a deployment healthcheck: the database is reachable and the
  // schema is in place. Liveness (the process answers at all) is /api/health.
  app.get('/api/ready', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ ready: true });
    } catch {
      res.status(503).json({ ready: false });
    }
  });

  // ── Public: catalogue ────────────────────────────────────────────────
  app.get('/api/shop/categories', (_req, res) => {
    const categories = db
      .prepare(
        `SELECT c.id, c.name, c.position,
                (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.archived = 0)
                  AS product_count
         FROM categories c ORDER BY c.position, c.name`,
      )
      .all();
    res.json({ categories });
  });

  app.get('/api/shop/products', (req, res) => {
    let categoryId: number | undefined;
    if (typeof req.query.category === 'string' && req.query.category !== '') {
      if (!/^\d+$/.test(req.query.category)) {
        fail([{ field: 'category', message: 'category must be a category id' }]);
      }
      categoryId = Number(req.query.category);
    }
    res.json({
      products: shopProducts(db, {
        categoryId,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
      }),
    });
  });

  app.get('/api/shop/products/:id', (req, res) => {
    res.json(shopProduct(db, Number(req.params.id)));
  });

  // ── Public: cart ─────────────────────────────────────────────────────
  app.get('/api/shop/cart', (req, res) => {
    res.json(cartDetail(db, cartIdOf(req)));
  });

  app.post('/api/shop/cart/items', (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const productId = intIn(input.product_id, 'product_id', errors, 1, Number.MAX_SAFE_INTEGER);
    const quantity = intIn(input.quantity ?? 1, 'quantity', errors, 1, 1_000_000);
    if (errors.length > 0) fail(errors);
    const cartId = ensureCart(req, res);
    addCartItem(db, cartId, productId, quantity);
    res.status(201).json(cartDetail(db, cartId));
  });

  app.put('/api/shop/cart/items/:productId', (req, res) => {
    const errors: FieldError[] = [];
    const quantity = intIn(body(req).quantity, 'quantity', errors, 0, 1_000_000);
    if (errors.length > 0) fail(errors);
    const cartId = cartIdOf(req);
    if (cartId === null) throw new DomainError(404, 'Cart line not found');
    setCartItem(db, cartId, Number(req.params.productId), quantity);
    res.json(cartDetail(db, cartId));
  });

  app.delete('/api/shop/cart/items/:productId', (req, res) => {
    const cartId = cartIdOf(req);
    if (cartId === null) throw new DomainError(404, 'Cart line not found');
    removeCartItem(db, cartId, Number(req.params.productId));
    res.json(cartDetail(db, cartId));
  });

  // ── Public: checkout ─────────────────────────────────────────────────
  app.post('/api/shop/checkout', async (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const customerName = requireText(input.name, 'name', errors, 160);
    const email = requireText(input.email, 'email', errors, 160);
    if (email !== '' && !/^\S+@\S+\.\S+$/.test(email)) {
      errors.push({ field: 'email', message: 'email must look like an email address' });
    }
    const address = requireText(input.address, 'address', errors, 500);
    if (errors.length > 0) fail(errors);

    const cartId = cartIdOf(req);
    if (cartId === null) {
      fail([{ field: 'cart', message: 'The cart is empty' }]);
    }
    const { orderId, ref } = checkout(db, cartId, { customerName, email, address });
    res.setHeader('Set-Cookie', clearedCartCookie());

    // Collect payment via PS-08 when configured. Best-effort: a payments outage
    // leaves the order placed-but-unpaid (an admin can mark it paid later), it
    // never fails the checkout. A synchronous success marks the order paid now;
    // an async/mock intent settles later via PS-08's webhook/tick.
    let payment: { status: string; public_id: string } | null = null;
    try {
      const total = guestOrder(db, orderId).totals.gross_cents;
      payment = await platform.payOrder({ ref, amountMinor: total, currency: 'EUR' });
      if (payment && payment.status === 'succeeded') markPaid(db, orderId);
    } catch (err) {
      console.warn('[mod-07] platform.payOrder failed:', err);
    }

    res.status(201).json({
      ref,
      token: orderToken(auth.secret, ref),
      payment,
      order: guestOrder(db, orderId),
    });
  });

  // ── Public: guest order lookup (signed token, no account) ────────────
  app.get('/api/shop/orders/:ref', (req, res) => {
    const ref = req.params.ref;
    // Wrong/missing token → the same 404 as an unknown ref, so the
    // endpoint leaks nothing about which refs exist.
    if (!verifyOrderToken(auth.secret, ref, req.query.token)) {
      throw new DomainError(404, 'Order not found');
    }
    const order = db.prepare('SELECT id FROM orders WHERE ref = ?').get(ref) as
      | { id: number }
      | undefined;
    if (!order) throw new DomainError(404, 'Order not found');
    res.json(guestOrder(db, order.id));
  });

  // ── Admin: login (public), then the session guard ────────────────────
  app.post('/api/admin/login', (req, res) => {
    const { username, password } = body(req);
    if (!checkCredentials(auth, username, password)) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    res.setHeader('Set-Cookie', sessionCookie(auth, createToken(auth)));
    res.json({ ok: true, username: auth.username });
  });

  app.use('/api/admin', requireAuth(auth));

  app.post('/api/admin/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  app.get('/api/admin/me', (_req, res) => {
    res.json({ username: auth.username });
  });

  // ── Admin: categories ────────────────────────────────────────────────
  app.get('/api/admin/categories', (_req, res) => {
    const categories = db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
         FROM categories c ORDER BY c.position, c.name`,
      )
      .all();
    res.json({ categories });
  });

  const validateCategory = (input: Record<string, unknown>): { name: string; position: number } => {
    const errors: FieldError[] = [];
    const name = requireText(input.name, 'name', errors, 80);
    const position = intIn(input.position ?? 0, 'position', errors, 0, 1000);
    if (errors.length > 0) fail(errors);
    return { name, position };
  };

  app.post('/api/admin/categories', (req, res) => {
    const values = validateCategory(body(req));
    const exists = db.prepare('SELECT 1 FROM categories WHERE name = ?').get(values.name);
    if (exists) fail([{ field: 'name', message: 'A category with this name already exists' }]);
    const info = db
      .prepare('INSERT INTO categories (name, position, created_at) VALUES (?, ?, ?)')
      .run(values.name, values.position, nowIso());
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid));
  });

  app.put('/api/admin/categories/:id', (req, res) => {
    const category = getCategory(db, Number(req.params.id));
    const values = validateCategory(body(req));
    const clash = db
      .prepare('SELECT 1 FROM categories WHERE name = ? AND id != ?')
      .get(values.name, category.id);
    if (clash) fail([{ field: 'name', message: 'A category with this name already exists' }]);
    db.prepare('UPDATE categories SET name = ?, position = ? WHERE id = ?').run(
      values.name,
      values.position,
      category.id,
    );
    res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(category.id));
  });

  app.delete('/api/admin/categories/:id', (req, res) => {
    const category = getCategory(db, Number(req.params.id));
    const used = db
      .prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ?')
      .get(category.id) as { n: number };
    if (used.n > 0) {
      throw new DomainError(409, `Category has ${used.n} product(s) and cannot be deleted`);
    }
    db.prepare('DELETE FROM categories WHERE id = ?').run(category.id);
    res.json({ ok: true });
  });

  // ── Admin: products ──────────────────────────────────────────────────
  app.get('/api/admin/products', (req, res) => {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    if (search) {
      clauses.push('(p.name LIKE ? ESCAPE \'\\\' OR p.sku LIKE ? ESCAPE \'\\\')');
      params.push(likeTerm(search), likeTerm(search));
    }
    if (typeof req.query.category === 'string' && /^\d+$/.test(req.query.category)) {
      clauses.push('p.category_id = ?');
      params.push(Number(req.query.category));
    }
    const products = db
      .prepare(
        `SELECT p.*, c.name AS category_name,
                (SELECT COUNT(*) FROM order_lines l WHERE l.product_id = p.id) AS order_line_count
         FROM products p JOIN categories c ON c.id = p.category_id
         ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY p.sku`,
      )
      .all(...params);
    res.json({ products });
  });

  app.post('/api/admin/products', (req, res) => {
    const values = validateProduct(body(req));
    getCategory(db, values.category_id);
    const clash = db.prepare('SELECT 1 FROM products WHERE sku = ?').get(values.sku);
    if (clash) fail([{ field: 'sku', message: 'A product with this SKU already exists' }]);
    const info = db
      .prepare(
        `INSERT INTO products (sku, name, description, unit_price_cents, vat_rate, stock, category_id, accent, archived, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        values.sku,
        values.name,
        values.description,
        values.unit_price_cents,
        values.vat_rate,
        values.stock,
        values.category_id,
        values.accent,
        values.archived,
        nowIso(),
      );
    res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid));
  });

  app.get('/api/admin/products/:id', (req, res) => {
    res.json(getProduct(db, Number(req.params.id)));
  });

  app.put('/api/admin/products/:id', (req, res) => {
    const product = getProduct(db, Number(req.params.id));
    const values = validateProduct(body(req));
    getCategory(db, values.category_id);
    const clash = db
      .prepare('SELECT 1 FROM products WHERE sku = ? AND id != ?')
      .get(values.sku, product.id);
    if (clash) fail([{ field: 'sku', message: 'A product with this SKU already exists' }]);
    db.prepare(
      `UPDATE products SET sku = ?, name = ?, description = ?, unit_price_cents = ?, vat_rate = ?,
       stock = ?, category_id = ?, accent = ?, archived = ? WHERE id = ?`,
    ).run(
      values.sku,
      values.name,
      values.description,
      values.unit_price_cents,
      values.vat_rate,
      values.stock,
      values.category_id,
      values.accent,
      values.archived,
      product.id,
    );
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(product.id));
  });

  /** Relative stock adjustment: {delta: +5 / -3}. Never below zero (422). */
  app.post('/api/admin/products/:id/stock', (req, res) => {
    const product = getProduct(db, Number(req.params.id));
    const errors: FieldError[] = [];
    const delta = intIn(body(req).delta, 'delta', errors, -1_000_000, 1_000_000);
    if (errors.length > 0) fail(errors);
    if (product.stock + delta < 0) {
      fail([
        {
          field: 'delta',
          message: `Stock cannot go negative (current ${product.stock}, delta ${delta})`,
        },
      ]);
    }
    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(delta, product.id);
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(product.id));
  });

  app.delete('/api/admin/products/:id', (req, res) => {
    const product = getProduct(db, Number(req.params.id));
    const used = db
      .prepare('SELECT COUNT(*) AS n FROM order_lines WHERE product_id = ?')
      .get(product.id) as { n: number };
    if (used.n > 0) {
      throw new DomainError(
        409,
        `Product appears on ${used.n} order line(s) and cannot be deleted — archive it instead`,
      );
    }
    db.prepare('DELETE FROM products WHERE id = ?').run(product.id);
    res.json({ ok: true });
  });

  // ── Admin: orders ────────────────────────────────────────────────────
  const orderListOptions = (req: Request) => {
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (rawStatus && !(ORDER_STATUSES as readonly string[]).includes(rawStatus)) {
      fail([{ field: 'status', message: `status must be one of: ${ORDER_STATUSES.join(', ')}` }]);
    }
    const rawPayment = typeof req.query.payment === 'string' ? req.query.payment : undefined;
    if (rawPayment && !(PAYMENT_STATUSES as readonly string[]).includes(rawPayment)) {
      fail([{ field: 'payment', message: `payment must be one of: ${PAYMENT_STATUSES.join(', ')}` }]);
    }
    return {
      status: rawStatus as OrderStatus | undefined,
      payment: rawPayment as PaymentStatus | undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
    };
  };

  app.get('/api/admin/orders', (req, res) => {
    res.json({ orders: listOrders(db, orderListOptions(req)) });
  });

  app.get('/api/admin/orders/export.csv', (req, res) => {
    const csv = ordersCsv(listOrders(db, orderListOptions(req)));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.send(csv);
  });

  app.get('/api/admin/orders/:id', (req, res) => {
    res.json(orderDetail(db, Number(req.params.id)));
  });

  app.post('/api/admin/orders/:id/status', (req, res) => {
    const raw = body(req).status;
    if (typeof raw !== 'string' || !(ORDER_STATUSES as readonly string[]).includes(raw)) {
      fail([{ field: 'status', message: `status must be one of: ${ORDER_STATUSES.join(', ')}` }]);
    }
    if (raw === 'cancelled') {
      fail([{ field: 'status', message: 'Use POST …/cancel to cancel an order' }]);
    }
    transitionOrder(db, Number(req.params.id), raw as OrderStatus);
    res.json(orderDetail(db, Number(req.params.id)));
  });

  app.post('/api/admin/orders/:id/cancel', (req, res) => {
    cancelOrder(db, Number(req.params.id));
    res.json(orderDetail(db, Number(req.params.id)));
  });

  app.post('/api/admin/orders/:id/mark-paid', (req, res) => {
    markPaid(db, Number(req.params.id));
    res.json(orderDetail(db, Number(req.params.id)));
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
      res
        .status(err.status)
        .json({ error: err.message, details: err.details, ...(err.items ? { items: err.items } : {}) });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
