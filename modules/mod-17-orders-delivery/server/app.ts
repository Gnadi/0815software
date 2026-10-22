import express, { type NextFunction, type Request, type Response } from 'express';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import type Database from 'better-sqlite3';
import { ORDER_STATUSES, type FieldError, type OrderStatus } from '../shared/types.js';
import {
  accessOf,
  actorOf,
  checkCredentials,
  clearedCookie,
  createToken,
  requireAuth,
  sessionCookie,
  type AuthConfig,
} from './auth.js';
import { createHandoff, isRedeemPath, requestedAccess, safeServiceTokenEqual } from './handoff.js';
import { parseSummaryContext } from '../shared/summary.js';
import { moduleSummary } from './summary.js';
import { noopPlatform, OfferFetchError, type PlatformHooks } from './platform.js';
import { effectiveSeller, readSettings, settingsStamp, validateSettings, writeSettings } from './settings.js';
import { bookStock } from './stock.js';
import { LOCAL_LOGIN, nullVerifier, type LoginMode, type LoginVerifier } from './sso.js';
import {
  cancelOrder,
  createDeliveryNote,
  createOrder,
  DomainError,
  getDeliveryNote,
  listOrders,
  markInvoiced,
  orderDetail,
  setLineSku,
  todayIso,
  type OrderInput,
  type OrderLineInput,
} from './orders.js';
import { importOffer } from './transfer-import.js';
import { deliveryTransfer } from './transfer-export.js';
import { renderDeliveryNotePdf, renderOrderPdf } from './pdf.js';
import type { SellerConfig } from './config.js';

// ── Tiny validation helpers ────────────────────────────────────────────

function body(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null
    ? (req.body as Record<string, unknown>)
    : {};
}

function fail(details: FieldError[]): never {
  throw new DomainError(422, 'Validation failed', details);
}

function idParam(req: Request, what = 'Order'): number {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new DomainError(404, `${what} not found`);
  return n;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function optText(raw: unknown, field: string, errors: FieldError[], max: number): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > max) {
    errors.push({ field, message: `${field} must be text of at most ${max} characters` });
    return null;
  }
  return raw.trim() === '' ? null : raw.trim();
}

function optDate(raw: unknown, field: string, errors: FieldError[]): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !DATE_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    errors.push({ field, message: `${field} must be a date in YYYY-MM-DD format` });
    return null;
  }
  return raw;
}

/** Up to three decimals: quantities are compared in thousandths (shared/money.ts). */
function quantity(raw: unknown, field: string, errors: FieldError[]): number {
  const q = Number(raw);
  if (typeof raw === 'boolean' || raw === '' || raw === null || !Number.isFinite(q) || q <= 0 || q > 1_000_000 || Math.round(q * 1000) !== q * 1000) {
    errors.push({ field, message: 'Quantity must be a number greater than zero, with at most three decimals' });
  }
  return q;
}

/** An order entered by hand: the customer as they ordered, and the lines. */
function validateOrder(input: Record<string, unknown>, today: string): OrderInput {
  const errors: FieldError[] = [];
  const c = (typeof input.customer === 'object' && input.customer !== null ? input.customer : {}) as Record<string, unknown>;
  const name = typeof c.name === 'string' ? c.name.trim() : '';
  if (name === '' || name.length > 200) errors.push({ field: 'customer.name', message: 'The customer name is required (max 200 characters)' });
  const address = optText(c.address, 'customer.address', errors, 500);
  const customer = {
    name,
    contactPerson: optText(c.contact_person, 'customer.contact_person', errors, 200),
    email: optText(c.email, 'customer.email', errors, 200),
    vatId: optText(c.vat_id, 'customer.vat_id', errors, 30),
    addressLines: address ? address.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '') : [],
  };
  const orderDate = optDate(input.order_date, 'order_date', errors) ?? today;
  if (orderDate > today) errors.push({ field: 'order_date', message: 'An order is confirmed when it is placed — not in the future' });
  const customerReference = optText(input.customer_reference, 'customer_reference', errors, 100);
  const note = optText(input.note, 'note', errors, 1000);
  const raw = Array.isArray(input.lines) ? (input.lines as Record<string, unknown>[]) : [];
  if (raw.length === 0) errors.push({ field: 'lines', message: 'An order has at least one line' });
  const lines: OrderLineInput[] = raw.map((line, i) => {
    const description = typeof line.description === 'string' ? line.description.trim() : '';
    if (description === '' || description.length > 200) errors.push({ field: `lines[${i}].description`, message: 'Description is required (max 200 characters)' });
    const q = quantity(line.quantity, `lines[${i}].quantity`, errors);
    const price = Number(line.unit_price_cents);
    if (!Number.isInteger(price) || price < 0 || price > 100_000_000) errors.push({ field: `lines[${i}].unit_price_cents`, message: 'Unit price must be a non-negative integer amount in cents' });
    const discount = line.discount_percent === undefined || line.discount_percent === null || line.discount_percent === '' ? 0 : Number(line.discount_percent);
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) errors.push({ field: `lines[${i}].discount_percent`, message: 'Discount must be between 0 and 100 %' });
    const vat = Number(line.vat_rate);
    if (![0, 7, 10, 13, 19, 20].includes(vat)) errors.push({ field: `lines[${i}].vat_rate`, message: 'VAT rate must be one of: 0, 7, 10, 13, 19, 20' });
    const sku = optText(line.sku, `lines[${i}].sku`, errors, 60);
    return { description, quantity: q, unitPriceCents: price, discountPercent: discount, vatRate: vat, sku };
  });
  if (errors.length > 0) fail(errors);
  return { orderDate, customer, customerReference, note, lines };
}

