import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';
import { DomainError } from './errors.js';
import type { PaymentProvider } from './providers/index.js';
import type {
  IntentEvent,
  IntentStatus,
  LedgerEntry,
  PaymentIntent,
  PaymentIntentDetail,
} from '../shared/types.js';

interface IntentRow {
  id: number;
  public_id: string;
  reference: string;
  provider: string;
  amount_minor: number;
  currency: string;
  idempotency_key: string | null;
  created_at: string;
}

interface EventRow {
  id: number;
  intent_id: number;
  type: string;
  amount_minor: number | null;
  meta: string;
  created_at: string;
}

function eventsOf(db: Database.Database, intentId: number): EventRow[] {
  return db.prepare('SELECT * FROM intent_events WHERE intent_id = ? ORDER BY id').all(intentId) as EventRow[];
}

function appendEvent(
  db: Database.Database,
  intentId: number,
  type: string,
  now: number,
  amountMinor: number | null = null,
): void {
  db.prepare('INSERT INTO intent_events (intent_id, type, amount_minor, meta, created_at) VALUES (?, ?, ?, ?, ?)').run(
    intentId,
    type,
    amountMinor,
    '{}',
    nowIso(now),
  );
}

function ledgerEntry(
  db: Database.Database,
  intentId: number,
  direction: 'credit' | 'debit',
  amountMinor: number,
  reason: string,
  now: number,
): void {
  db.prepare(
    'INSERT INTO ledger_entries (intent_id, direction, amount_minor, reason, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(intentId, direction, amountMinor, reason, nowIso(now));
}

/** Fold the append-only event stream into a status + refunded total. */
export function foldStatus(events: EventRow[], amountMinor: number): { status: IntentStatus; refunded: number } {
  let refunded = 0;
  let succeeded = false;
  let processing = false;
  let failed = false;
  let canceled = false;
  for (const e of events) {
    if (e.type === 'processing') processing = true;
    else if (e.type === 'succeeded') succeeded = true;
    else if (e.type === 'failed') failed = true;
    else if (e.type === 'canceled') canceled = true;
    else if (e.type === 'refunded') refunded += e.amount_minor ?? 0;
  }
  if (canceled && !succeeded) return { status: 'canceled', refunded };
  if (succeeded) {
    if (refunded >= amountMinor) return { status: 'refunded', refunded };
    if (refunded > 0) return { status: 'partially_refunded', refunded };
    return { status: 'succeeded', refunded };
  }
  if (failed) return { status: 'failed', refunded };
  if (processing) return { status: 'processing', refunded };
  return { status: 'requires_payment', refunded };
}

function mapIntent(db: Database.Database, row: IntentRow): PaymentIntent {
  const { status, refunded } = foldStatus(eventsOf(db, row.id), row.amount_minor);
  return {
    id: row.id,
    public_id: row.public_id,
    reference: row.reference,
    provider: row.provider,
    amount_minor: row.amount_minor,
    currency: row.currency,
    status,
    amount_refunded_minor: refunded,
    created_at: row.created_at,
  };
}

export function intentDetail(db: Database.Database, row: IntentRow): PaymentIntentDetail {
  const events = eventsOf(db, row.id).map(
    (e): IntentEvent => ({ id: e.id, type: e.type, amount_minor: e.amount_minor, created_at: e.created_at }),
  );
  const ledger = db.prepare('SELECT * FROM ledger_entries WHERE intent_id = ? ORDER BY id').all(row.id) as LedgerEntry[];
  return { ...mapIntent(db, row), events, ledger };
}

export function getIntentRow(db: Database.Database, id: number): IntentRow {
  const row = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(id) as IntentRow | undefined;
  if (!row) throw new DomainError(404, 'Payment intent not found');
  return row;
}

export function getByPublicId(db: Database.Database, publicId: string): IntentRow | undefined {
  return db.prepare('SELECT * FROM payment_intents WHERE public_id = ?').get(publicId) as IntentRow | undefined;
}

const CURRENCY_RE = /^[A-Za-z]{3}$/;

/** Create an intent. Idempotent on idempotency_key; a replay with a different amount is a 409. */
export function createIntent(
  db: Database.Database,
  opts: { reference: string; amountMinor: number; currency: string; provider: string; idempotencyKey: string | null },
  now = Date.now(),
): { row: IntentRow; created: boolean } {
  if (!Number.isInteger(opts.amountMinor) || opts.amountMinor <= 0) {
    throw new DomainError(422, 'Validation failed', [{ field: 'amount_minor', message: 'must be a positive integer' }]);
  }
  if (!CURRENCY_RE.test(opts.currency)) {
    throw new DomainError(422, 'Validation failed', [{ field: 'currency', message: 'must be a 3-letter code' }]);
  }
  if (opts.idempotencyKey) {
    const existing = db
      .prepare('SELECT * FROM payment_intents WHERE idempotency_key = ?')
      .get(opts.idempotencyKey) as IntentRow | undefined;
    if (existing) {
      if (existing.amount_minor !== opts.amountMinor || existing.currency !== opts.currency.toUpperCase()) {
        throw new DomainError(409, 'Idempotency key already used with a different amount/currency');
      }
      return { row: existing, created: false };
    }
  }
  const publicId = `pi_${randomBytes(10).toString('hex')}`;
  const info = db
    .prepare(
      `INSERT INTO payment_intents (public_id, reference, provider, amount_minor, currency, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(publicId, opts.reference, opts.provider, opts.amountMinor, opts.currency.toUpperCase(), opts.idempotencyKey, nowIso(now));
  const id = Number(info.lastInsertRowid);
  appendEvent(db, id, 'created', now);
  return { row: getIntentRow(db, id), created: true };
}

/** Mark a succeeded settlement: append the event and credit the ledger once. */
function settle(db: Database.Database, row: IntentRow, now: number): void {
  const { status } = foldStatus(eventsOf(db, row.id), row.amount_minor);
  if (status === 'succeeded' || status === 'refunded' || status === 'partially_refunded') return; // already settled
  appendEvent(db, row.id, 'succeeded', now);
  ledgerEntry(db, row.id, 'credit', row.amount_minor, 'capture', now);
}

/** Confirm an intent with its provider. Mock → processing; a synchronous provider → succeeded. */
export async function confirmIntent(
  db: Database.Database,
  provider: PaymentProvider,
  row: IntentRow,
  now = Date.now(),
): Promise<void> {
  const { status } = foldStatus(eventsOf(db, row.id), row.amount_minor);
  if (status !== 'requires_payment') throw new DomainError(422, `Cannot confirm an intent that is ${status}`);
  appendEvent(db, row.id, 'processing', now);
  const result = await provider.confirm({ public_id: row.public_id, amount_minor: row.amount_minor, currency: row.currency });
  if (result.settled) settle(db, row, now);
}

/** Settle every mock intent that is still processing (drives async settlement). */
export function settleProcessing(db: Database.Database, now = Date.now()): number {
  const rows = db.prepare(`SELECT * FROM payment_intents WHERE provider = 'mock'`).all() as IntentRow[];
  let settled = 0;
  for (const row of rows) {
    const { status } = foldStatus(eventsOf(db, row.id), row.amount_minor);
    if (status === 'processing') {
      settle(db, row, now);
      settled++;
    }
  }
  return settled;
}

/**
 * Refund (full or partial) a succeeded intent.
 *
 * The refundable balance is claimed BEFORE the provider call, in one
 * synchronous step. Checking the balance and only then awaiting the PSP would
 * leave a window in which a second concurrent refund reads the same balance
 * and passes the same check — two requests for the full amount would then both
 * be accepted and the intent would be refunded twice over. If the provider
 * rejects the refund, the claim is rolled back.
 */
export async function refundIntent(
  db: Database.Database,
  provider: PaymentProvider,
  row: IntentRow,
  amountMinor: number | undefined,
  now = Date.now(),
  idempotencyKey: string | null = null,
): Promise<void> {
  if (idempotencyKey !== null) {
    const seen = db.prepare('SELECT intent_id, amount_minor FROM refund_idempotency WHERE key = ?').get(idempotencyKey) as
      | { intent_id: number; amount_minor: number }
      | undefined;
    if (seen) {
      // A replay of the same refund is a no-op; the same key for a different
      // refund is a caller bug worth reporting rather than guessing at.
      if (seen.intent_id !== row.id || (amountMinor !== undefined && seen.amount_minor !== amountMinor)) {
        throw new DomainError(409, 'Idempotency key already used for a different refund');
      }
      return;
    }
  }

  const { eventId, ledgerId, amount } = db.transaction(() => {
    const { status, refunded } = foldStatus(eventsOf(db, row.id), row.amount_minor);
    if (status !== 'succeeded' && status !== 'partially_refunded') {
      throw new DomainError(422, `Only a captured payment can be refunded (status ${status})`);
    }
    const remaining = row.amount_minor - refunded;
    const claimed = amountMinor ?? remaining;
    if (!Number.isInteger(claimed) || claimed <= 0) {
      throw new DomainError(422, 'Validation failed', [
        { field: 'amount_minor', message: 'must be a positive integer' },
      ]);
    }
    if (claimed > remaining) {
      throw new DomainError(422, `Refund exceeds the refundable balance (${remaining})`);
    }
    appendEvent(db, row.id, 'refunded', now, claimed);
    ledgerEntry(db, row.id, 'debit', claimed, 'refund', now);
    // The key is claimed with the balance: a concurrent replay of the same key
    // hits the primary key here rather than reaching the provider twice.
    if (idempotencyKey !== null) {
      db.prepare('INSERT INTO refund_idempotency (key, intent_id, amount_minor, created_at) VALUES (?, ?, ?, ?)').run(
        idempotencyKey,
        row.id,
        claimed,
        nowIso(now),
      );
    }
    const event = db.prepare('SELECT MAX(id) AS id FROM intent_events WHERE intent_id = ?').get(row.id) as { id: number };
    const ledger = db.prepare('SELECT MAX(id) AS id FROM ledger_entries WHERE intent_id = ?').get(row.id) as { id: number };
    return { eventId: event.id, ledgerId: ledger.id, amount: claimed };
  })();

  try {
    await provider.refund({ public_id: row.public_id }, amount);
  } catch (err) {
    // The money never moved, so neither should the record of it — including
    // the idempotency claim, or a legitimate retry would be swallowed.
    db.transaction(() => {
      db.prepare('DELETE FROM intent_events WHERE id = ?').run(eventId);
      db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(ledgerId);
      if (idempotencyKey !== null) db.prepare('DELETE FROM refund_idempotency WHERE key = ?').run(idempotencyKey);
    })();
    throw err;
  }
}

/** Reconcile a settlement signalled by an inbound PSP webhook. */
export function reconcileSucceeded(db: Database.Database, publicId: string, now = Date.now()): boolean {
  const row = getByPublicId(db, publicId);
  if (!row) return false;
  settle(db, row, now);
  return true;
}

export function reconcileFailed(db: Database.Database, publicId: string, now = Date.now()): boolean {
  const row = getByPublicId(db, publicId);
  if (!row) return false;
  const { status } = foldStatus(eventsOf(db, row.id), row.amount_minor);
  if (status === 'processing' || status === 'requires_payment') appendEvent(db, row.id, 'failed', now);
  return true;
}

export function listIntents(db: Database.Database): PaymentIntent[] {
  const rows = db.prepare('SELECT * FROM payment_intents ORDER BY id DESC').all() as IntentRow[];
  return rows.map((r) => mapIntent(db, r));
}

export function listLedger(db: Database.Database): LedgerEntry[] {
  return db.prepare('SELECT * FROM ledger_entries ORDER BY id DESC').all() as LedgerEntry[];
}
