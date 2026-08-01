import type Database from 'better-sqlite3';
import { lineNetCents } from '../shared/money.js';
import type {
  Invitation,
  Quote,
  RfqDetail,
  RfqLine,
  RfqRow,
  RfqStatus,
  RfqStoredStatus,
} from '../shared/types.js';
import { createPo, DomainError, getSupplier, nowIso, requireRow } from './purchase-orders.js';
import { likeTerm } from './purchase-orders.js';

interface RfqStoredRow {
  id: number;
  title: string;
  status: RfqStoredStatus;
  due_date: string | null;
  note: string | null;
  awarded_supplier_id: number | null;
  awarded_po_id: number | null;
  awarded_at: string | null;
  closed_at: string | null;
  created_at: string;
}

function getRfq(db: Database.Database, id: number): RfqStoredRow {
  return requireRow(
    db.prepare('SELECT * FROM rfqs WHERE id = ?').get(id) as RfqStoredRow | undefined,
    'RFQ',
  );
}

export function rfqLines(db: Database.Database, rfqId: number): RfqLine[] {
  return db
    .prepare('SELECT * FROM rfq_lines WHERE rfq_id = ? ORDER BY position, id')
    .all(rfqId) as RfqLine[];
}

function quoteCount(db: Database.Database, rfqId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM quotes WHERE rfq_id = ?').get(rfqId) as { n: number }).n;
}

/** Derived lifecycle status: "quoted" = open with at least one quote in. */
function derivedStatus(rfq: RfqStoredRow, quotes: number): RfqStatus {
  if (rfq.status === 'open' && quotes > 0) return 'quoted';
  return rfq.status;
}

function toRow(db: Database.Database, rfq: RfqStoredRow): RfqRow {
  const quotes = quoteCount(db, rfq.id);
  const winner = rfq.awarded_supplier_id
    ? (db.prepare('SELECT name FROM suppliers WHERE id = ?').get(rfq.awarded_supplier_id) as { name: string })
    : null;
  return {
    id: rfq.id,
    title: rfq.title,
    status: derivedStatus(rfq, quotes),
    due_date: rfq.due_date,
    note: rfq.note,
    line_count: (db.prepare('SELECT COUNT(*) AS n FROM rfq_lines WHERE rfq_id = ?').get(rfq.id) as { n: number }).n,
    invited_count: (db.prepare('SELECT COUNT(*) AS n FROM rfq_invitations WHERE rfq_id = ?').get(rfq.id) as { n: number }).n,
    quote_count: quotes,
    awarded_supplier_id: rfq.awarded_supplier_id,
    awarded_supplier_name: winner?.name ?? null,
    awarded_po_id: rfq.awarded_po_id,
    created_at: rfq.created_at,
  };
}

export function listRfqs(db: Database.Database, opts: { status?: RfqStatus; search?: string } = {}): RfqRow[] {
  const search = opts.search?.trim();
  const rfqs = db
    .prepare(`SELECT * FROM rfqs ${search ? 'WHERE title LIKE ? ESCAPE \'\\\'' : ''} ORDER BY id DESC`)
    .all(...(search ? [likeTerm(search)] : [])) as RfqStoredRow[];
  let rows = rfqs.map((rfq) => toRow(db, rfq));
  if (opts.status) rows = rows.filter((r) => r.status === opts.status);
  return rows;
}

function quotesOf(db: Database.Database, rfqId: number): Quote[] {
  const lines = rfqLines(db, rfqId);
  const qtyByLine = new Map(lines.map((l) => [l.id, l.quantity]));
  const quotes = db
    .prepare(
      `SELECT q.*, s.name AS supplier_name FROM quotes q
       JOIN suppliers s ON s.id = q.supplier_id
       WHERE q.rfq_id = ? ORDER BY q.id`,
    )
    .all(rfqId) as (Omit<Quote, 'lines' | 'total_cents'> & { supplier_name: string })[];
  return quotes.map((quote) => {
    const qLines = (
      db
        .prepare('SELECT rfq_line_id, unit_price_cents FROM quote_lines WHERE quote_id = ? ORDER BY rfq_line_id')
        .all(quote.id) as { rfq_line_id: number; unit_price_cents: number }[]
    ).map((l) => ({
      ...l,
      net_cents: lineNetCents({ quantity: qtyByLine.get(l.rfq_line_id) ?? 0, unit_price_cents: l.unit_price_cents }),
    }));
    return { ...quote, lines: qLines, total_cents: qLines.reduce((sum, l) => sum + l.net_cents, 0) };
  });
}

