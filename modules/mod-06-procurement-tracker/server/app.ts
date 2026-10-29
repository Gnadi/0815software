import express, { type NextFunction, type Request, type Response } from 'express';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import type Database from 'better-sqlite3';
import { PO_STATUSES, RFQ_STATUSES, type FieldError, type InvoicedLine, type PoStatus, type RfqStatus } from '../shared/types.js';
import { APPROVAL_RULES, APPROVAL_TIERS } from './approval-config.js';
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
import { exportOrderedPos } from './csv.js';
import { EXPORT_PROFILES, getProfile } from './export-profiles.js';
import { noopPlatform, PeerError, type PlatformHooks } from './platform.js';
import {
  getReceipt,
  matchSettingsStamp,
  matchVerdict,
  readMatchSettings,
  receiveGoods,
  recordStockOutcome,
  validateMatchSettings,
  writeMatchSettings,
} from './receiving.js';
import { LOCAL_LOGIN, nullVerifier, type LoginMode, type LoginVerifier } from './sso.js';
import {
  approvePo,
  closePo,
  createPo,
  deletePo,
  DomainError,
  getSupplier,
  listPos,
  markOrdered,
  nowIso,
  poDetail,
  rejectPo,
  returnToDraft,
  setLineSku,
  submitPo,
  updatePo,
  type PoInput,
  type PoLineInput,
} from './purchase-orders.js';
import {
  awardRfq,
  closeRfq,
  createRfq,
  deleteRfq,
  inviteSupplier,
  listRfqs,
  rfqDetail,
  updateRfq,
  upsertQuote,
  type RfqInput,
  type RfqLineInput,
} from './rfqs.js';
import { likeTerm } from './purchase-orders.js';

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

function quantity(raw: unknown, field: string, errors: FieldError[]): number {
  const n = Number(raw);
  if (typeof raw === 'boolean' || raw === '' || raw === null || raw === undefined ||
      Number.isNaN(n) || !Number.isFinite(n) || n <= 0 || n > 1_000_000) {
    errors.push({ field, message: 'Quantity must be a number greater than zero' });
  }
  return n;
}

function priceCents(raw: unknown, field: string, errors: FieldError[]): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000_000) {
    errors.push({ field, message: 'Price must be a non-negative integer amount in cents' });
  }
  return n;
}

function description(raw: unknown, field: string, errors: FieldError[]): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '' || text.length > 200) {
    errors.push({ field, message: 'Description is required (max 200 characters)' });
  }
  return text;
}

function unit(raw: unknown, field: string, errors: FieldError[]): string {
  if (raw === undefined || raw === null || raw === '') return 'pc';
  if (typeof raw !== 'string' || raw.length > 20) {
    errors.push({ field, message: 'Unit must be a string of at most 20 characters' });
    return 'pc';
  }
  return raw;
}

interface SupplierInput {
  name: string;
  contact: string | null;
  email: string | null;
  notes: string | null;
}

function validateSupplier(input: Record<string, unknown>): SupplierInput {
  const errors: FieldError[] = [];
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '' || name.length > 160) errors.push({ field: 'name', message: 'Name is required (max 160 characters)' });
  const contact = optText(input.contact, 'contact', errors, 160);
  const email = optText(input.email, 'email', errors, 160);
  if (email !== null && !/^\S+@\S+\.\S+$/.test(email)) {
    errors.push({ field: 'email', message: 'Email must look like an email address' });
  }
  const notes = optText(input.notes, 'notes', errors, 500);
  if (errors.length > 0) fail(errors);
  return { name, contact, email, notes };
}

