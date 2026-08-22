import type Database from 'better-sqlite3';
import { DomainError } from './errors.js';
import { nowIso } from './connections.js';
import { bankProfile } from './bank-registry.js';
import type { BtfInput } from '../shared/types.js';

/**
 * Standing instructions: which BTFs the tick fetches, per connection.
 *
 * ## What this replaces
 *
 * `tick()` used to fetch two BTFs on every connection — the profile's payment
 * status report and its account statement — and nothing else. Everything else
 * a bank offers was reachable only through the operator's "fetch now" button:
 * intraday statements (camt.052), notifications (camt.054), fee statements
 * (camt.086), MT940, PDF statements, the Austrian customer-information message
 * (CIM). None of that was a protocol limitation. It was a hard-coded pair.
 *
 * A subscription is one row saying "fetch this BTF on every tick". So the
 * answer to "which BTFs does PS-12 support?" is now the same on the download
 * side as it always was on the upload side: **whichever ones the bank offers
 * and an operator subscribes to.**
 *
 * ## Where the legitimate values come from
 *
 * From `HTD`, not from this repository. `customer-data.ts` asks the bank which
 * order types and BTFs it has enabled for this contract, and
 * `availableDownloads` turns that answer straight into candidates for this
 * table. A transcribed mapping table is a starting suggestion; the bank's own
 * answer is the fact.
 *
 * ## The one rule
 *
 * **A subscription is identified by its BTF, canonically.** Two rows that
 * differ only in key order or in an explicit `undefined` would both poll, the
 * bank would answer both, and the second answer would collide on
 * `downloads(connection_id, sha256)` — a duplicate absorbed silently, so
 * nobody would notice the connection was doing twice the work. `btf_key` is
 * what makes that impossible.
 */

export interface Subscription {
  id: number;
  connection: string;
  btf: BtfInput;
  label: string | null;
  enabled: boolean;
  /** Ask for this many days back on each poll; null sends no DateRange. */
  lookback_days: number | null;
  created_at: string;
  last_fetched_at: string | null;
  /** What went wrong last time, cleared by a successful fetch. */
  last_problem: string | null;
}

interface SubscriptionRow {
  id: number;
  connection_id: number;
  btf: string;
  label: string | null;
  enabled: number;
  lookback_days: number | null;
  created_at: string;
  last_fetched_at: string | null;
  last_problem: string | null;
}

/**
 * The BTF's fields in a fixed order, as the row's identity.
 *
 * An array of pairs rather than an object, because `JSON.stringify` on an
 * object preserves insertion order — which is the caller's, and therefore not
 * an identity at all.
 */
const FIELDS = [
  'service_name',
  'scope',
  'option',
  'msg_name',
  'msg_version',
  'msg_variant',
  'msg_format',
  'container',
] as const;

export function canonicalBtf(btf: BtfInput): string {
  return JSON.stringify(FIELDS.filter((f) => btf[f] !== undefined).map((f) => [f, btf[f]]));
}

function connectionIdOf(db: Database.Database, key: string): number {
  const row = db.prepare('SELECT id FROM bank_connections WHERE key = ?').get(key) as { id: number } | undefined;
  if (row === undefined) throw new DomainError(404, `no connection "${key}"`);
  return row.id;
}

function toSubscription(connection: string, row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    connection,
    btf: JSON.parse(row.btf) as BtfInput,
    label: row.label,
    enabled: row.enabled === 1,
    lookback_days: row.lookback_days,
    created_at: row.created_at,
    last_fetched_at: row.last_fetched_at,
    last_problem: row.last_problem,
  };
}

export function listSubscriptions(db: Database.Database, connectionKey: string): Subscription[] {
  const id = connectionIdOf(db, connectionKey);
  const rows = db
    .prepare('SELECT * FROM download_subscriptions WHERE connection_id = ? ORDER BY id')
    .all(id) as SubscriptionRow[];
  return rows.map((row) => toSubscription(connectionKey, row));
}

