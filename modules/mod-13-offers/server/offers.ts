import type Database from 'better-sqlite3';
import { computeTotals, lineNetCents } from '../shared/money.js';
import type {
  Customer,
  OfferDetail,
  OfferEvent,
  OfferLine,
  OfferRow,
  OfferStatus,
  StoredStatus,
} from '../shared/types.js';
import { offerToken } from './tokens.js';

/** Error with an HTTP status and optional per-field details. */
export class DomainError extends Error {
  status: number;
  details: { field: string; message: string }[];

  constructor(status: number, message: string, details: { field: string; message: string }[] = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** "YYYY-MM-DD" for today (UTC) — the default reference date for expiry. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** date + n days, both as "YYYY-MM-DD". */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function requireRow<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new DomainError(404, `${what} not found`);
  return row;
}

export function getCustomer(db: Database.Database, id: number): Customer {
  return requireRow(
    db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Customer | undefined,
    'Customer',
  );
}

interface OfferStoredRow {
  id: number;
  number: string | null;
  customer_id: number;
  title: string;
  status: StoredStatus;
  valid_until: string | null;
  intro: string | null;
  terms: string | null;
  sent_at: string | null;
  supersedes_id: number | null;
  created_at: string;
}

function getOffer(db: Database.Database, id: number): OfferStoredRow {
  return requireRow(
    db.prepare('SELECT * FROM offers WHERE id = ?').get(id) as OfferStoredRow | undefined,
    'Offer',
  );
}

function offerLines(db: Database.Database, offerId: number): OfferLine[] {
  const rows = db
    .prepare('SELECT * FROM offer_lines WHERE offer_id = ? ORDER BY position, id')
    .all(offerId) as Omit<OfferLine, 'net_cents'>[];
  return rows.map((row) => ({ ...row, net_cents: lineNetCents(row) }));
}

/** "expired" is a sent offer whose validity date is strictly before the clock. */
function isExpired(stored: StoredStatus, validUntil: string | null, today: string): boolean {
  return stored === 'sent' && validUntil !== null && validUntil < today;
}

/** Derived lifecycle status: a sent offer past its validity is "expired". */
function derivedStatus(stored: StoredStatus, validUntil: string | null, today: string): OfferStatus {
  return isExpired(stored, validUntil, today) ? 'expired' : stored;
}

function supersededById(db: Database.Database, offerId: number): number | null {
  const row = db
    .prepare('SELECT id FROM offers WHERE supersedes_id = ?')
    .get(offerId) as { id: number } | undefined;
  return row?.id ?? null;
}

function toRow(db: Database.Database, offer: OfferStoredRow, today: string): OfferRow {
  const lines = offerLines(db, offer.id);
  const totals = computeTotals(lines);
  const customer = db
    .prepare('SELECT name FROM customers WHERE id = ?')
    .get(offer.customer_id) as { name: string };
  return {
    id: offer.id,
    number: offer.number,
    customer_id: offer.customer_id,
    customer_name: customer.name,
    title: offer.title,
    status: derivedStatus(offer.status, offer.valid_until, today),
    valid_until: offer.valid_until,
    expired: isExpired(offer.status, offer.valid_until, today),
    sent_at: offer.sent_at,
    net_cents: totals.net_cents,
    vat_cents: totals.vat_cents,
    gross_cents: totals.gross_cents,
    supersedes_id: offer.supersedes_id,
    superseded_by_id: supersededById(db, offer.id),
    created_at: offer.created_at,
  };
}

export interface ListOptions {
  search?: string;
  status?: OfferStatus;
}

export function listOffers(db: Database.Database, opts: ListOptions = {}, today = todayIso()): OfferRow[] {
  const search = opts.search?.trim();
  const offers = db
    .prepare(
      `SELECT o.* FROM offers o JOIN customers c ON c.id = o.customer_id
       ${search ? 'WHERE o.number LIKE ? OR o.title LIKE ? OR c.name LIKE ?' : ''}
       ORDER BY o.number IS NULL DESC, o.created_at DESC, o.id DESC`,
    )
    .all(...(search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [])) as OfferStoredRow[];

  let rows = offers.map((offer) => toRow(db, offer, today));
  if (opts.status) rows = rows.filter((r) => r.status === opts.status);
  return rows;
}

export interface DetailContext {
  today?: string;
  /** When set, fills the public acceptance token/link for numbered offers. */
  secret?: string;
  publicBaseUrl?: string;
}

export function offerDetail(db: Database.Database, id: number, ctx: DetailContext = {}): OfferDetail {
  const today = ctx.today ?? todayIso();
  const offer = getOffer(db, id);
  const row = toRow(db, offer, today);
  const lines = offerLines(db, offer.id);
  const totals = computeTotals(lines);
  const events = db
    .prepare('SELECT * FROM offer_events WHERE offer_id = ? ORDER BY created_at, id')
    .all(id) as OfferEvent[];

  const supersedesNumber = offer.supersedes_id
    ? ((db.prepare('SELECT number FROM offers WHERE id = ?').get(offer.supersedes_id) as
        | { number: string | null }
        | undefined)?.number ?? null)
    : null;
  const supersededByNumber = row.superseded_by_id
    ? ((db.prepare('SELECT number FROM offers WHERE id = ?').get(row.superseded_by_id) as
        | { number: string | null }
        | undefined)?.number ?? null)
    : null;

  let publicToken: string | null = null;
  let publicPath: string | null = null;
  if (ctx.secret && offer.number) {
    publicToken = offerToken(ctx.secret, offer.number);
    publicPath = `/offer/${encodeURIComponent(offer.number)}?token=${publicToken}`;
  }

  return {
    ...row,
    intro: offer.intro,
    terms: offer.terms,
    discount_cents: totals.discount_cents,
    lines,
    vat_breakdown: totals.by_rate,
    events,
    supersedes_number: supersedesNumber,
    superseded_by_number: supersededByNumber,
    public_token: publicToken,
    public_path: publicPath,
  };
}

// ── Writes ───────────────────────────────────────────────────────────────

export interface LineInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  vatRate: number;
  discountPercent: number;
}

