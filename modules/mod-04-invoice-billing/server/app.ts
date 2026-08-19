import express, { type NextFunction, type Request, type Response } from 'express';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import type Database from 'better-sqlite3';
import { VAT_RATES } from '../shared/money.js';
import { STATUSES, type FieldError, type InvoiceStatus } from '../shared/types.js';
import {
  actorOf,
  checkCredentials,
  clearedCookie,
  createToken,
  requireAuth,
  sessionCookie,
  type AuthConfig,
} from './auth.js';
import type { SellerConfig } from './config.js';
import { createHandoff, isRedeemPath, safeServiceTokenEqual } from './handoff.js';
import { parseSummaryContext } from '../shared/summary.js';
import { moduleSummary } from './summary.js';
import {
  cancelInvoice,
  createDraft,
  customerLedger,
  deleteDraft,
  DomainError,
  finalizeInvoice,
  getCustomer,
  invoiceDetail,
  listInvoices,
  nowIso,
  recordPayment,
  todayIso,
  updateDraft,
  type DraftInput,
  type LineInput,
} from './invoices.js';
import {
  cancelBill,
  createBill,
  createCreditor,
  createPaymentRun,
  deleteBill,
  deleteCreditor,
  discardRun,
  getBill,
  getCreditor,
  listBills,
  listCreditors,
  listPaymentRuns,
  markBillPaid,
  markRunExecuted,
  payablesSummary,
  paymentConfig,
  paymentRunDetail,
  paymentRunFilename,
  paymentRunXml,
  updateBill,
  updateCreditor,
  type BillInput,
  type CreditorInput,
} from './bills.js';
import { MAX_AMOUNT_CENTS, MAX_REMITTANCE, sepaAmount } from '../shared/sepa.js';
import { BILL_STATUSES, type BillStatus } from '../shared/types.js';
import { renderInvoicePdf } from './pdf.js';
import { fmtEur } from '../shared/money.js';
import { noopPlatform, OfferFetchError, type PlatformHooks } from './platform.js';
import { importTransfer, MODULE_ID } from './transfer-import.js';
import type { DocumentTransfer } from '../shared/transfer.js';
import { LOCAL_LOGIN, nullVerifier, type LoginMode, type LoginVerifier } from './sso.js';
import { likeTerm } from './invoices.js';

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

interface CustomerInput {
  name: string;
  email: string | null;
  vat_id: string | null;
  address: string | null;
}

function validateCustomer(input: Record<string, unknown>): CustomerInput {
  const errors: FieldError[] = [];
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '' || name.length > 160) errors.push({ field: 'name', message: 'Name is required (max 160 characters)' });
  const email = optText(input.email, 'email', errors, 160);
  if (email !== null && !/^\S+@\S+\.\S+$/.test(email)) {
    errors.push({ field: 'email', message: 'Email must look like an email address' });
  }
  const vat_id = optText(input.vat_id, 'vat_id', errors, 32);
  const address = optText(input.address, 'address', errors, 400);
  if (errors.length > 0) fail(errors);
  return { name, email, vat_id, address };
}

/**
 * A creditor as typed into the form. The IBAN and BIC are checked in
 * `bills.ts` — where the SEPA rules live — so this only guards the shape.
 */
function validateCreditor(input: Record<string, unknown>): CreditorInput {
  const errors: FieldError[] = [];
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '' || name.length > 160) {
    errors.push({ field: 'name', message: 'Name is required (max 160 characters)' });
  }
  const iban = typeof input.iban === 'string' ? input.iban.trim() : '';
  if (iban === '') errors.push({ field: 'iban', message: 'IBAN is required' });
  // Long enough to allow the spacing people paste ("GIBA ATWW XXX"); the real
  // 8-or-11 check happens after normalization, in bills.ts.
  const bic = optText(input.bic, 'bic', errors, 16);
  const note = optText(input.note, 'note', errors, 300);
  if (errors.length > 0) fail(errors);
  return { name, iban, bic, note };
}

/**
 * A bill as typed into the form.
 *
 * `amount_cents` is the GROSS amount to transfer — what the supplier's
 * invoice says is due, not a net figure this module would then have to apply
 * a VAT rate to. A bill is a payment instruction, not a tax document: the
 * module has no view on how the amount splits, and inventing one here would
 * put a tax decision in the screen least qualified to make it.
 */