export function rfqDetail(db: Database.Database, id: number): RfqDetail {
  const rfq = getRfq(db, id);
  const invitations = db
    .prepare(
      `SELECT i.*, s.name AS supplier_name,
              EXISTS (SELECT 1 FROM quotes q WHERE q.rfq_id = i.rfq_id AND q.supplier_id = i.supplier_id) AS has_quote
       FROM rfq_invitations i JOIN suppliers s ON s.id = i.supplier_id
       WHERE i.rfq_id = ? ORDER BY i.id`,
    )
    .all(id) as (Omit<Invitation, 'has_quote'> & { has_quote: 0 | 1 })[];
  return {
    ...toRow(db, rfq),
    awarded_at: rfq.awarded_at,
    closed_at: rfq.closed_at,
    lines: rfqLines(db, id),
    invitations: invitations.map((i) => ({ ...i, has_quote: i.has_quote === 1 })),
    quotes: quotesOf(db, id),
  };
}

export interface RfqLineInput {
  description: string;
  quantity: number;
  unit: string;
}

export interface RfqInput {
  title: string;
  dueDate: string | null;
  note: string | null;
  lines: RfqLineInput[];
  createdAt?: string;
}

function writeLines(db: Database.Database, rfqId: number, lines: RfqLineInput[]): void {
  const insert = db.prepare(
    'INSERT INTO rfq_lines (rfq_id, position, description, quantity, unit) VALUES (?, ?, ?, ?, ?)',
  );
  lines.forEach((line, i) => {
    insert.run(rfqId, i + 1, line.description, line.quantity, line.unit);
  });
}

export function createRfq(db: Database.Database, input: RfqInput): number {
  return db.transaction(() => {
    const info = db
      .prepare("INSERT INTO rfqs (title, status, due_date, note, created_at) VALUES (?, 'open', ?, ?, ?)")
      .run(input.title, input.dueDate, input.note, input.createdAt ?? nowIso());
    const rfqId = Number(info.lastInsertRowid);
    writeLines(db, rfqId, input.lines);
    return rfqId;
  })();
}

/**
 * Replace an RFQ's fields and lines. Only while open AND before the
 * first quote: quotes price the lines as sent to the suppliers, so
 * changing lines under a received quote is a 409.
 */
export function updateRfq(db: Database.Database, id: number, input: RfqInput): void {
  const rfq = getRfq(db, id);
  if (rfq.status !== 'open') {
    throw new DomainError(409, `RFQ #${id} is ${rfq.status} and can no longer be edited`);
  }
  if (quoteCount(db, id) > 0) {
    throw new DomainError(409, `RFQ #${id} already has quotes — its lines are what suppliers priced`);
  }
  db.transaction(() => {
    db.prepare('UPDATE rfqs SET title = ?, due_date = ?, note = ? WHERE id = ?').run(
      input.title,
      input.dueDate,
      input.note,
      id,
    );
    db.prepare('DELETE FROM rfq_lines WHERE rfq_id = ?').run(id);
    writeLines(db, id, input.lines);
  })();
}

export function deleteRfq(db: Database.Database, id: number): void {
  const rfq = getRfq(db, id);
  if (rfq.status !== 'open' || quoteCount(db, id) > 0) {
    throw new DomainError(409, `Only open RFQs without quotes can be deleted`);
  }
  db.prepare('DELETE FROM rfqs WHERE id = ?').run(id);
}

export function inviteSupplier(
  db: Database.Database,
  rfqId: number,
  supplierId: number,
  at?: string,
): void {
  const rfq = getRfq(db, rfqId);
  if (rfq.status !== 'open') {
    throw new DomainError(409, `RFQ #${rfqId} is ${rfq.status} — no further invitations`);
  }
  getSupplier(db, supplierId);
  const existing = db
    .prepare('SELECT id FROM rfq_invitations WHERE rfq_id = ? AND supplier_id = ?')
    .get(rfqId, supplierId);
  if (existing) {
    throw new DomainError(409, 'This supplier is already invited');
  }
  db.prepare('INSERT INTO rfq_invitations (rfq_id, supplier_id, created_at) VALUES (?, ?, ?)').run(
    rfqId,
    supplierId,
    at ?? nowIso(),
  );
}

export interface QuoteInput {
  validUntil: string | null;
  note: string | null;
  /** Exactly one price per RFQ line. */
  prices: { rfqLineId: number; unitPriceCents: number }[];
  createdAt?: string;
}

/**
 * Record (or replace) a supplier's quote. The supplier must be invited,
 * the RFQ still open, and the quote must price EVERY line — awarding
 * copies a complete quote into a PO, so partial quotes are rejected up
 * front with 422.
 */