function validateRfq(input: Record<string, unknown>): RfqInput {
  const errors: FieldError[] = [];
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title === '' || title.length > 160) errors.push({ field: 'title', message: 'Title is required (max 160 characters)' });
  const dueDate = optDate(input.due_date, 'due_date', errors);
  const note = optText(input.note, 'note', errors, 500);
  const rawLines = Array.isArray(input.lines) ? (input.lines as Record<string, unknown>[]) : [];
  if (rawLines.length === 0) errors.push({ field: 'lines', message: 'At least one line is required' });
  const lines: RfqLineInput[] = rawLines.map((line, i) => ({
    description: description(line.description, `lines[${i}].description`, errors),
    quantity: quantity(line.quantity, `lines[${i}].quantity`, errors),
    unit: unit(line.unit, `lines[${i}].unit`, errors),
  }));
  if (errors.length > 0) fail(errors);
  return { title, dueDate, note, lines };
}

function validatePo(input: Record<string, unknown>): PoInput {
  const errors: FieldError[] = [];
  const supplierId = id(input.supplier_id, 'supplier_id', errors);
  const note = optText(input.note, 'note', errors, 500);
  const rawLines = Array.isArray(input.lines) ? (input.lines as Record<string, unknown>[]) : [];
  if (rawLines.length === 0) errors.push({ field: 'lines', message: 'At least one line is required' });
  const lines: PoLineInput[] = rawLines.map((line, i) => ({
    description: description(line.description, `lines[${i}].description`, errors),
    quantity: quantity(line.quantity, `lines[${i}].quantity`, errors),
    unit: unit(line.unit, `lines[${i}].unit`, errors),
    unitPriceCents: priceCents(line.unit_price_cents, `lines[${i}].unit_price_cents`, errors),
    sku: optText(line.sku, `lines[${i}].sku`, errors, 60),
  }));
  if (errors.length > 0) fail(errors);
  return { supplierId, note, lines };
}

function validateDecision(input: Record<string, unknown>): { tier: number; approver: string; note: string | null } {
  const errors: FieldError[] = [];
  const tier = Number(input.tier);
  if (!Number.isInteger(tier) || tier <= 0) errors.push({ field: 'tier', message: 'tier must be a positive integer' });
  const approver = typeof input.approver === 'string' ? input.approver.trim() : '';
  if (approver === '' || approver.length > 120) {
    errors.push({ field: 'approver', message: 'Approver name is required (max 120 characters)' });
  }
  const note = optText(input.note, 'note', errors, 300);
  if (errors.length > 0) fail(errors);
  return { tier, approver, note };
}