/** What the tick actually polls: the enabled ones, in creation order. */
export function activeSubscriptions(
  db: Database.Database,
  connectionId: number,
): { id: number; btf: BtfInput; lookback_days: number | null }[] {
  const rows = db
    .prepare('SELECT id, btf, lookback_days FROM download_subscriptions WHERE connection_id = ? AND enabled = 1 ORDER BY id')
    .all(connectionId) as { id: number; btf: string; lookback_days: number | null }[];
  return rows.map((row) => ({ id: row.id, btf: JSON.parse(row.btf) as BtfInput, lookback_days: row.lookback_days }));
}

export interface SubscriptionInput {
  btf: BtfInput;
  label?: string;
  lookbackDays?: number;
  enabled?: boolean;
}

export function addSubscription(
  db: Database.Database,
  connectionKey: string,
  input: SubscriptionInput,
  now: () => string = nowIso,
): Subscription {
  const connectionId = connectionIdOf(db, connectionKey);
  if (input.btf.service_name.trim() === '' || input.btf.msg_name.trim() === '') {
    throw new DomainError(422, 'a subscription needs at least a service name and a message name');
  }
  if (input.lookbackDays !== undefined && (input.lookbackDays < 1 || input.lookbackDays > 3650)) {
    throw new DomainError(422, 'lookback_days must be between 1 and 3650');
  }

  const key = canonicalBtf(input.btf);
  const existing = db
    .prepare('SELECT id FROM download_subscriptions WHERE connection_id = ? AND btf_key = ?')
    .get(connectionId, key) as { id: number } | undefined;
  if (existing !== undefined) {
    throw new DomainError(409, 'this connection already fetches that BTF on every tick');
  }

  db.prepare(
    `INSERT INTO download_subscriptions (connection_id, btf, btf_key, label, enabled, lookback_days, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    connectionId,
    JSON.stringify(input.btf),
    key,
    input.label ?? null,
    input.enabled === false ? 0 : 1,
    input.lookbackDays ?? null,
    now(),
  );
  const rows = listSubscriptions(db, connectionKey);
  return rows[rows.length - 1] as Subscription;
}

export function setSubscriptionEnabled(
  db: Database.Database,
  connectionKey: string,
  id: number,
  enabled: boolean,
): Subscription {
  const connectionId = connectionIdOf(db, connectionKey);
  const info = db
    .prepare('UPDATE download_subscriptions SET enabled = ? WHERE id = ? AND connection_id = ?')
    .run(enabled ? 1 : 0, id, connectionId);
  if (info.changes === 0) throw new DomainError(404, `no subscription ${id} on "${connectionKey}"`);
  const row = db.prepare('SELECT * FROM download_subscriptions WHERE id = ?').get(id) as SubscriptionRow;
  return toSubscription(connectionKey, row);
}

export function removeSubscription(db: Database.Database, connectionKey: string, id: number): void {
  const connectionId = connectionIdOf(db, connectionKey);
  const info = db
    .prepare('DELETE FROM download_subscriptions WHERE id = ? AND connection_id = ?')
    .run(id, connectionId);
  if (info.changes === 0) throw new DomainError(404, `no subscription ${id} on "${connectionKey}"`);
}

/** Record what the last poll did, so a silently failing one is visible. */
export function recordPoll(db: Database.Database, id: number, at: string, problem: string | null): void {
  db.prepare('UPDATE download_subscriptions SET last_fetched_at = ?, last_problem = ? WHERE id = ?').run(
    at,
    problem,
    id,
  );
}

/**
 * The two a new connection starts with: its profile's status report and its
 * statement — exactly what the tick used to fetch for everyone.
 *
 * A starting point, not a ceiling. The operator adds the rest once `HTD` has
 * said what this bank actually offers.
 */
export function seedSubscriptions(
  db: Database.Database,
  connectionKey: string,
  bankKey: string,
  now: () => string = nowIso,
): void {
  const profile = bankProfile(bankKey);
  if (profile === undefined) return;
  for (const [label, btf] of [
    ['payment status reports', profile.paymentStatus],
    ['account statements', profile.statement],
  ] as const) {
    try {
      addSubscription(db, connectionKey, { btf, label }, now);
    } catch (err) {
      // A duplicate here means the seed ran twice, which is harmless. Anything
      // else is a real problem and should not be swallowed.
      if (!(err instanceof DomainError && err.status === 409)) throw err;
    }
  }
}
