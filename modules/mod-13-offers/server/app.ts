import express, { type NextFunction, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { VAT_RATES } from '../shared/money.js';
import {
  STATUSES,
  type DashboardStats,
  type FieldError,
  type OfferStatus,
  type PublicOffer,
} from '../shared/types.js';
import {
  checkCredentials,
  clearedCookie,
  createToken,
  requireAuth,
  sessionCookie,
  type AuthConfig,
} from './auth.js';
import type { SellerConfig } from './config.js';
import { offersCsv } from './csv.js';
import { noopPlatform, type PlatformHooks } from './platform.js';
import { nullVerifier, type LoginVerifier } from './sso.js';
import {
  createDraft,
  decideOffer,
  deleteDraft,
  DomainError,
  finalizeOffer,
  getCustomer,
  listOffers,
  nowIso,
  offerDetail,
  reviseOffer,
  todayIso,
  updateDraft,
  withdrawOffer,
  type LineInput,
  type OfferInput,
} from './offers.js';
import { renderOfferPdf } from './pdf.js';
import { verifyOfferToken } from './tokens.js';

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
  const num = Number(raw);
  if (!Number.isInteger(num) || num <= 0) errors.push({ field, message: `${field} must be a positive integer id` });
  return num;
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function optDate(raw: unknown, field: string, errors: FieldError[]): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !DATE_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    errors.push({ field, message: `${field} must be a date in YYYY-MM-DD format` });
    return null;
  }
  return raw;
}

interface CustomerInput {
  name: string;
  contact_person: string | null;
  email: string | null;
  vat_id: string | null;
  address: string | null;
}

function validateCustomer(input: Record<string, unknown>): CustomerInput {
  const errors: FieldError[] = [];
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '' || name.length > 160) errors.push({ field: 'name', message: 'Name is required (max 160 characters)' });
  const contact_person = optText(input.contact_person, 'contact_person', errors, 120);
  const email = optText(input.email, 'email', errors, 160);
  if (email !== null && !/^\S+@\S+\.\S+$/.test(email)) {
    errors.push({ field: 'email', message: 'Email must look like an email address' });
  }
  const vat_id = optText(input.vat_id, 'vat_id', errors, 32);
  const address = optText(input.address, 'address', errors, 400);
  if (errors.length > 0) fail(errors);
  return { name, contact_person, email, vat_id, address };
}

function validateOffer(input: Record<string, unknown>): OfferInput {
  const errors: FieldError[] = [];
  const customerId = id(input.customer_id, 'customer_id', errors);
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title === '' || title.length > 160) errors.push({ field: 'title', message: 'Title is required (max 160 characters)' });
  const validUntil = optDate(input.valid_until, 'valid_until', errors);
  const intro = optText(input.intro, 'intro', errors, 1000);
  const terms = optText(input.terms, 'terms', errors, 1000);

  const rawLines = Array.isArray(input.lines) ? (input.lines as Record<string, unknown>[]) : [];
  if (rawLines.length === 0) errors.push({ field: 'lines', message: 'At least one line item is required' });
  const lines: LineInput[] = rawLines.map((line, i) => {
    const description = typeof line.description === 'string' ? line.description.trim() : '';
    if (description === '' || description.length > 200) {
      errors.push({ field: `lines[${i}].description`, message: 'Description is required (max 200 characters)' });
    }
    const quantity = Number(line.quantity);
    if (typeof line.quantity === 'boolean' || line.quantity === '' || line.quantity === null || line.quantity === undefined ||
        Number.isNaN(quantity) || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
      errors.push({ field: `lines[${i}].quantity`, message: 'Quantity must be a number greater than zero' });
    }
    const unitPriceCents = Number(line.unit_price_cents);
    if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0 || unitPriceCents > 100_000_000) {
      errors.push({ field: `lines[${i}].unit_price_cents`, message: 'Unit price must be a non-negative integer amount in cents' });
    }
    const vatRate = Number(line.vat_rate);
    if (!(VAT_RATES as readonly number[]).includes(vatRate)) {
      errors.push({ field: `lines[${i}].vat_rate`, message: `VAT rate must be one of: ${VAT_RATES.join(', ')}` });
    }
    let discountPercent = 0;
    if (line.discount_percent !== undefined && line.discount_percent !== null && line.discount_percent !== '') {
      discountPercent = Number(line.discount_percent);
      if (Number.isNaN(discountPercent) || !Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
        errors.push({ field: `lines[${i}].discount_percent`, message: 'Discount must be a percentage between 0 and 100' });
      }
    }
    return { description, quantity, unitPriceCents, vatRate, discountPercent };
  });
  if (errors.length > 0) fail(errors);
  return { customerId, title, validUntil, intro, terms, lines };
}

