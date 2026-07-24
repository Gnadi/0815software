import express, { type NextFunction, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { PO_STATUSES, RFQ_STATUSES, type FieldError, type PoStatus, type RfqStatus } from '../shared/types.js';
import { APPROVAL_RULES, APPROVAL_TIERS } from './approval-config.js';
import {
  checkCredentials,
  clearedCookie,
  createToken,
  requireAuth,
  sessionCookie,
  type AuthConfig,
} from './auth.js';
import { exportOrderedPos } from './csv.js';
import { EXPORT_PROFILES, getProfile } from './export-profiles.js';
import { noopPlatform, type PlatformHooks } from './platform.js';
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
  db: Database.Database;
  auth: AuthConfig;
  /** Absolute path to the built client (dist/client). Omit to serve API only. */
  staticDir?: string;
  /** Optional Platform Services integration; defaults to a no-op (standalone). */
  platform?: PlatformHooks;
}

export function createApp({ db, auth, staticDir, platform = noopPlatform }: AppOptions): express.Express {
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
         ${search ? 'WHERE s.name LIKE @s OR s.email LIKE @s OR s.contact LIKE @s' : ''}
         ORDER BY s.name`,
      )
      .all(search ? { s: `%${search}%` } : {});
    res.json({ suppliers });
  });

  app.post('/api/suppliers', (req, res) => {
    const values = validateSupplier(body(req));
    const info = db
      .prepare('INSERT INTO suppliers (name, contact, email, notes, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(values.name, values.contact, values.email, values.notes, nowIso());
    res.status(201).json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(info.lastInsertRowid));
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
    void platform.audit({ actor: auth.username, action: 'po.submitted', resource: `po:${req.params.id}` });
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
