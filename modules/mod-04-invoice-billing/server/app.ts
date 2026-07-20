import express, { type NextFunction, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { VAT_RATES } from '../shared/money.js';
import { STATUSES, type FieldError, type InvoiceStatus } from '../shared/types.js';
import {
  checkCredentials,
  clearedCookie,
  createToken,
  requireAuth,
  sessionCookie,
  type AuthConfig,
} from './auth.js';
import type { SellerConfig } from './config.js';
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
import { renderInvoicePdf } from './pdf.js';

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
  db: Database.Database;
  auth: AuthConfig;
  seller: SellerConfig;
  /** Absolute path to the built client (dist/client). Omit to serve API only. */
  staticDir?: string;
}

export function createApp({ db, auth, seller, staticDir }: AppOptions): express.Express {
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

  // ── Customers ────────────────────────────────────────────────────────
  app.get('/api/customers', (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const customers = db
      .prepare(
        `SELECT c.*, COUNT(i.id) AS invoice_count
         FROM customers c LEFT JOIN invoices i ON i.customer_id = c.id
         ${search ? 'WHERE c.name LIKE @s OR c.email LIKE @s OR c.vat_id LIKE @s' : ''}
         GROUP BY c.id ORDER BY c.name`,
      )
      .all(search ? { s: `%${search}%` } : {});
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

  app.post('/api/invoices/:id/finalize', (req, res) => {
    const errors: FieldError[] = [];
    const issueDate = optDate(body(req).issue_date, 'issue_date', errors);
    if (errors.length > 0) fail(errors);
    finalizeInvoice(db, Number(req.params.id), issueDate ?? undefined);
    res.json(invoiceDetail(db, Number(req.params.id)));
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

  app.get('/api/invoices/:id/pdf', (req, res) => {
    const invoice = invoiceDetail(db, Number(req.params.id));
    const customer = getCustomer(db, invoice.customer_id);
    const pdf = renderInvoicePdf(invoice, customer, seller);
    const filename = `${invoice.number ?? `draft-${invoice.id}`}.pdf`;
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