export interface AppOptions {
  db: Database.Database;
  auth: AuthConfig;
  seller: SellerConfig;
  publicBaseUrl?: string;
  /** Injectable clock returning today's date "YYYY-MM-DD". Defaults to the real UTC date. */
  clock?: () => string;
  /** Absolute path to the built client (dist/client). Omit to serve API only. */
  staticDir?: string;
  /** Optional Platform Services integration; defaults to a no-op (standalone). */
  platform?: PlatformHooks;
  verifyLogin?: LoginVerifier;
}

export function createApp({ db, auth, seller, publicBaseUrl, clock, staticDir, platform = noopPlatform, verifyLogin = nullVerifier }: AppOptions): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const today = (): string => (clock ? clock() : todayIso());
  // Timestamp for audit events. With an injected clock we anchor events to
  // noon of the clock date so the whole timeline stays coherent with the
  // (clock-dated) sent_at; in production it is the real wall-clock time.
  const stamp = (): string => (clock ? `${clock()}T12:00:00Z` : nowIso());
  const detailCtx = () => ({ today: today(), secret: auth.secret, publicBaseUrl });

  function offerByRef(ref: string): number {
    const row = db.prepare('SELECT id FROM offers WHERE number = ?').get(ref) as { id: number } | undefined;
    if (!row) throw new DomainError(404, 'Offer not found');
    return row.id;
  }

  // ── Public routes ────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/login', async (req, res) => {
    const { username, password } = body(req);
    // SSO seam: when IDENTITY_URL is set, PS-01 validates the credentials;
    // otherwise the local admin credentials do. Either way the module mints
    // its own session below, so the rest of the request path is unchanged.
    const viaSso = await verifyLogin(username, password);
    const authed = viaSso === null ? checkCredentials(auth, username, password) : viaSso === 'ok';
    if (!authed) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    res.setHeader('Set-Cookie', sessionCookie(auth, createToken(auth)));
    res.json({ ok: true, username: auth.username });
  });

  // ── Public acceptance link (no login) ────────────────────────────────
  function publicOffer(ref: string, token: unknown): PublicOffer {
    // Wrong/missing token → the same 404 as an unknown ref, so refs leak nothing.
    if (!verifyOfferToken(auth.secret, ref, token)) throw new DomainError(404, 'Offer not found');
    const detail = offerDetail(db, offerByRef(ref), { today: today() });
    return {
      number: detail.number!,
      title: detail.title,
      status: detail.status,
      expired: detail.expired,
      valid_until: detail.valid_until!,
      intro: detail.intro,
      terms: detail.terms,
      seller_name: seller.name,
      customer_name: detail.customer_name,
      net_cents: detail.net_cents,
      vat_cents: detail.vat_cents,
      gross_cents: detail.gross_cents,
      discount_cents: detail.discount_cents,
      lines: detail.lines,
      vat_breakdown: detail.vat_breakdown,
      decidable: detail.status === 'sent',
    };
  }

  app.get('/api/public/offers/:ref', (req, res) => {
    res.json(publicOffer(req.params.ref, req.query.token));
  });

  app.post('/api/public/offers/:ref/accept', (req, res) => {
    const ref = req.params.ref;
    const token = req.query.token ?? body(req).token;
    if (!verifyOfferToken(auth.secret, ref, token)) throw new DomainError(404, 'Offer not found');
    const errors: FieldError[] = [];
    const note = optText(body(req).note, 'note', errors, 300);
    if (errors.length > 0) fail(errors);
    decideOffer(db, offerByRef(ref), 'accepted', { actor: 'customer', note, today: today(), at: stamp() });
    res.json(publicOffer(ref, token));
  });

  app.post('/api/public/offers/:ref/reject', (req, res) => {
    const ref = req.params.ref;
    const token = req.query.token ?? body(req).token;
    if (!verifyOfferToken(auth.secret, ref, token)) throw new DomainError(404, 'Offer not found');
    const errors: FieldError[] = [];
    const note = optText(body(req).note, 'note', errors, 300);
    if (errors.length > 0) fail(errors);
    decideOffer(db, offerByRef(ref), 'rejected', { actor: 'customer', note, today: today(), at: stamp() });
    res.json(publicOffer(ref, token));
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

  // ── Dashboard ────────────────────────────────────────────────────────
  app.get('/api/stats', (req, res) => {
    const period = Number(req.query.period) || Number(today().slice(0, 4));
    const rows = listOffers(db, {}, today()).filter((r) => {
      const year = Number((r.sent_at ?? r.created_at).slice(0, 4));
      return year === period;
    });
    const sum = (pred: (s: OfferStatus) => boolean) =>
      rows.filter((r) => pred(r.status)).reduce((acc, r) => acc + r.gross_cents, 0);
    const count = (pred: (s: OfferStatus) => boolean) => rows.filter((r) => pred(r.status)).length;
    const acceptedCount = count((s) => s === 'accepted');
    const rejectedCount = count((s) => s === 'rejected');
    const decided = acceptedCount + rejectedCount;
    const stats: DashboardStats = {
      period,
      open_count: count((s) => s === 'sent'),
      open_value_cents: sum((s) => s === 'sent'),
      expired_count: count((s) => s === 'expired'),
      expired_value_cents: sum((s) => s === 'expired'),
      accepted_count: acceptedCount,
      accepted_value_cents: sum((s) => s === 'accepted'),
      rejected_count: rejectedCount,
      rejected_value_cents: sum((s) => s === 'rejected'),
      win_rate_pct: decided === 0 ? 0 : Math.round((acceptedCount / decided) * 100),
    };
    res.json(stats);
  });

  // ── Customers ────────────────────────────────────────────────────────
  app.get('/api/customers', (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const includeArchived = req.query.archived === '1' || req.query.archived === 'true';
    const customers = db
      .prepare(
        `SELECT c.*, COUNT(o.id) AS offer_count
         FROM customers c LEFT JOIN offers o ON o.customer_id = c.id
         WHERE 1 = 1
         ${includeArchived ? '' : 'AND c.archived_at IS NULL'}
         ${search ? 'AND (c.name LIKE @s OR c.email LIKE @s OR c.vat_id LIKE @s OR c.contact_person LIKE @s)' : ''}
         GROUP BY c.id ORDER BY c.archived_at IS NOT NULL, c.name`,
      )
      .all(search ? { s: `%${search}%` } : {});
    res.json({ customers });
  });

  app.post('/api/customers', (req, res) => {
    const values = validateCustomer(body(req));
    const info = db
      .prepare(
        'INSERT INTO customers (name, contact_person, email, vat_id, address, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(values.name, values.contact_person, values.email, values.vat_id, values.address, nowIso());
    res.status(201).json(db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid));
  });

  app.get('/api/customers/:id', (req, res) => {
    res.json(getCustomer(db, Number(req.params.id)));
  });

  app.put('/api/customers/:id', (req, res) => {
    getCustomer(db, Number(req.params.id));
    const values = validateCustomer(body(req));
    db.prepare(
      'UPDATE customers SET name = ?, contact_person = ?, email = ?, vat_id = ?, address = ? WHERE id = ?',
    ).run(values.name, values.contact_person, values.email, values.vat_id, values.address, req.params.id);
    res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id));
  });

  app.delete('/api/customers/:id', (req, res) => {
    getCustomer(db, Number(req.params.id));
    const used = db
      .prepare('SELECT COUNT(*) AS n FROM offers WHERE customer_id = ?')
      .get(req.params.id) as { n: number };
    if (used.n > 0) {
      throw new DomainError(409, 'Customer has offers and cannot be deleted — archive it instead');
    }
    db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/customers/:id/archive', (req, res) => {
    getCustomer(db, Number(req.params.id));
    db.prepare('UPDATE customers SET archived_at = ? WHERE id = ?').run(nowIso(), req.params.id);
    res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id));
  });

  app.post('/api/customers/:id/unarchive', (req, res) => {
    getCustomer(db, Number(req.params.id));
    db.prepare('UPDATE customers SET archived_at = NULL WHERE id = ?').run(req.params.id);
    res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id));
  });

  // ── Offers ───────────────────────────────────────────────────────────
  app.get('/api/offers', (req, res) => {
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (rawStatus && !(STATUSES as readonly string[]).includes(rawStatus)) {
      fail([{ field: 'status', message: `status must be one of: ${STATUSES.join(', ')}` }]);
    }
    res.json({
      offers: listOffers(
        db,
        {
          search: typeof req.query.search === 'string' ? req.query.search : undefined,
          status: rawStatus as OfferStatus | undefined,
        },
        today(),
      ),
      today: today(),
    });
  });

  app.get('/api/offers/export.csv', (req, res) => {
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
    const rows = listOffers(
      db,
      {
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        status: (rawStatus && (STATUSES as readonly string[]).includes(rawStatus) ? rawStatus : undefined) as
          | OfferStatus
          | undefined,
      },
      today(),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="offers.csv"');
    res.send(offersCsv(rows));
  });

  app.post('/api/offers', (req, res) => {
    const offerId = createDraft(db, { ...validateOffer(body(req)), createdAt: stamp() });
    res.status(201).json(offerDetail(db, offerId, detailCtx()));
  });

  app.get('/api/offers/:id', (req, res) => {
    res.json(offerDetail(db, Number(req.params.id), detailCtx()));
  });

  app.put('/api/offers/:id', (req, res) => {
    updateDraft(db, Number(req.params.id), validateOffer(body(req)));
    res.json(offerDetail(db, Number(req.params.id), detailCtx()));
  });

  app.delete('/api/offers/:id', (req, res) => {
    deleteDraft(db, Number(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/offers/:id/send', (req, res) => {
    finalizeOffer(db, Number(req.params.id), { sentDate: today(), at: stamp() });
    const sent = offerDetail(db, Number(req.params.id), detailCtx());
    const cust = db.prepare('SELECT c.email AS email FROM offers o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?').get(Number(req.params.id)) as { email: string | null } | undefined;
    void platform.audit({ actor: auth.username, action: 'offer.sent', resource: `offer:${req.params.id}` });
    void platform.notify({
      to: cust?.email ?? '',
      subject: `Your offer ${sent.number}`,
      body: `Dear ${sent.customer_name},\n\nplease review and accept your offer ${sent.number}: ${publicBaseUrl ?? ''}${sent.public_path ?? ''}`,
    });
    res.json(sent);
  });

  app.post('/api/offers/:id/withdraw', (req, res) => {
    const errors: FieldError[] = [];
    const reason = optText(body(req).reason, 'reason', errors, 300);
    if (errors.length > 0) fail(errors);
    withdrawOffer(db, Number(req.params.id), reason, { today: today(), at: stamp() });
    res.json(offerDetail(db, Number(req.params.id), detailCtx()));
  });

  app.post('/api/offers/:id/accept', (req, res) => {
    const errors: FieldError[] = [];
    const note = optText(body(req).note, 'note', errors, 300);
    if (errors.length > 0) fail(errors);
    decideOffer(db, Number(req.params.id), 'accepted', { actor: 'admin', note, today: today(), at: stamp() });
    res.json(offerDetail(db, Number(req.params.id), detailCtx()));
  });

  app.post('/api/offers/:id/reject', (req, res) => {
    const errors: FieldError[] = [];
    const note = optText(body(req).note, 'note', errors, 300);
    if (errors.length > 0) fail(errors);
    decideOffer(db, Number(req.params.id), 'rejected', { actor: 'admin', note, today: today(), at: stamp() });
    res.json(offerDetail(db, Number(req.params.id), detailCtx()));
  });

  app.post('/api/offers/:id/revise', (req, res) => {
    const newId = reviseOffer(db, Number(req.params.id), { at: stamp() });
    res.status(201).json(offerDetail(db, newId, detailCtx()));
  });

  app.get('/api/offers/:id/pdf', (req, res) => {
    const offer = offerDetail(db, Number(req.params.id), detailCtx());
    const customer = getCustomer(db, offer.customer_id);
    const pdf = renderOfferPdf(offer, customer, seller);
    const filename = `${offer.number ?? `draft-${offer.id}`}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(pdf);
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