export function upsertQuote(
  db: Database.Database,
  rfqId: number,
  supplierId: number,
  input: QuoteInput,
): void {
  const rfq = getRfq(db, rfqId);
  if (rfq.status !== 'open') {
    throw new DomainError(409, `RFQ #${rfqId} is ${rfq.status} — quotes can no longer be recorded`);
  }
  getSupplier(db, supplierId);
  const invited = db
    .prepare('SELECT id FROM rfq_invitations WHERE rfq_id = ? AND supplier_id = ?')
    .get(rfqId, supplierId);
  if (!invited) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'supplier_id', message: 'Only invited suppliers can quote — invite the supplier first' },
    ]);
  }

  const lines = rfqLines(db, rfqId);
  const lineIds = new Set(lines.map((l) => l.id));
  const pricedIds = new Set(input.prices.map((p) => p.rfqLineId));
  const missing = lines.filter((l) => !pricedIds.has(l.id));
  const unknown = input.prices.filter((p) => !lineIds.has(p.rfqLineId));
  if (missing.length > 0 || unknown.length > 0 || input.prices.length !== lines.length) {
    throw new DomainError(422, 'Validation failed', [
      {
        field: 'prices',
        message: `A quote must price every RFQ line exactly once (${lines.length} lines${missing.length > 0 ? `, missing: ${missing.map((l) => l.id).join(', ')}` : ''}${unknown.length > 0 ? `, unknown line ids: ${unknown.map((p) => p.rfqLineId).join(', ')}` : ''})`,
      },
    ]);
  }

  db.transaction(() => {
    db.prepare('DELETE FROM quotes WHERE rfq_id = ? AND supplier_id = ?').run(rfqId, supplierId);
    const info = db
      .prepare('INSERT INTO quotes (rfq_id, supplier_id, valid_until, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(rfqId, supplierId, input.validUntil, input.note, input.createdAt ?? nowIso());
    const quoteId = Number(info.lastInsertRowid);
    const insert = db.prepare(
      'INSERT INTO quote_lines (quote_id, rfq_line_id, unit_price_cents) VALUES (?, ?, ?)',
    );
    for (const price of input.prices) {
      insert.run(quoteId, price.rfqLineId, price.unitPriceCents);
    }
  })();
}

/**
 * Award the RFQ to exactly one quoted supplier. In ONE transaction:
 * a draft PO is created with the RFQ's lines priced at the winning
 * quote, and the RFQ flips to `awarded` (which is terminal — a second
 * award is a 409 because the RFQ is no longer open). The PO then walks
 * the normal draft → submitted → approved workflow.
 */
export function awardRfq(
  db: Database.Database,
  rfqId: number,
  supplierId: number,
  at?: string,
): { poId: number } {
  const rfq = getRfq(db, rfqId);
  if (rfq.status !== 'open') {
    throw new DomainError(
      409,
      rfq.status === 'awarded'
        ? `RFQ #${rfqId} is already awarded — an RFQ has exactly one winner`
        : `RFQ #${rfqId} is closed and cannot be awarded`,
    );
  }
  getSupplier(db, supplierId);
  const quote = db
    .prepare('SELECT id FROM quotes WHERE rfq_id = ? AND supplier_id = ?')
    .get(rfqId, supplierId) as { id: number } | undefined;
  if (!quote) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'supplier_id', message: 'Only a supplier with a recorded quote can be awarded' },
    ]);
  }

  return db.transaction(() => {
    const lines = rfqLines(db, rfqId);
    const priceByLine = new Map(
      (
        db.prepare('SELECT rfq_line_id, unit_price_cents FROM quote_lines WHERE quote_id = ?').all(quote.id) as {
          rfq_line_id: number;
          unit_price_cents: number;
        }[]
      ).map((l) => [l.rfq_line_id, l.unit_price_cents]),
    );
    const timestamp = at ?? nowIso();
    const poId = createPo(db, {
      supplierId,
      rfqId,
      note: `Awarded from RFQ #${rfqId} — ${rfq.title}`,
      createdAt: timestamp,
      lines: lines.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPriceCents: priceByLine.get(line.id)!,
      })),
    });
    db.prepare(
      "UPDATE rfqs SET status = 'awarded', awarded_supplier_id = ?, awarded_po_id = ?, awarded_at = ? WHERE id = ?",
    ).run(supplierId, poId, timestamp, rfqId);
    return { poId };
  })();
}

/** Close without an award. Terminal, like `awarded`. */
export function closeRfq(db: Database.Database, id: number, at?: string): void {
  const rfq = getRfq(db, id);
  if (rfq.status !== 'open') {
    throw new DomainError(409, `Only open RFQs can be closed (status: ${rfq.status})`);
  }
  db.prepare("UPDATE rfqs SET status = 'closed', closed_at = ? WHERE id = ?").run(at ?? nowIso(), id);
}