export interface AppOptions {
  /** Optional transport hardening; omit it (as the tests do) to run unthrottled. */
  hardening?: HardeningConfig;
  db: Database.Database;
  auth: AuthConfig;
  /** Absolute path to the built client (dist/client). Omit to serve API only. */
  staticDir?: string;
  /** Optional Platform Services integration; defaults to a no-op (standalone). */
  platform?: PlatformHooks;
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

export function createApp({ db, hardening, auth, staticDir, platform = noopPlatform, verifyLogin = nullVerifier, loginMode = LOCAL_LOGIN, serviceToken, shellOrigins = [] }: AppOptions): express.Express {
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
  // The three-way match, for the module that pays the invoice (MOD-04): the
  // net amount invoiced against a PO so far → may it be paid? A machine call.
  app.post('/api/match', (req, res) => {
    requireServiceToken(req);
    const input = body(req);
    const errors: FieldError[] = [];
    const poNumber = typeof input.po_number === 'string' ? input.po_number.trim() : '';
    if (poNumber === '' || poNumber.length > 40) errors.push({ field: 'po_number', message: 'po_number is required' });
    const invoiced = Number(input.invoiced_net_cents);
    if (!Number.isInteger(invoiced) || invoiced < 0) errors.push({ field: 'invoiced_net_cents', message: 'invoiced_net_cents is whole cents, 0 or more' });
    // Optional: the invoice's lines, so far — matched line by line (server/receiving.ts).
    const lines: InvoicedLine[] = [];
    if (input.lines !== undefined) {
      if (!Array.isArray(input.lines) || input.lines.length > 1000) errors.push({ field: 'lines', message: 'lines is a list of at most 1000' });
      else
        input.lines.forEach((raw: unknown, i: number) => {
          const l = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
          const description = typeof l.description === 'string' ? l.description.trim().slice(0, 300) : '';
          const itemId = typeof l.item_id === 'string' && l.item_id.trim() !== '' ? l.item_id.trim().slice(0, 64) : null;
          const quantity = l.quantity === null || l.quantity === undefined ? null : Number(l.quantity);
          const net = Number(l.net_cents);
          if (description === '' && itemId === null) errors.push({ field: `lines[${i}]`, message: 'A line has a description or an article number' });
          if (quantity !== null && !Number.isFinite(quantity)) errors.push({ field: `lines[${i}].quantity`, message: 'quantity is a number' });
          if (!Number.isInteger(net)) errors.push({ field: `lines[${i}].net_cents`, message: 'net_cents is whole cents' });
          lines.push({ item_id: itemId, description, quantity, net_cents: net });
        });
    }
    if (errors.length > 0) fail(errors);
    res.json(matchVerdict(db, poNumber, invoiced, lines));
  });

  app.use('/api', requireAuth(auth));

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  app.get('/api/me', (_req, res) => {
    res.json({ username: actorOf(res, auth), access: accessOf(res) });
  });

  // ── Config: the ONE source the UI renders rules/profiles from ────────
  app.get('/api/config', (_req, res) => {
    res.json({
      tiers: APPROVAL_TIERS.map((t) => ({ tier: t.tier, label: t.label })),
      rules: APPROVAL_RULES.map((r) => ({ max_total_cents: r.maxTotalCents, tiers: r.tiers })),
      profiles: EXPORT_PROFILES.map((p) => ({
        name: p.name,
        description: p.description,
        delimiter: p.delimiter,
        columns: p.columns.map((c) => ({ header: c.header, field: c.field, money: c.money, date: c.date })),
      })),
    });
  });

  // ── Suppliers ────────────────────────────────────────────────────────
  app.get('/api/suppliers', (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const suppliers = db
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM rfq_invitations i WHERE i.supplier_id = s.id) AS rfq_count,
                (SELECT COUNT(*) FROM purchase_orders p WHERE p.supplier_id = s.id) AS po_count
         FROM suppliers s
         ${search ? 'WHERE s.name LIKE @s ESCAPE \'\\\' OR s.email LIKE @s ESCAPE \'\\\' OR s.contact LIKE @s ESCAPE \'\\\'' : ''}
         ORDER BY s.name`,
      )
      .all(search ? { s: likeTerm(search) } : {});
    res.json({ suppliers });
  });

  app.post('/api/suppliers', (req, res) => {
    const values = validateSupplier(body(req));
    const info = db
      .prepare('INSERT INTO suppliers (name, contact, email, notes, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(values.name, values.contact, values.email, values.notes, nowIso());
    const localId = Number(info.lastInsertRowid);
    // Register the supplier with PS-11 as a `supplier` party, so the stack has
    // one answer for who this vendor is. Best-effort: the local row is already
    // written, and the party id is stored when the answer arrives.
    void platform
      .resolveParty({ name: values.name, contactPerson: values.contact, email: values.email, localId })
      .then((partyId) => {
        if (partyId !== null) db.prepare('UPDATE suppliers SET party_id = ? WHERE id = ?').run(partyId, localId);
      })
      .catch(() => {
        /* buildPlatform already logs; the local row stands either way */
      });
    res.status(201).json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(localId));
  });

  app.get('/api/suppliers/:id', (req, res) => {
    res.json(getSupplier(db, Number(req.params.id)));
  });

  app.put('/api/suppliers/:id', (req, res) => {
    getSupplier(db, Number(req.params.id));
    const values = validateSupplier(body(req));
    db.prepare('UPDATE suppliers SET name = ?, contact = ?, email = ?, notes = ? WHERE id = ?').run(
      values.name,
      values.contact,
      values.email,
      values.notes,
      req.params.id,
    );
    res.json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id));
  });

  app.delete('/api/suppliers/:id', (req, res) => {
    getSupplier(db, Number(req.params.id));
    const used = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM rfq_invitations WHERE supplier_id = @id)
              + (SELECT COUNT(*) FROM purchase_orders WHERE supplier_id = @id) AS n`,
      )
      .get({ id: Number(req.params.id) }) as { n: number };
    if (used.n > 0) {
      throw new DomainError(409, 'Supplier is referenced by RFQs or purchase orders and cannot be deleted');
    }
    db.prepare('DELETE FROM suppliers WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ── RFQs ─────────────────────────────────────────────────────────────
  app.get('/api/rfqs', (req, res) => {
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (rawStatus && !(RFQ_STATUSES as readonly string[]).includes(rawStatus)) {
      fail([{ field: 'status', message: `status must be one of: ${RFQ_STATUSES.join(', ')}` }]);
    }
    res.json({
      rfqs: listRfqs(db, {
        status: rawStatus as RfqStatus | undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
      }),
    });
  });

  app.post('/api/rfqs', (req, res) => {
    const rfqId = createRfq(db, validateRfq(body(req)));
    res.status(201).json(rfqDetail(db, rfqId));
  });

  app.get('/api/rfqs/:id', (req, res) => {
    res.json(rfqDetail(db, Number(req.params.id)));
  });

  app.put('/api/rfqs/:id', (req, res) => {
    updateRfq(db, Number(req.params.id), validateRfq(body(req)));
    res.json(rfqDetail(db, Number(req.params.id)));
  });

  app.delete('/api/rfqs/:id', (req, res) => {
    deleteRfq(db, Number(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/rfqs/:id/invitations', (req, res) => {
    const errors: FieldError[] = [];
    const supplierId = id(body(req).supplier_id, 'supplier_id', errors);
    if (errors.length > 0) fail(errors);
    inviteSupplier(db, Number(req.params.id), supplierId);
    res.status(201).json(rfqDetail(db, Number(req.params.id)));
  });

  app.put('/api/rfqs/:id/quotes/:supplierId', (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const validUntil = optDate(input.valid_until, 'valid_until', errors);
    const note = optText(input.note, 'note', errors, 300);
    const rawPrices = Array.isArray(input.prices) ? (input.prices as Record<string, unknown>[]) : [];
    if (rawPrices.length === 0) errors.push({ field: 'prices', message: 'prices is required' });
    const prices = rawPrices.map((price, i) => ({
      rfqLineId: id(price.rfq_line_id, `prices[${i}].rfq_line_id`, errors),
      unitPriceCents: priceCents(price.unit_price_cents, `prices[${i}].unit_price_cents`, errors),
    }));
    if (errors.length > 0) fail(errors);
    upsertQuote(db, Number(req.params.id), Number(req.params.supplierId), { validUntil, note, prices });
    res.json(rfqDetail(db, Number(req.params.id)));
  });

  app.post('/api/rfqs/:id/award', (req, res) => {
    const errors: FieldError[] = [];
    const supplierId = id(body(req).supplier_id, 'supplier_id', errors);
    if (errors.length > 0) fail(errors);
    const { poId } = awardRfq(db, Number(req.params.id), supplierId);
    res.json({ rfq: rfqDetail(db, Number(req.params.id)), po: poDetail(db, poId) });
  });

  app.post('/api/rfqs/:id/close', (req, res) => {
    closeRfq(db, Number(req.params.id));
    res.json(rfqDetail(db, Number(req.params.id)));
  });

  // ── Purchase orders & approvals ──────────────────────────────────────
  app.get('/api/pos', (req, res) => {
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (rawStatus && !(PO_STATUSES as readonly string[]).includes(rawStatus)) {
      fail([{ field: 'status', message: `status must be one of: ${PO_STATUSES.join(', ')}` }]);
    }
    res.json({
      pos: listPos(db, {
        status: rawStatus as PoStatus | undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
      }),
    });
  });

  app.post('/api/pos', (req, res) => {
    const poId = createPo(db, validatePo(body(req)));
    res.status(201).json(poDetail(db, poId));
  });

  app.get('/api/pos/:id', (req, res) => {
    res.json(poDetail(db, Number(req.params.id)));
  });

  app.put('/api/pos/:id', (req, res) => {
    updatePo(db, Number(req.params.id), validatePo(body(req)));
    res.json(poDetail(db, Number(req.params.id)));
  });

  app.delete('/api/pos/:id', (req, res) => {
    deletePo(db, Number(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/pos/:id/submit', (req, res) => {
    submitPo(db, Number(req.params.id));
    void platform.audit({ actor: actorOf(res, auth), action: 'po.submitted', resource: `po:${req.params.id}` });
    res.json(poDetail(db, Number(req.params.id)));
  });

  app.post('/api/pos/:id/return-to-draft', (req, res) => {
    returnToDraft(db, Number(req.params.id));
    res.json(poDetail(db, Number(req.params.id)));
  });

  app.post('/api/pos/:id/approvals', (req, res) => {
    approvePo(db, Number(req.params.id), validateDecision(body(req)));
    res.status(201).json(poDetail(db, Number(req.params.id)));
  });

  app.post('/api/pos/:id/reject', (req, res) => {
    rejectPo(db, Number(req.params.id), validateDecision(body(req)));
    res.json(poDetail(db, Number(req.params.id)));
  });

  app.post('/api/pos/:id/mark-ordered', (req, res) => {
    markOrdered(db, Number(req.params.id));
    res.json(poDetail(db, Number(req.params.id)));
  });

  app.post('/api/pos/:id/close', (req, res) => {
    closePo(db, Number(req.params.id));
    res.json(poDetail(db, Number(req.params.id)));
  });

  // ── Receiving and the three-way match (server/receiving.ts) ──────────

  /**
   * Book a receipt's article lines into MOD-03, best-effort: whatever MOD-03
   * answers is recorded on the receipt, and a failure is retried from there —
   * the goods have arrived either way.
   */
  async function bookStock(receiptId: number): Promise<void> {
    const receipt = getReceipt(db, receiptId);
    const stockLines = receipt.lines.filter((l) => l.sku).map((l) => ({ sku: l.sku!, quantity: l.quantity }));
    if (!platform.inventoryConfigured || stockLines.length === 0) return;
    const warehouse = readMatchSettings(db).receiving_warehouse;
    if (receipt.kind === 'correction') {
      // MOD-03 counts goods in, never out, from here; a miscount is its stock to correct.
      recordStockOutcome(db, receiptId, 'not_booked', null, 'A correction is not booked — adjust the stock in MOD-03');
      return;
    }
    if (!warehouse) {
      recordStockOutcome(db, receiptId, 'not_booked', null, 'No receiving warehouse is set in Settings');
      return;
    }
    try {
      await platform.receiveGoods({ reference: receipt.number, warehouseCode: warehouse, actor: receipt.actor, lines: stockLines });
      recordStockOutcome(db, receiptId, 'booked', warehouse, null);
    } catch (err) {
      recordStockOutcome(db, receiptId, 'failed', warehouse, err instanceof Error ? err.message : String(err));
    }
  }

  app.post('/api/pos/:id/receipts', async (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const kind = input.kind === undefined ? 'receipt' : input.kind;
    if (kind !== 'receipt' && kind !== 'correction') errors.push({ field: 'kind', message: 'kind is receipt or correction' });
    const receivedOn = optDate(input.received_on, 'received_on', errors) ?? new Date().toISOString().slice(0, 10);
    const note = optText(input.note, 'note', errors, 300);
    const raw = Array.isArray(input.lines) ? (input.lines as Record<string, unknown>[]) : [];
    const lines = raw.map((line, i) => {
      const q = Number(line.quantity);
      if (!Number.isFinite(q) || q === 0 || Math.abs(q) > 1_000_000) errors.push({ field: `lines[${i}].quantity`, message: 'Quantity must be a non-zero number' });
      return { poLineId: id(line.po_line_id, `lines[${i}].po_line_id`, errors), quantity: q };
    });
    if (errors.length > 0) fail(errors);
    const actor = actorOf(res, auth);
    const receipt = receiveGoods(db, Number(req.params.id), { kind: kind as 'receipt' | 'correction', receivedOn, note, lines }, actor);
    await bookStock(receipt.id);
    void platform.audit({ actor, action: `po.${kind}`, resource: `po:${req.params.id}`, metadata: { receipt: receipt.number, lines: receipt.lines } });
    res.status(201).json(poDetail(db, Number(req.params.id)));
  });

  app.post('/api/receipts/:id/book-stock', async (req, res) => {
    const receipt = getReceipt(db, Number(req.params.id));
    if (!platform.inventoryConfigured) throw new DomainError(501, 'No inventory is configured — set INVENTORY_URL to book received goods in MOD-03');
    if (receipt.stock_status === 'booked') throw new DomainError(409, 'This receipt is already booked');
    await bookStock(receipt.id);
    res.json(poDetail(db, receipt.po_id));
  });

  app.put('/api/pos/:id/lines/:lineId/sku', (req, res) => {
    const errors: FieldError[] = [];
    const sku = optText(body(req).sku, 'sku', errors, 60);
    if (errors.length > 0) fail(errors);
    setLineSku(db, Number(req.params.id), Number(req.params.lineId), sku);
    res.json(poDetail(db, Number(req.params.id)));
  });

  app.get('/api/settings/matching', async (_req, res) => {
    // The warehouses are a convenience for the screen; MOD-03 being down is not a reason to hide the rules.
    let warehouses: { code: string; name: string }[] | null = null;
    if (platform.inventoryConfigured) {
      try {
        warehouses = await platform.inventoryWarehouses();
      } catch (err) {
        if (!(err instanceof PeerError)) throw err;
      }
    }
    res.json({ settings: readMatchSettings(db), ...matchSettingsStamp(db), inventory_configured: platform.inventoryConfigured, warehouses });
  });

  app.put('/api/settings/matching', (req, res) => {
    const settings = validateMatchSettings(body(req));
    const actor = actorOf(res, auth);
    writeMatchSettings(db, settings, actor);
    void platform.audit({ actor, action: 'settings.matching', resource: 'procurement-settings', after: settings });
    res.json({ settings, ...matchSettingsStamp(db), inventory_configured: platform.inventoryConfigured, warehouses: null });
  });

  // ── ERP CSV export ───────────────────────────────────────────────────
  app.get('/api/export/profiles', (_req, res) => {
    res.json({
      profiles: EXPORT_PROFILES.map((p) => ({
        name: p.name,
        description: p.description,
        delimiter: p.delimiter,
        columns: p.columns.map((c) => ({ header: c.header, field: c.field, money: c.money, date: c.date })),
      })),
    });
  });

  app.get('/api/export/pos.csv', (req, res) => {
    const name = typeof req.query.profile === 'string' ? req.query.profile : '';
    const profile = getProfile(name);
    if (!profile) {
      fail([
        {
          field: 'profile',
          message: `profile must be one of: ${EXPORT_PROFILES.map((p) => p.name).join(', ')}`,
        },
      ]);
    }
    const csv = exportOrderedPos(db, profile);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="po-export-${profile.name.toLowerCase()}.csv"`,
    );
    res.send(csv);
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
