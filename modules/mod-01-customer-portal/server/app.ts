import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type Request, type Response } from 'express';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import type Database from 'better-sqlite3';
import { isOrderStatus, type CustomerProfile } from '../shared/types.js';
import {
  clearedCookie,
  COOKIE_NAME,
  createToken,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  parseCookies,
  sessionCookie,
  verifyPassword,
  verifyToken,
  type SessionConfig,
} from './auth.js';
import { noopPlatform, type PlatformHooks } from './platform.js';

interface CustomerRow {
  id: number;
  email: string;
  name: string;
  company: string;
  password_hash: string;
  token_version: number;
  created_at: string;
}

const MIN_PASSWORD_LENGTH = 8;

/** Columns of an order summary; subselects add the per-order counts. */
const ORDER_SUMMARY = `
  o.id, o.order_no, o.status, o.currency, o.total_cents, o.placed_at,
  (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count,
  (SELECT COUNT(*) FROM documents d WHERE d.order_id = o.id) AS document_count`;

const DOCUMENT_META = `
  d.id, d.order_id, o.order_no, d.doc_type, d.title, d.filename, d.size_bytes, d.created_at`;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function profileOf(customer: CustomerRow): CustomerProfile {
  const { id, email, name, company, created_at } = customer;
  return { id, email, name, company, created_at };
}