export interface AppOptions {
  /** Optional transport hardening; omit it (as the tests do) to run unthrottled. */
  hardening?: HardeningConfig;
  db: Database.Database;
  auth: AuthConfig;
  /** Absolute path to the built client (dist/client). Omit to serve API only. */
  staticDir?: string;
  /** Optional PS-07 Audit and MOD-13 Offers integration; defaults to standalone. */
  platform?: PlatformHooks;
  /** The letterhead from the environment; Settings override it field by field. */
  seller?: SellerConfig;
  /** Injectable "today", so tests can pin dates. */
  today?: () => string;
  verifyLogin?: LoginVerifier;
  /**
   * The platform machine token (PLATFORM_SERVICE_TOKEN). When set, it is the
   * only credential that opens the shell summary and the handoff routes — the
   * caller is another service in the same stack, not a human. Unset means all
   * of them are closed, which is the standalone default.
   */
  serviceToken?: string;
  /**
   * The shell origins allowed to embed this module and to sign users into it
   * (SHELL_ORIGIN). Empty — the default — leaves the handoff routes unmounted
   * entirely and keeps `X-Frame-Options: DENY` in `hardening.ts`. A list, so a
   * stack can run both MOD-15 Workspace and MOD-16 Mosaic.
   */
  shellOrigins?: string[];
  /**
   * Which credentials the login form should name, served as-is from
   * GET /api/auth-mode. Defaults to this module's own — the standalone case.
   */
  loginMode?: LoginMode;
}

const DEFAULT_SELLER: SellerConfig = { name: '0815software GmbH', addressLines: ['Beispielgasse 8/15', '1010 Wien', 'Austria'], vatId: 'ATU00000000' };