export interface OfferInput {
  customerId: number;
  title: string;
  validUntil: string | null;
  intro: string | null;
  terms: string | null;
  lines: LineInput[];
  supersedesId?: number | null;
  createdAt?: string;
}

function writeLines(db: Database.Database, offerId: number, lines: LineInput[]): void {
  const insert = db.prepare(
    `INSERT INTO offer_lines (offer_id, position, description, quantity, unit_price_cents, vat_rate, discount_percent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  lines.forEach((line, i) => {
    insert.run(
      offerId,
      i + 1,
      line.description,
      line.quantity,
      line.unitPriceCents,
      line.vatRate,
      line.discountPercent,
    );
  });
}

function addEvent(
  db: Database.Database,
  offerId: number,
  event: OfferEvent['event'],
  actor: string,
  note: string | null,
  at: string,
): void {
  db.prepare(
    'INSERT INTO offer_events (offer_id, event, actor, note, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(offerId, event, actor, note, at);
}

/** Create a draft. Drafts have NO number — numbering happens at finalization. */
export function createDraft(db: Database.Database, input: OfferInput): number {
  getCustomer(db, input.customerId);
  const at = input.createdAt ?? nowIso();
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO offers (customer_id, title, status, valid_until, intro, terms, supersedes_id, created_at)
         VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.customerId,
        input.title,
        input.validUntil,
        input.intro,
        input.terms,
        input.supersedesId ?? null,
        at,
      );
    const offerId = Number(info.lastInsertRowid);
    writeLines(db, offerId, input.lines);
    addEvent(db, offerId, 'created', 'admin', null, at);
    return offerId;
  })();
}

/** Replace a draft's fields and lines. Sent (and beyond) offers are immutable → 409. */
export function updateDraft(db: Database.Database, id: number, input: OfferInput): void {
  const offer = getOffer(db, id);
  if (offer.status !== 'draft') {
    throw new DomainError(
      409,
      `Sent offers are immutable — create a revision of ${offer.number} instead of editing it`,
    );
  }
  getCustomer(db, input.customerId);
  db.transaction(() => {
    db.prepare(
      'UPDATE offers SET customer_id = ?, title = ?, valid_until = ?, intro = ?, terms = ? WHERE id = ?',
    ).run(input.customerId, input.title, input.validUntil, input.intro, input.terms, id);
    db.prepare('DELETE FROM offer_lines WHERE offer_id = ?').run(id);
    writeLines(db, id, input.lines);
  })();
}

/** Drafts can be deleted (they have no number, so no gap). Anything else → 409. */
export function deleteDraft(db: Database.Database, id: number): void {
  const offer = getOffer(db, id);
  if (offer.status !== 'draft') {
    throw new DomainError(
      409,
      `Only drafts can be deleted — ${offer.number} keeps its number (withdraw it instead)`,
    );
  }
  db.prepare('DELETE FROM offers WHERE id = ?').run(id);
}

export interface FinalizeOptions {
  /** The date the offer is sent (its number year comes from here). Defaults to today. */
  sentDate?: string;
  /** Timestamp recorded on sent_at and the "sent" event. Defaults to noon of sentDate. */
  at?: string;
  actor?: string;
}

/**
 * Finalize ("send") a draft: assign the next gapless sequential number
 * for the sent-year and flip to `sent` — atomically, in ONE transaction.
 * The per-year counter row is the single source of numbers; because the
 * read-increment-assign happens inside a SQLite transaction (and
 * better-sqlite3 serializes writes), two finalizations can never draw
 * the same number and no number is ever skipped.
 */
export function finalizeOffer(
  db: Database.Database,
  id: number,
  opts: FinalizeOptions = {},
): { number: string; sent_at: string } {
  const offer = getOffer(db, id);
  if (offer.status !== 'draft') {
    throw new DomainError(409, `Only drafts can be sent (status: ${offer.status})`);
  }
  if (offer.valid_until === null) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'valid_until', message: 'A validity date is required before an offer can be sent' },
    ]);
  }
  const lineCount = db
    .prepare('SELECT COUNT(*) AS c FROM offer_lines WHERE offer_id = ?')
    .get(id) as { c: number };
  if (lineCount.c === 0) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'lines', message: 'An offer needs at least one line item before it can be sent' },
    ]);
  }

  const sentDate = opts.sentDate ?? todayIso();
  const year = Number(sentDate.slice(0, 4));
  const at = opts.at ?? `${sentDate}T12:00:00Z`;

  return db.transaction(() => {
    const counter = db
      .prepare(
        `INSERT INTO offer_counters (year, last_seq) VALUES (?, 1)
         ON CONFLICT (year) DO UPDATE SET last_seq = last_seq + 1
         RETURNING last_seq`,
      )
      .get(year) as { last_seq: number };
    const number = `OFF-${year}-${String(counter.last_seq).padStart(4, '0')}`;
    db.prepare("UPDATE offers SET number = ?, status = 'sent', sent_at = ? WHERE id = ?").run(
      number,
      at,
      id,
    );
    addEvent(db, id, 'sent', opts.actor ?? 'admin', null, at);
    return { number, sent_at: at };
  })();
}

/**
 * Withdraw a sent offer before the customer decides. The number is kept
 * forever — withdrawal is a status plus an audit event, never a deletion.
 */
export function withdrawOffer(
  db: Database.Database,
  id: number,
  reason: string | null,
  opts: { actor?: string; at?: string; today?: string } = {},
): void {
  const offer = getOffer(db, id);
  const today = opts.today ?? todayIso();
  const status = derivedStatus(offer.status, offer.valid_until, today);
  if (offer.status !== 'sent') {
    throw new DomainError(409, `Only a sent offer can be withdrawn (status: ${status})`);
  }
  const at = opts.at ?? nowIso();
  db.prepare("UPDATE offers SET status = 'withdrawn' WHERE id = ?").run(id);
  addEvent(db, id, 'withdrawn', opts.actor ?? 'admin', reason, at);
}

export interface DecisionOptions {
  actor?: string;
  note?: string | null;
  at?: string;
  today?: string;
}

/**
 * Accept or reject a sent offer. This is the shared path for both the
 * admin API and the public acceptance link. Only an offer that is
 * currently `sent` and NOT expired can be decided; an expired or already
 * decided offer is a 409. The decision writes an append-only event and
 * flips the stored status.
 */
export function decideOffer(
  db: Database.Database,
  id: number,
  decision: 'accepted' | 'rejected',
  opts: DecisionOptions = {},
): void {
  const offer = getOffer(db, id);
  const today = opts.today ?? todayIso();
  const status = derivedStatus(offer.status, offer.valid_until, today);
  if (status === 'expired') {
    throw new DomainError(
      409,
      `This offer expired on ${offer.valid_until} and can no longer be ${decision === 'accepted' ? 'accepted' : 'rejected'}`,
    );
  }
  if (offer.status !== 'sent') {
    throw new DomainError(409, `Only a sent offer can be ${decision} (status: ${status})`);
  }
  const at = opts.at ?? nowIso();
  db.prepare('UPDATE offers SET status = ? WHERE id = ?').run(decision, id);
  addEvent(db, id, decision, opts.actor ?? 'admin', opts.note ?? null, at);
}

/**
 * Create a revision of a numbered offer. The revision is a fresh DRAFT
 * that copies the offer's content and points back at the superseded one
 * through `supersedes_id`; the original moves to `superseded` and keeps
 * its number. The chain is append-only — an already-superseded offer
 * cannot be revised again.
 */
export function reviseOffer(
  db: Database.Database,
  id: number,
  opts: { actor?: string; at?: string } = {},
): number {
  const offer = getOffer(db, id);
  if (offer.status === 'draft') {
    throw new DomainError(409, 'Drafts are still editable — no revision needed');
  }
  if (offer.status === 'superseded') {
    throw new DomainError(409, `${offer.number} was already revised`);
  }
  if (offer.status === 'withdrawn') {
    throw new DomainError(409, `${offer.number} was withdrawn and cannot be revised`);
  }
  const at = opts.at ?? nowIso();
  const lines = offerLines(db, offer.id);

  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO offers (customer_id, title, status, valid_until, intro, terms, supersedes_id, created_at)
         VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)`,
      )
      .run(offer.customer_id, offer.title, offer.valid_until, offer.intro, offer.terms, offer.id, at);
    const newId = Number(info.lastInsertRowid);
    writeLines(
      db,
      newId,
      lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unit_price_cents,
        vatRate: l.vat_rate,
        discountPercent: l.discount_percent,
      })),
    );
    addEvent(db, newId, 'created', opts.actor ?? 'admin', `Revision of ${offer.number}`, at);
    db.prepare("UPDATE offers SET status = 'superseded' WHERE id = ?").run(offer.id);
    addEvent(db, offer.id, 'superseded', opts.actor ?? 'admin', 'Replaced by a revision', at);
    return newId;
  })();
}