/** Parse a positive-integer id path param; anything else is "not found". */
function idParam(req: Request): number | null {
  const raw = req.params.id as string;
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

export interface AppOptions {
  /** Optional transport hardening; omit it (as the tests do) to run unthrottled. */
  hardening?: HardeningConfig;
  db: Database.Database;
  session: SessionConfig;
  /** Directory holding the stored document files. */
  documentsDir: string;
  /** Absolute path to the built client (dist/client). Omit to serve API only. */
  staticDir?: string;
  /** Optional PS-07 Audit integration; defaults to a no-op (standalone). */
  platform?: PlatformHooks;
}

export function createApp({ db, hardening, session, documentsDir, staticDir, platform = noopPlatform }: AppOptions): express.Express {
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

  const customerById = db.prepare('SELECT * FROM customers WHERE id = ?');
  const customerByEmail = db.prepare('SELECT * FROM customers WHERE email = ?');

  const issueSession = (res: Response, customer: CustomerRow): void => {
    const token = createToken(session, {
      customerId: customer.id,
      tokenVersion: customer.token_version,
    });
    res.setHeader('Set-Cookie', sessionCookie(session, token));
  };

  // ── Public routes ────────────────────────────────────────────────────
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

  app.post('/api/login', (req, res) => {
    const { email, password } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof email !== 'string' || typeof password !== 'string') {
      res.status(422).json({ error: 'Email and password are required' });
      return;
    }
    const customer = customerByEmail.get(email.trim().toLowerCase()) as CustomerRow | undefined;
    // Verify against a dummy hash on unknown emails so timing does not
    // reveal whether an account exists.
    const ok = customer
      ? verifyPassword(password, customer.password_hash)
      : verifyPassword(password, DUMMY_PASSWORD_HASH);
    if (!customer || !ok) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }
    issueSession(res, customer);
    res.json({ customer: profileOf(customer) });
  });

  // ── Everything below requires a valid customer session ───────────────
  app.use('/api', (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const claims = token ? verifyToken(session, token) : null;
    if (claims) {
      const customer = customerById.get(claims.customerId) as CustomerRow | undefined;
      // Token versions must match: bumping the version on password change
      // invalidates every previously issued token for the account.
      if (customer && customer.token_version === claims.tokenVersion) {
        res.locals.customer = customer;
        next();
        return;
      }
    }
    res.status(401).json({ error: 'Authentication required' });
  });

  const me = (res: Response): CustomerRow => res.locals.customer as CustomerRow;

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  // ── Account ──────────────────────────────────────────────────────────
  app.get('/api/me', (_req, res) => {
    res.json({ customer: profileOf(me(res)) });
  });

  app.post('/api/me/password', (req, res) => {
    const { currentPassword, newPassword } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      res.status(422).json({ error: 'Current and new password are required' });
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      res.status(422).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }
    const customer = me(res);
    if (!verifyPassword(currentPassword, customer.password_hash)) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
    const nextVersion = customer.token_version + 1;
    db.prepare('UPDATE customers SET password_hash = ?, token_version = ? WHERE id = ?').run(
      hashPassword(newPassword),
      nextVersion,
      customer.id,
    );
    // Old tokens are now invalid; keep this session alive with a fresh one.
    issueSession(res, { ...customer, token_version: nextVersion });
    void platform.audit({ actor: `customer:${customer.id}`, action: 'password.changed', resource: `customer:${customer.id}` });
    res.json({ ok: true });
  });

  // ── Orders (always scoped to the signed-in customer) ─────────────────
  app.get('/api/orders', (req, res) => {
    const clauses = ['o.customer_id = ?'];
    const params: (string | number)[] = [me(res).id];

    const status = str(req.query.status);
    if (status) {
      if (!isOrderStatus(status)) {
        res.status(422).json({ error: `Unknown status "${status}"` });
        return;
      }
      clauses.push('o.status = ?');
      params.push(status);
    }

    const search = str(req.query.search);
    if (search) {
      clauses.push(
        `(o.order_no LIKE ? OR EXISTS (
           SELECT 1 FROM order_items i
           WHERE i.order_id = o.id AND (i.description LIKE ? OR i.sku LIKE ?)
         ))`,
      );
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const orders = db
      .prepare(
        `SELECT ${ORDER_SUMMARY} FROM orders o
         WHERE ${clauses.join(' AND ')}
         ORDER BY o.placed_at DESC`,
      )
      .all(...params);
    res.json({ orders });
  });

  app.get('/api/orders/:id', (req, res) => {
    const id = idParam(req);
    const order = id
      ? db
          .prepare(`SELECT ${ORDER_SUMMARY} FROM orders o WHERE o.id = ? AND o.customer_id = ?`)
          .get(id, me(res).id)
      : undefined;
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    const items = db
      .prepare(
        `SELECT id, sku, description, quantity, unit_price_cents
         FROM order_items WHERE order_id = ? ORDER BY id`,
      )
      .all(id);
    const events = db
      .prepare('SELECT id, status, at, note FROM order_events WHERE order_id = ? ORDER BY at, id')
      .all(id);
    const documents = db
      .prepare(
        `SELECT ${DOCUMENT_META} FROM documents d
         JOIN orders o ON o.id = d.order_id
         WHERE d.order_id = ? ORDER BY d.created_at`,
      )
      .all(id);
    res.json({ order, items, events, documents });
  });

  // ── Documents ────────────────────────────────────────────────────────
  app.get('/api/documents', (_req, res) => {
    const documents = db
      .prepare(
        `SELECT ${DOCUMENT_META} FROM documents d
         LEFT JOIN orders o ON o.id = d.order_id
         WHERE d.customer_id = ?
         ORDER BY d.created_at DESC`,
      )
      .all(me(res).id);
    res.json({ documents });
  });

  app.get('/api/documents/:id/download', (req, res) => {
    const id = idParam(req);
    const doc = id
      ? (db.prepare('SELECT filename, stored_name FROM documents WHERE id = ? AND customer_id = ?').get(
          id,
          me(res).id,
        ) as { filename: string; stored_name: string } | undefined)
      : undefined;
    if (!doc) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    // stored_name comes exclusively from the database (written by the
    // seed script), never from user input.
    const path = resolve(documentsDir, doc.stored_name);
    if (!existsSync(path)) {
      res.status(404).json({ error: 'Document file missing — re-run the seed script' });
      return;
    }
    res.download(path, doc.filename);
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

  return app;
}