export function createApp({ db, hardening, auth, staticDir, platform = noopPlatform, seller = DEFAULT_SELLER, today = todayIso, verifyLogin = nullVerifier, loginMode = LOCAL_LOGIN, serviceToken, shellOrigins = [] }: AppOptions): express.Express {
  const app = express();
  const handoff = shellOrigins.length > 0 ? createHandoff(auth) : null;

  // Transport hardening: security headers, a default-deny CORS policy and
  // per-IP rate limits. Mounted only when a config is passed — index.ts always
  // passes one, tests do not, so suites stay unthrottled and deterministic.
  if (hardening) {
    // Behind the stack's reverse proxy every socket peer is the proxy, so the
    // forwarded chain is what per-IP limiting and audit logging must read.
    if (hardening.trustProxy > 0) app.set('trust proxy', hardening.trustProxy);
    app.use(hardeningMiddleware(hardening));
  }
  app.use(express.json({ limit: '1mb' }));

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

  // Which credentials this deployment accepts, read by the login form before
  // anyone is signed in — hence public. With SSO configured, PS-01 validates
  // logins and this module's own admin credentials are rejected, so a form
  // advertising them would send people at a password that cannot work. The org
  // slug is deployment configuration, not a secret.
  app.get('/api/auth-mode', (_req, res) => {
    res.json(loginMode);
  });

  app.post('/api/login', async (req, res) => {
    const { username, password } = body(req);
    // SSO seam: when IDENTITY_URL is set, PS-01 validates the credentials;
    // otherwise the local admin credentials do. Either way the module mints
    // its own session below, so the rest of the request path is unchanged.
    const viaSso = await verifyLogin(username, password);
    // An unreachable PS-01 is not a wrong password. Saying 401 here would tell
    // the user to check credentials that were never checked, and would let a
    // broken identity deployment look like a wave of bad logins; 503 says what
    // actually happened, to the user and to whatever is monitoring this.
    if (viaSso !== null && !viaSso.ok && viaSso.reason === 'unavailable') {
      res.status(503).json({ error: 'Identity service unavailable' });
      return;
    }
    // Who signed in: the PS-01 identity when SSO validated it, the local admin
    // otherwise. It rides in the session token and ends up on every audit
    // entry and history row the session writes.
    const actor =
      viaSso === null
        ? checkCredentials(auth, username, password)
          ? auth.username
          : null
        : viaSso.ok
          ? viaSso.actor
          : null;
    if (actor === null) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    // The level rides in the token next to the actor: the local admin manages,
    // a PS-01 identity gets what its module permissions grant.
    const access = viaSso !== null && viaSso.ok ? viaSso.access : 'manage';
    res.setHeader('Set-Cookie', sessionCookie(auth, createToken(auth, actor, Date.now(), access)));
    res.json({ ok: true, username: actor, access });
  });

  // ── Machine-to-machine ───────────────────────────────────────────────
  // Authenticated with the platform machine token, NOT a staff session: the
  // caller is another service in the same stack. With no token configured
  // every route below is closed, which is the standalone default.
  function requireServiceToken(req: Request): void {
    const provided = req.headers['x-service-token'];
    if (!serviceToken || typeof provided !== 'string' || !safeServiceTokenEqual(provided, serviceToken)) {
      throw new DomainError(401, 'Service token required');
    }
  }

  // Hand a delivery to whatever bills it, as the neutral transfer
  // (shared/transfer.ts, kind `delivery`) — no MOD-17 ids or internals.
  app.get('/api/delivery-notes/:number/transfer', (req, res) => {
    requireServiceToken(req);
    res.json(deliveryTransfer(db, req.params.number));
  });

  // The billing module says it took the delivery over. Idempotent: the
  // first reference is kept, a retry changes nothing.
  app.post('/api/delivery-notes/:number/invoiced', (req, res) => {
    requireServiceToken(req);
    const { reference, actor } = body(req);
    if (typeof reference !== 'string' || reference.trim() === '' || reference.length > 200) {
      fail([{ field: 'reference', message: 'reference is required — what the billing module made of it' }]);
    }
    // The person who billed it, as the billing module names them; never "service".
    const who = typeof actor === 'string' && actor.trim() !== '' ? actor.trim() : 'billing';
    res.json(markInvoiced(db, req.params.number, (reference as string).trim(), who));
  });

  // What this module looks like on a shell's board (shared/summary.ts).
  app.get('/api/summary', (req, res, next) => {
  // Only ours when a machine token is actually presented.
    //
    // MOD-11 already serves a session-guarded /api/summary of its own, and this
    // route is mounted above the session gate, so without the fallthrough it
    // would shadow that endpoint and answer 401 to the module's own frontend.
    // Rather than give one module a different path from the other fourteen —
    // the contract is worth more than the collision is expensive — this route
    // claims only the requests that are unambiguously the shell's.
    if (req.headers['x-service-token'] === undefined) {
      next();
      return;
    }
        requireServiceToken(req);
    res.json(moduleSummary(db, parseSummaryContext(req.query as Record<string, unknown>)));
  });

  // ── Shell handoff ────────────────────────────────────────────────────
  // Mounted only when the operator named a shell in SHELL_ORIGIN, so a
  // standalone module has no such surface at all. See handoff.ts for why the
  // destination is signed into the ticket rather than passed alongside it.
  if (handoff) {
    app.post('/api/session/handoff', (req, res) => {
      requireServiceToken(req);
      const { actor, path, access } = body(req);
      const level = requestedAccess(access);
      if (typeof actor !== 'string' || actor.trim() === '') throw new DomainError(422, 'actor is required');
      const target = path === undefined ? '/' : path;
      if (!isRedeemPath(target)) throw new DomainError(422, 'path must be module-relative');
      if (level === null) throw new DomainError(422, 'access must be view, edit or manage');
      res.json(handoff.issue(actor.trim(), target, Date.now(), level));
    });

    app.post('/api/session/issue', (req, res) => {
      requireServiceToken(req);
      const { actor, access } = body(req);
      const level = requestedAccess(access);
      if (typeof actor !== 'string' || actor.trim() === '') throw new DomainError(422, 'actor is required');
      if (level === null) throw new DomainError(422, 'access must be view, edit or manage');
      res.json(handoff.issueSession(actor.trim(), Date.now(), level));
    });

    // The browser lands here from an iframe `src`. Deliberately NOT under
    // /api: it is a navigation, and it must stay outside the session gate
    // below — it is how a session is obtained in the first place.
    app.get('/session/handoff', (req, res) => {
      const result = handoff.redeem(req.query.ticket);
      if (!result.ok) {
        // One status for all three verdicts. Which of "never issued",
        // "already used" and "expired" a ticket hit is not something an
        // unauthenticated caller gets to probe for.
        res.status(401).type('text/plain').send('Handoff ticket is not valid');
        return;
      }
      res.setHeader('Set-Cookie', result.cookie);
      res.redirect(302, result.location);
    });
  }

  // ── Everything below requires a valid session ────────────────────────
  app.use('/api', requireAuth(auth));

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  app.get('/api/me', (_req, res) => {
    res.json({ username: actorOf(res, auth), access: accessOf(res) });
  });

  // ── Orders ───────────────────────────────────────────────────────────
  // Nothing here checks a level: `requireAuth` above already held the request
  // against server/access.ts. A route only reads `actorOf` to say who did it.
  app.get('/api/orders', (req, res) => {
    const status = typeof req.query.status === 'string' && (ORDER_STATUSES as readonly string[]).includes(req.query.status)
      ? (req.query.status as OrderStatus)
      : undefined;
    res.json({ orders: listOrders(db, { status, search: typeof req.query.search === 'string' ? req.query.search : undefined }) });
  });

  app.post('/api/orders', (req, res) => {
    const actor = actorOf(res, auth);
    const id = createOrder(db, validateOrder(body(req), today()), actor);
    const order = orderDetail(db, id);
    void platform.audit({ actor, action: 'order.confirmed', resource: `order:${order.number}`, after: order.totals });
    res.status(201).json(order);
  });

  // Confirm an accepted MOD-13 offer as an order. Idempotent on the offer.
  app.post('/api/orders/import-offer', async (req, res) => {
    const number = body(req).offer_number;
    if (typeof number !== 'string' || number.trim() === '') fail([{ field: 'offer_number', message: 'offer_number is required' }]);
    let transfer: unknown;
    try {
      transfer = await platform.fetchOffer((number as string).trim());
    } catch (err) {
      if (err instanceof OfferFetchError) throw new DomainError(err.status === 404 ? 404 : err.status === 409 ? 409 : 502, err.message);
      throw err;
    }
    if (transfer === null) throw new DomainError(501, 'No offer source is configured — set OFFERS_URL to confirm offers from MOD-13');
    const actor = actorOf(res, auth);
    const result = importOffer(db, transfer, actor, today());
    const order = orderDetail(db, result.orderId);
    if (!result.replayed) {
      void platform.audit({ actor, action: 'order.confirmed', resource: `order:${order.number}`, metadata: { from: order.source_reference } });
    }
    res.status(result.replayed ? 200 : 201).json({ ...order, imported: !result.replayed });
  });

  app.get('/api/orders/:id', (req, res) => {
    res.json(orderDetail(db, idParam(req)));
  });

  app.get('/api/orders/:id/pdf', (req, res) => {
    const order = orderDetail(db, idParam(req));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${order.number}.pdf"`);
    res.send(renderOrderPdf(order, effectiveSeller(db, seller).seller));
  });

  app.post('/api/orders/:id/cancel', (req, res) => {
    const id = idParam(req);
    const errors: FieldError[] = [];
    const reason = optText(body(req).reason, 'reason', errors, 300);
    if (!reason) errors.push({ field: 'reason', message: 'A cancellation names its reason' });
    if (errors.length > 0) fail(errors);
    const actor = actorOf(res, auth);
    cancelOrder(db, id, reason!, actor);
    const order = orderDetail(db, id);
    void platform.audit({ actor, action: 'order.cancelled', resource: `order:${order.number}`, metadata: { reason } });
    res.json(order);
  });

  // ── Delivery notes ───────────────────────────────────────────────────
  app.post('/api/orders/:id/delivery-notes', async (req, res) => {
    const id = idParam(req);
    const input = body(req);
    const errors: FieldError[] = [];
    const deliveredOn = optDate(input.delivered_on, 'delivered_on', errors);
    const note = optText(input.note, 'note', errors, 500);
    const raw = Array.isArray(input.lines) ? (input.lines as Record<string, unknown>[]) : [];
    const lines = raw.map((line, i) => {
      const orderLineId = Number(line.order_line_id);
      if (!Number.isInteger(orderLineId) || orderLineId <= 0) errors.push({ field: `lines[${i}].order_line_id`, message: 'order_line_id must be a line of this order' });
      return { orderLineId, quantity: quantity(line.quantity, `lines[${i}].quantity`, errors) };
    });
    if (errors.length > 0) fail(errors);
    const actor = actorOf(res, auth);
    const delivery = createDeliveryNote(db, id, { deliveredOn, note, lines }, actor, today());
    void platform.audit({ actor, action: 'order.delivered', resource: `order:${delivery.order_number}`, metadata: { delivery_note: delivery.number } });
    // The delivery note stands whatever MOD-03 answers; the outcome is on it.
    res.status(201).json(await bookStock(db, platform, delivery.id, actor));
  });

  // Book (again) what failed or was not booked yet — e.g. after stock arrived
  // in MOD-03 or an article number was added.
  app.post('/api/delivery-notes/:id/book-stock', async (req, res) => {
    const id = idParam(req, 'Delivery note');
    getDeliveryNote(db, id);
    if (!platform.inventoryConfigured) throw new DomainError(501, 'No inventory is configured — set INVENTORY_URL to book stock in MOD-03');
    res.json(await bookStock(db, platform, id, actorOf(res, auth), { force: true }));
  });

  // The article number of an order line, for the stock it issues.
  app.put('/api/orders/:id/lines/:lineId/sku', (req, res) => {
    const id = idParam(req);
    const errors: FieldError[] = [];
    const sku = optText(body(req).sku, 'sku', errors, 60);
    if (errors.length > 0) fail(errors);
    setLineSku(db, id, Number(req.params.lineId), sku, actorOf(res, auth));
    res.json(orderDetail(db, id));
  });

  // ── Settings (server/settings.ts) ────────────────────────────────────
  // Anyone may read them; changing them is the admin's (server/access.ts).
  const settingsResponse = async () => {
    const { seller: effective, source } = effectiveSeller(db, seller);
    let warehouses: { code: string; name: string }[] | null = null;
    let error: string | null = null;
    if (platform.inventoryConfigured) {
      try {
        warehouses = await platform.inventoryWarehouses();
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      settings: readSettings(db),
      seller: { name: effective.name, address_lines: effective.addressLines, vat_id: effective.vatId },
      seller_source: source,
      inventory: { configured: platform.inventoryConfigured, warehouses, error },
      ...settingsStamp(db),
    };
  };

  app.get('/api/settings', async (_req, res) => {
    res.json(await settingsResponse());
  });

  app.put('/api/settings', async (req, res) => {
    const next = validateSettings(body(req));
    // A warehouse MOD-03 does not have would fail every booking; refuse it
    // now. When MOD-03 cannot be asked, saying so beats saving blind.
    if (next.stock_warehouse !== null && platform.inventoryConfigured) {
      let codes: string[];
      try {
        codes = (await platform.inventoryWarehouses()).map((w) => w.code);
      } catch (err) {
        throw new DomainError(502, `The warehouse cannot be checked: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!codes.includes(next.stock_warehouse)) {
        fail([{ field: 'stock_warehouse', message: `MOD-03 has no warehouse ${next.stock_warehouse} — one of: ${codes.join(', ')}` }]);
      }
    }
    const actor = actorOf(res, auth);
    const changed = writeSettings(db, next, actor);
    if (changed.length > 0) void platform.audit({ actor, action: 'settings.changed', resource: 'settings', metadata: { fields: changed } });
    res.json(await settingsResponse());
  });

  app.get('/api/delivery-notes/:id/pdf', (req, res) => {
    const note = getDeliveryNote(db, idParam(req, 'Delivery note'));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${note.number}.pdf"`);
    res.send(renderDeliveryNotePdf(note, orderDetail(db, note.order_id), effectiveSeller(db, seller).seller));
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
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