function validateBill(input: Record<string, unknown>): BillInput {
  const errors: FieldError[] = [];
  const creditorId = id(input.creditor_id, 'creditor_id', errors);

  const reference = typeof input.reference === 'string' ? input.reference.trim() : '';
  if (reference === '' || reference.length > 64) {
    errors.push({ field: 'reference', message: "The supplier's invoice number is required (max 64 characters)" });
  }
  const remittance = optText(input.remittance, 'remittance', errors, MAX_REMITTANCE);

  const amountCents = Number(input.amount_cents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    errors.push({ field: 'amount_cents', message: 'Amount must be a positive integer amount in cents' });
  } else if (amountCents > MAX_AMOUNT_CENTS) {
    errors.push({
      field: 'amount_cents',
      message: `A single SEPA transfer cannot exceed ${sepaAmount(MAX_AMOUNT_CENTS)} EUR`,
    });
  }

  const issueDate = optDate(input.issue_date, 'issue_date', errors);
  const dueDate = optDate(input.due_date, 'due_date', errors);
  if (dueDate === null) errors.push({ field: 'due_date', message: 'A due date is required' });
  const note = optText(input.note, 'note', errors, 500);

  if (errors.length > 0) fail(errors);
  return { creditorId, reference, remittance, amountCents, issueDate, dueDate: dueDate!, note };
}

function validateDraft(input: Record<string, unknown>): DraftInput {
  const errors: FieldError[] = [];
  const customerId = id(input.customer_id, 'customer_id', errors);

  let paymentTermsDays = 14;
  if (input.payment_terms_days !== undefined && input.payment_terms_days !== null && input.payment_terms_days !== '') {
    paymentTermsDays = Number(input.payment_terms_days);
    if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0 || paymentTermsDays > 365) {
      errors.push({ field: 'payment_terms_days', message: 'Payment terms must be an integer between 0 and 365 days' });
    }
  }
  const note = optText(input.note, 'note', errors, 500);

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
    return { description, quantity, unitPriceCents, vatRate };
  });
  if (errors.length > 0) fail(errors);
  return { customerId, paymentTermsDays, note, lines };
}

export interface AppOptions {
  /** Optional transport hardening; omit it (as the tests do) to run unthrottled. */
  hardening?: HardeningConfig;
  db: Database.Database;
  auth: AuthConfig;
  seller: SellerConfig;
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

export function createApp({ db, hardening, auth, seller, staticDir, platform = noopPlatform, verifyLogin = nullVerifier, loginMode = LOCAL_LOGIN, serviceToken, shellOrigins = [] }: AppOptions): express.Express {
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
    res.setHeader('Set-Cookie', sessionCookie(auth, createToken(auth, actor)));
    res.json({ ok: true, username: actor });
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
      const { actor, path } = body(req);
      if (typeof actor !== 'string' || actor.trim() === '') throw new DomainError(422, 'actor is required');
      const target = path === undefined ? '/' : path;
      if (!isRedeemPath(target)) throw new DomainError(422, 'path must be module-relative');
      res.json(handoff.issue(actor.trim(), target));
    });

    app.post('/api/session/issue', (req, res) => {
      requireServiceToken(req);
      const { actor } = body(req);
      if (typeof actor !== 'string' || actor.trim() === '') throw new DomainError(422, 'actor is required');
      res.json(handoff.issueSession(actor.trim()));
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
    res.json({ username: actorOf(res, auth) });
  });

  // ── Customers ────────────────────────────────────────────────────────
  app.get('/api/customers', (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const customers = db
      .prepare(
        `SELECT c.*, COUNT(i.id) AS invoice_count
         FROM customers c LEFT JOIN invoices i ON i.customer_id = c.id
         ${search ? 'WHERE c.name LIKE @s ESCAPE \'\\\' OR c.email LIKE @s ESCAPE \'\\\' OR c.vat_id LIKE @s ESCAPE \'\\\'' : ''}
         GROUP BY c.id ORDER BY c.name`,
      )
      .all(search ? { s: likeTerm(search) } : {});
    res.json({ customers });
  });

  app.post('/api/customers', (req, res) => {
    const values = validateCustomer(body(req));
    const info = db
      .prepare('INSERT INTO customers (name, email, vat_id, address, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(values.name, values.email, values.vat_id, values.address, nowIso());
    res.status(201).json(db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid));
  });

  app.get('/api/customers/:id', (req, res) => {
    res.json(getCustomer(db, Number(req.params.id)));
  });

  app.put('/api/customers/:id', (req, res) => {
    getCustomer(db, Number(req.params.id));
    const values = validateCustomer(body(req));
    db.prepare('UPDATE customers SET name = ?, email = ?, vat_id = ?, address = ? WHERE id = ?').run(
      values.name,
      values.email,
      values.vat_id,
      values.address,
      req.params.id,
    );
    res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id));
  });

  app.delete('/api/customers/:id', (req, res) => {
    getCustomer(db, Number(req.params.id));
    const used = db
      .prepare('SELECT COUNT(*) AS n FROM invoices WHERE customer_id = ?')
      .get(req.params.id) as { n: number };
    if (used.n > 0) {
      throw new DomainError(409, 'Customer has invoices and cannot be deleted');
    }
    db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/customers/:id/ledger', (req, res) => {
    res.json(customerLedger(db, Number(req.params.id)));
  });

  // ── Invoices ─────────────────────────────────────────────────────────
  app.get('/api/invoices', (req, res) => {
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (rawStatus && !(STATUSES as readonly string[]).includes(rawStatus)) {
      fail([{ field: 'status', message: `status must be one of: ${STATUSES.join(', ')}` }]);
    }
    res.json({
      invoices: listInvoices(db, {
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        status: rawStatus as InvoiceStatus | undefined,
        overdueOnly: req.query.overdue === '1' || req.query.overdue === 'true',
      }),
      today: todayIso(),
    });
  });

  app.post('/api/invoices', (req, res) => {
    const invoiceId = createDraft(db, validateDraft(body(req)));
    res.status(201).json(invoiceDetail(db, invoiceId));
  });

  // ── Bill an accepted offer ───────────────────────────────────────────
  // The one action that closes the quote-to-invoice gap. It fetches the offer
  // as a neutral document transfer (shared/transfer.ts), resolves the customer
  // through PS-11 when configured, and produces a DRAFT — the operator still
  // reviews and finalizes, so nothing is issued behind their back.
  //
  // Idempotent on the offer number: a retry returns the invoice the first call
  // produced, with 200 instead of 201, so a double click cannot double-bill.
  app.post('/api/invoices/import-offer', async (req, res) => {
    const reference = body(req).offer_number;
    if (typeof reference !== 'string' || reference.trim() === '') {
      fail([{ field: 'offer_number', message: 'offer_number is required' }]);
    }
    const offerNumber = (reference as string).trim();

    let transfer: unknown;
    try {
      transfer = await platform.fetchOffer(offerNumber);
    } catch (err) {
      if (err instanceof OfferFetchError) throw new DomainError(err.status === 404 ? 404 : 502, err.message);
      throw err;
    }
    if (transfer === null) {
      throw new DomainError(
        501,
        'No offer source is configured — set OFFERS_URL to bill offers from MOD-13',
      );
    }

    // PS-11 is the identity authority when it is wired; without it the import
    // falls back to matching against this module's own customers table.
    const party = (transfer as DocumentTransfer).customer;
    const partyId =
      party && typeof party === 'object'
        ? await platform.resolveParty({
            name: party.name,
            email: party.email,
            vatId: party.vat_id,
            addressLines: party.address_lines ?? [],
            source: party.source ?? MODULE_ID,
            externalId: party.external_id ?? offerNumber,
          })
        : null;

    const result = importTransfer(db, transfer, { partyId });
    // Register this module's own customer id against the master party, so PS-11
    // records that both modules refer to it. The resolve above matched on the
    // EXPORTER's reference, which is what made them converge in the first place.
    if (partyId !== null) await platform.linkParty(partyId, result.customerId);
    const detail = invoiceDetail(db, result.invoiceId);
    if (!result.replayed) {
      await platform.offerBilled({
        offerNumber,
        invoiceId: result.invoiceId,
        customerName: detail.customer_name,
        totalFormatted: fmtEur(detail.gross_cents),
        actor: actorOf(res, auth),
      });
    }
    res.status(result.replayed ? 200 : 201).json({ ...detail, imported: !result.replayed });
  });

  app.get('/api/invoices/:id', (req, res) => {
    res.json(invoiceDetail(db, Number(req.params.id)));
  });

  app.put('/api/invoices/:id', (req, res) => {
    updateDraft(db, Number(req.params.id), validateDraft(body(req)));
    res.json(invoiceDetail(db, Number(req.params.id)));
  });

  app.delete('/api/invoices/:id', (req, res) => {
    deleteDraft(db, Number(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/invoices/:id/finalize', async (req, res) => {
    const errors: FieldError[] = [];
    const issueDate = optDate(body(req).issue_date, 'issue_date', errors);
    if (errors.length > 0) fail(errors);
    // When PS-10 Number is configured, source the invoice number from it
    // (authoritative, gapless); otherwise the local per-year counter assigns it.
    const numberOverride = await platform.nextInvoiceNumber();
    finalizeInvoice(db, Number(req.params.id), issueDate ?? undefined, numberOverride ?? undefined);
    const detail = invoiceDetail(db, Number(req.params.id));

    // Fan the freshly-issued invoice out to the Platform Services (email the
    // customer, archive the PDF, record the audit event). Best-effort and a
    // no-op when nothing is configured, so mod-04 still works standalone.
    const customer = getCustomer(db, detail.customer_id);
    try {
      await platform.invoiceIssued({
        number: detail.number ?? `draft-${detail.id}`,
        customerEmail: customer.email,
        customerName: detail.customer_name,
        totalFormatted: fmtEur(detail.gross_cents),
        pdf: renderInvoicePdf(detail, customer, seller),
        // Was `res.locals.username`, which nothing ever set — so every issued
        // invoice reached PS-07 as the literal "admin".
        actor: actorOf(res, auth),
      });
    } catch (err) {
      // A platform side-effect must never fail the invoice itself.
      console.warn('[mod-04] platform.invoiceIssued failed:', err);
    }

    res.json(detail);
  });

  app.post('/api/invoices/:id/cancel', (req, res) => {
    const errors: FieldError[] = [];
    const reason = optText(body(req).reason, 'reason', errors, 300);
    if (!reason) errors.push({ field: 'reason', message: 'A cancellation reason is required' });
    if (errors.length > 0) fail(errors);
    cancelInvoice(db, Number(req.params.id), reason!);
    res.json(invoiceDetail(db, Number(req.params.id)));
  });

  app.post('/api/invoices/:id/payments', (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const date = optDate(input.date, 'date', errors) ?? todayIso();
    const amountCents = Number(input.amount_cents);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      errors.push({ field: 'amount_cents', message: 'Amount must be a positive integer amount in cents' });
    }
    const note = optText(input.note, 'note', errors, 200);
    if (errors.length > 0) fail(errors);
    recordPayment(db, Number(req.params.id), { date, amountCents, note });
    res.status(201).json(invoiceDetail(db, Number(req.params.id)));
  });

  // Collect payment for an invoice's open balance via PS-08 Payments. When the
  // payment settles synchronously it is recorded here; otherwise the intent is
  // pending (settled later by PS-08's webhook/tick). 501 when Payments is unset.
  app.post('/api/invoices/:id/pay', async (req, res) => {
    const id = Number(req.params.id);
    const detail = invoiceDetail(db, id);
    if (detail.status !== 'sent') fail([{ field: 'status', message: 'Only a sent, unpaid invoice can be paid' }]);
    if (detail.open_cents <= 0) fail([{ field: 'status', message: 'Invoice has no open balance' }]);

    const result = await platform.payInvoice({ number: detail.number!, amountMinor: detail.open_cents, currency: 'EUR' });
    if (result === null) {
      res.status(501).json({ error: 'Payments are not configured (set PAYMENTS_URL)' });
      return;
    }
    if (result.status === 'succeeded') {
      recordPayment(db, id, { date: todayIso(), amountCents: detail.open_cents, note: `PS-08 ${result.public_id}` });
    }
    res.json({ payment: result, invoice: invoiceDetail(db, id) });
  });

  app.get('/api/invoices/:id/pdf', (req, res) => {
    const invoice = invoiceDetail(db, Number(req.params.id));
    const customer = getCustomer(db, invoice.customer_id);
    const pdf = renderInvoicePdf(invoice, customer, seller);
    const filename = `${invoice.number ?? `draft-${invoice.id}`}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(pdf);
  });

  // ── Payables: bills, and the bank file that pays them ────────────────
  // The mirror of everything above: invoices are money coming in, bills are
  // money going out. `server/bills.ts` holds the rules, `shared/sepa.ts` the
  // pain.001 file. Nothing here talks to a bank — the operator uploads the
  // file in their own online banking.

  // What the payment screens must know before offering to build a file: who
  // the debtor is, and whether this installation's own IBAN is usable at all.
  app.get('/api/payment-config', (_req, res) => {
    res.json(paymentConfig(seller));
  });

  app.get('/api/creditors', (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    res.json({ creditors: listCreditors(db, search || undefined) });
  });

  app.post('/api/creditors', (req, res) => {
    const creditorId = createCreditor(db, validateCreditor(body(req)));
    res.status(201).json(getCreditor(db, creditorId));
  });

  app.get('/api/creditors/:id', (req, res) => {
    res.json(getCreditor(db, Number(req.params.id)));
  });

  app.put('/api/creditors/:id', (req, res) => {
    updateCreditor(db, Number(req.params.id), validateCreditor(body(req)));
    res.json(getCreditor(db, Number(req.params.id)));
  });

  app.delete('/api/creditors/:id', (req, res) => {
    deleteCreditor(db, Number(req.params.id));
    res.json({ ok: true });
  });

  app.get('/api/bills', (req, res) => {
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (rawStatus && !(BILL_STATUSES as readonly string[]).includes(rawStatus)) {
      fail([{ field: 'status', message: `status must be one of: ${BILL_STATUSES.join(', ')}` }]);
    }
    const today = todayIso();
    res.json({
      bills: listBills(
        db,
        {
          search: typeof req.query.search === 'string' ? req.query.search : undefined,
          status: rawStatus as BillStatus | undefined,
          overdueOnly: req.query.overdue === '1' || req.query.overdue === 'true',
        },
        today,
      ),
      totals: payablesSummary(db, today),
      today,
    });
  });

  app.post('/api/bills', (req, res) => {
    const billId = createBill(db, validateBill(body(req)));
    res.status(201).json(getBill(db, billId));
  });

  app.get('/api/bills/:id', (req, res) => {
    res.json(getBill(db, Number(req.params.id)));
  });

  app.put('/api/bills/:id', (req, res) => {
    updateBill(db, Number(req.params.id), validateBill(body(req)));
    res.json(getBill(db, Number(req.params.id)));
  });

  app.delete('/api/bills/:id', (req, res) => {
    deleteBill(db, Number(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/bills/:id/cancel', (req, res) => {
    cancelBill(db, Number(req.params.id));
    res.json(getBill(db, Number(req.params.id)));
  });

  // Settled outside a payment run — cash, card, standing order, or a transfer
  // typed straight into the bank. A scheduled bill is refused (409): its run
  // is the record of how it is being paid.
  app.post('/api/bills/:id/mark-paid', (req, res) => {
    markBillPaid(db, Number(req.params.id));
    res.json(getBill(db, Number(req.params.id)));
  });

  app.get('/api/payment-runs', (_req, res) => {
    res.json({ runs: listPaymentRuns(db), config: paymentConfig(seller) });
  });

  app.post('/api/payment-runs', async (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const rawIds = Array.isArray(input.bill_ids) ? input.bill_ids : [];
    if (rawIds.length === 0) errors.push({ field: 'bill_ids', message: 'Select at least one bill to pay' });
    const billIds = rawIds.map((raw, i) => id(raw, `bill_ids[${i}]`, errors));
    const executionDate = optDate(input.execution_date, 'execution_date', errors);
    if (errors.length > 0) fail(errors);

    const runId = createPaymentRun(db, seller, {
      billIds,
      executionDate: executionDate ?? undefined,
      createdBy: actorOf(res, auth),
    });
    const detail = paymentRunDetail(db, runId);
    await platform.paymentRunEvent({
      event: 'created',
      runId,
      messageId: detail.message_id,
      count: detail.item_count,
      totalFormatted: fmtEur(detail.total_cents),
      executionDate: detail.execution_date,
      actor: actorOf(res, auth),
    });
    res.status(201).json(detail);
  });

  app.get('/api/payment-runs/:id', (req, res) => {
    res.json(paymentRunDetail(db, Number(req.params.id)));
  });

  // THE FILE. Rebuilt from the run's frozen snapshot, so downloading it twice
  // yields the same bytes twice — a bank rejects a second file carrying a
  // MsgId it has already seen, and an operator who downloads again must get
  // the file they already uploaded, not a new one.
  app.get('/api/payment-runs/:id/sepa.xml', (req, res) => {
    const detail = paymentRunDetail(db, Number(req.params.id));
    const xml = paymentRunXml(db, Number(req.params.id));
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${paymentRunFilename(detail.message_id)}"`);
    res.send(xml);
  });

  app.post('/api/payment-runs/:id/mark-executed', async (req, res) => {
    markRunExecuted(db, Number(req.params.id));
    const detail = paymentRunDetail(db, Number(req.params.id));
    await platform.paymentRunEvent({
      event: 'executed',
      runId: detail.id,
      messageId: detail.message_id,
      count: detail.item_count,
      totalFormatted: fmtEur(detail.total_cents),
      executionDate: detail.execution_date,
      actor: actorOf(res, auth),
    });
    res.json(detail);
  });

  app.post('/api/payment-runs/:id/discard', async (req, res) => {
    discardRun(db, Number(req.params.id));
    const detail = paymentRunDetail(db, Number(req.params.id));
    await platform.paymentRunEvent({
      event: 'discarded',
      runId: detail.id,
      messageId: detail.message_id,
      count: detail.item_count,
      totalFormatted: fmtEur(detail.total_cents),
      executionDate: detail.execution_date,
      actor: actorOf(res, auth),
    });
    res.json(detail);
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
