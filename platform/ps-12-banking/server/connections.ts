import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { DomainError } from './errors.js';
import { bankProfile } from './bank-registry.js';
import {
  assertKeyStoreReadable,
  certificatePemFor,
  generateSubscriberKeys,
  formatForLetter,
  privatePemFor,
  publicRecords,
} from './keystore.js';
import { Transport } from './transport.js';
import { buildHev, buildHia, buildHpb, buildIni, type Subscriber } from './ebics/envelopes.js';
import { parseHev, parseHpbOrderData, parseResponse } from './ebics/parse.js';
import type { EsVersion } from './ebics/crypto.js';
import type {
  BankKeyInfo,
  Connection,
  ConnectionDetail,
  ConnectionEvent,
  ConnectionState,
} from '../shared/types.js';

/**
 * Bank connections, and the key exchange that brings one to life.
 *
 * The lifecycle is a straight line with one deliberate stop in it:
 *
 *   created → keys_generated → ini_sent → hia_sent → hpb_fetched → ready
 *
 * Every step but the last is protocol. **The last one is a human.** `hpb_fetched`
 * means we hold keys the bank sent us; it does not mean they are the bank's.
 * Nothing in an HPB response can prove where it came from — an attacker in the
 * middle would send their own keys and read every payment file afterwards — so
 * the digests are shown to an operator, who compares them against the letter
 * the bank published, and only their confirmation moves the connection to
 * `ready`. Until then no order may be carried.
 *
 * The state is folded from `connection_events` at read time. There is no state
 * column, so it cannot disagree with what actually happened.
 */

export interface ConnectionInput {
  key: string;
  displayName: string;
  bankKey: string;
  url: string;
  hostId: string;
  partnerId: string;
  userId: string;
  esVersion?: EsVersion;
  debtorIban?: string | null;
  maxAmountMinor?: number;
  maxTransfers?: number;
}

interface ConnectionRow {
  id: number;
  key: string;
  display_name: string;
  bank_key: string;
  url: string;
  host_id: string;
  partner_id: string;
  user_id: string;
  ebics_version: string;
  es_version: string;
  debtor_iban: string | null;
  max_amount_minor: number;
  max_transfers: number;
  created_at: string;
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ── Events, and the state folded from them ────────────────────────────

export function recordEvent(
  db: Database.Database,
  params: { connectionId: number; type: string; actor?: string | null; meta?: Record<string, unknown>; at?: string },
): void {
  db.prepare(
    'INSERT INTO connection_events (connection_id, type, actor, meta, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    params.connectionId,
    params.type,
    params.actor ?? null,
    JSON.stringify(params.meta ?? {}),
    params.at ?? nowIso(),
  );
}

function eventsOf(db: Database.Database, connectionId: number): ConnectionEvent[] {
  const rows = db
    .prepare('SELECT type, actor, meta, created_at FROM connection_events WHERE connection_id = ? ORDER BY id')
    .all(connectionId) as { type: string; actor: string | null; meta: string; created_at: string }[];
  return rows.map((row) => ({
    type: row.type,
    actor: row.actor,
    meta: JSON.parse(row.meta) as Record<string, unknown>,
    created_at: row.created_at,
  }));
}

/**
 * Fold the event stream into a state.
 *
 * Order matters: `suspended` and `failed` are checked last so that they win
 * over the progress that came before them — a suspended connection that once
 * reached `ready` is suspended, not ready.
 */
export function foldState(events: ConnectionEvent[]): ConnectionState {
  let state: ConnectionState = 'created';
  // The last state the connection reached under its own steam, so a `failed`
  // event can be stepped back out of. Without this, one transient error from
  // the bank during setup left a connection stuck at `failed` with no route
  // out — and the key is UNIQUE with no delete, so the only remedy was
  // editing the database by hand.
  let lastGood: ConnectionState = 'created';
  for (const event of events) {
    switch (event.type) {
      case 'keys_generated':
        state = 'keys_generated';
        break;
      case 'ini_sent':
        state = 'ini_sent';
        break;
      case 'hia_sent':
        state = 'hia_sent';
        break;
      case 'hpb_fetched':
        state = 'hpb_fetched';
        break;
      case 'bank_keys_verified':
        state = 'ready';
        break;
      case 'suspended':
        state = 'suspended';
        break;
      case 'resumed':
        state = 'ready';
        break;
      case 'failed':
        state = 'failed';
        break;
      case 'cleared':
        // An operator acknowledged the failure. The connection goes back to
        // the last step it actually completed — never forward, so a failure
        // during HPB cannot be cleared into `ready`.
        state = lastGood;
        break;
      default:
        break;
    }
    // Recorded AFTER the event is applied, so it is the state the connection
    // actually reached — not the one it was in beforehand.
    if (event.type !== 'failed') lastGood = state;
  }
  return state;
}

// ── Reading ───────────────────────────────────────────────────────────

function rowByKey(db: Database.Database, key: string): ConnectionRow {
  const row = db.prepare('SELECT * FROM bank_connections WHERE key = ?').get(key) as ConnectionRow | undefined;
  if (row === undefined) throw new DomainError(404, `no bank connection named "${key}"`);
  return row;
}

function toConnection(db: Database.Database, row: ConnectionRow): Connection {
  return {
    key: row.key,
    display_name: row.display_name,
    bank_key: row.bank_key,
    url: row.url,
    host_id: row.host_id,
    partner_id: row.partner_id,
    user_id: row.user_id,
    ebics_version: row.ebics_version,
    es_version: row.es_version,
    debtor_iban: row.debtor_iban,
    max_amount_minor: row.max_amount_minor,
    max_transfers: row.max_transfers,
    state: foldState(eventsOf(db, row.id)),
    created_at: row.created_at,
  };
}

export function listConnections(db: Database.Database): Connection[] {
  const rows = db.prepare('SELECT * FROM bank_connections ORDER BY key').all() as ConnectionRow[];
  return rows.map((row) => toConnection(db, row));
}

export function connectionDetail(db: Database.Database, key: string): ConnectionDetail {
  const row = rowByKey(db, key);
  return {
    ...toConnection(db, row),
    keys: publicRecords(db, row.id),
    bank_keys: bankKeysOf(db, row.id),
    events: eventsOf(db, row.id),
  };
}

function bankKeysOf(db: Database.Database, connectionId: number): BankKeyInfo[] {
  const rows = db
    .prepare(
      `SELECT purpose, version, digest, fetched_at, verified_at, verified_by
       FROM bank_keys WHERE connection_id = ? ORDER BY purpose`,
    )
    .all(connectionId) as Omit<BankKeyInfo, 'digestFormatted'>[];
  return rows.map((row) => ({ ...row, digestFormatted: formatForLetter(row.digest) }));
}

/** The internal handle: the row plus its folded state. */
function loaded(db: Database.Database, key: string): { row: ConnectionRow; state: ConnectionState } {
  const row = rowByKey(db, key);
  return { row, state: foldState(eventsOf(db, row.id)) };
}

function subscriberOf(row: ConnectionRow): Subscriber {
  return { hostId: row.host_id, partnerId: row.partner_id, userId: row.user_id };
}

// ── Creating ──────────────────────────────────────────────────────────

export function createConnection(db: Database.Database, input: ConnectionInput, actor?: string): Connection {
  const existing = db.prepare('SELECT id FROM bank_connections WHERE key = ?').get(input.key);
  if (existing !== undefined) throw new DomainError(409, `a connection named "${input.key}" already exists`);

  // A typo'd profile would otherwise be discovered at the first upload, as a
  // BTF the bank does not recognise.
  if (bankProfile(input.bankKey) === undefined) {
    throw new DomainError(422, 'this bank profile is not one this service knows', [
      { field: 'bank_key', message: `unknown profile "${input.bankKey}" — see GET /api/banks` },
    ]);
  }

  const now = nowIso();
  const id = db.transaction((): number => {
    const info = db
      .prepare(
        `INSERT INTO bank_connections
           (key, display_name, bank_key, url, host_id, partner_id, user_id, ebics_version, es_version,
            debtor_iban, max_amount_minor, max_transfers, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'H005', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.key,
        input.displayName,
        input.bankKey,
        input.url,
        input.hostId,
        input.partnerId,
        input.userId,
        input.esVersion ?? 'A005',
        input.debtorIban ?? null,
        input.maxAmountMinor ?? 100_000_000,
        input.maxTransfers ?? 500,
        now,
      );
    const connectionId = Number(info.lastInsertRowid);
    recordEvent(db, { connectionId, type: 'created', actor, at: now });
    return connectionId;
  })();

  return toConnection(db, db.prepare('SELECT * FROM bank_connections WHERE id = ?').get(id) as ConnectionRow);
}

// ── The key exchange ──────────────────────────────────────────────────

export interface ExchangeContext {
  db: Database.Database;
  keySecret: Buffer;
  transport: Transport;
  actor?: string;
  /** Injectable so envelopes stay reproducible in tests. */
  now?: () => string;
}

/**
 * Generate our three key pairs. Once per connection: a second set would orphan
 * whatever the bank was already told, and nothing inside this service could
 * detect that had happened.
 */
export function generateKeys(ctx: ExchangeContext, key: string): ConnectionDetail {
  const { row, state } = loaded(ctx.db, key);
  if (state !== 'created') {
    throw new DomainError(409, `this connection is ${state}; keys can only be generated once, at the start`);
  }
  const at = (ctx.now ?? nowIso)();
  generateSubscriberKeys(ctx.db, {
    connectionId: row.id,
    keySecret: ctx.keySecret,
    esVersion: row.es_version as EsVersion,
    now: at,
    subject: { partnerId: row.partner_id, userId: row.user_id },
  });
  recordEvent(ctx.db, { connectionId: row.id, type: 'keys_generated', actor: ctx.actor, at });
  return connectionDetail(ctx.db, key);
}

/**
 * Ask a bank which protocol versions it speaks. Pure diagnostics, and the one
 * call that works before anything is set up.
 *
 * The host id comes from the connection rather than the response: an
 * `ebicsHEVResponse` carries the versions and a system return code, not the
 * host — the client already knows which host it asked about.
 */
export async function probeVersions(
  ctx: ExchangeContext,
  key: string,
): Promise<{ hostId: string; versions: { protocol: string; revision: string }[] }> {
  const { row } = loaded(ctx.db, key);
  const body = await ctx.transport.send(row.url, buildHev(row.host_id));
  return { hostId: row.host_id, versions: parseHev(body).versions };
}

/** INI — send the electronic signature key. */
export async function sendIni(ctx: ExchangeContext, key: string): Promise<ConnectionDetail> {
  const { row, state } = loaded(ctx.db, key);
  if (state !== 'keys_generated') {
    throw new DomainError(409, `INI expects a connection with fresh keys; this one is ${state}`);
  }
  const at = (ctx.now ?? nowIso)();
  const body = buildIni({
    subscriber: subscriberOf(row),
    esCertificatePem: certificatePemFor(ctx.db, { connectionId: row.id, purpose: 'ES' }),
    esVersion: row.es_version as EsVersion,
    timestamp: at,
  });
  await exchange(ctx, row, body, 'ini_sent', at);
  return connectionDetail(ctx.db, key);
}

/** HIA — send the authentication and encryption keys. */
export async function sendHia(ctx: ExchangeContext, key: string): Promise<ConnectionDetail> {
  const { row, state } = loaded(ctx.db, key);
  if (state !== 'ini_sent') {
    throw new DomainError(409, `HIA follows INI; this connection is ${state}`);
  }
  const at = (ctx.now ?? nowIso)();
  const body = buildHia({
    subscriber: subscriberOf(row),
    authCertificatePem: certificatePemFor(ctx.db, { connectionId: row.id, purpose: 'AUTH' }),
    encCertificatePem: certificatePemFor(ctx.db, { connectionId: row.id, purpose: 'ENC' }),
    timestamp: at,
  });
  await exchange(ctx, row, body, 'hia_sent', at);
  return connectionDetail(ctx.db, key);
}

/**
 * HPB — fetch the bank's keys.
 *
 * Stores them and records their digests. It does NOT make the connection
 * usable: see `verifyBankKeys`, which is the human step this exists to set up.
 */
export async function fetchBankKeys(ctx: ExchangeContext, key: string): Promise<ConnectionDetail> {
  const { row, state } = loaded(ctx.db, key);
  // `ready` is allowed on purpose: a bank rotates its own keys, and refetching
  // is how an operator picks that up. It moves the connection BACKWARDS to
  // unverified — the safe direction — never forwards.
  if (state !== 'hia_sent' && state !== 'hpb_fetched' && state !== 'ready') {
    throw new DomainError(
      409,
      `HPB follows HIA, once the bank has processed your INI letter; this connection is ${state}`,
    );
  }

  const at = (ctx.now ?? nowIso)();
  const authKey = privatePemFor(ctx.db, { connectionId: row.id, purpose: 'AUTH', keySecret: ctx.keySecret });
  const esKey = privatePemFor(ctx.db, { connectionId: row.id, purpose: 'ES', keySecret: ctx.keySecret });
  const encKey = privatePemFor(ctx.db, { connectionId: row.id, purpose: 'ENC', keySecret: ctx.keySecret });

  const body = buildHpb({
    subscriber: subscriberOf(row),
    keys: {
      esPrivatePem: esKey.pem,
      esVersion: row.es_version as EsVersion,
      authPrivatePem: authKey.pem,
      encPrivatePem: encKey.pem,
    },
    timestamp: at,
  });

  const raw = await ctx.transport.send(row.url, body);
  // Not verified against a bank key: this is the request that fetches them.
  const response = parseResponse(raw);
  if (!response.verdict.ok) {
    recordEvent(ctx.db, {
      connectionId: row.id,
      type: 'failed',
      actor: ctx.actor,
      meta: { step: 'hpb', code: response.verdict.technical.code, message: response.verdict.message },
      at,
    });
    throw new DomainError(502, response.verdict.message);
  }
  if (response.orderData === null) throw new DomainError(502, 'the bank returned no keys');

  const keys = parseHpbOrderData(Buffer.from(response.orderData, 'base64').toString('utf8'));

  ctx.db.transaction(() => {
    const upsert = ctx.db.prepare(
      `INSERT INTO bank_keys (connection_id, purpose, version, public_pem, digest, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection_id, purpose) DO UPDATE SET
         version = excluded.version, public_pem = excluded.public_pem,
         digest = excluded.digest, fetched_at = excluded.fetched_at,
         -- A re-fetch CLEARS the verification: new keys have not been
         -- confirmed by anyone, and silently keeping the old tick would let a
         -- substituted key inherit a human's approval.
         verified_at = NULL, verified_by = NULL`,
    );
    upsert.run(row.id, 'AUTH', keys.authentication.version, keys.authentication.pem,
      keys.authentication.digest.toString('base64'), at);
    upsert.run(row.id, 'ENC', keys.encryption.version, keys.encryption.pem,
      keys.encryption.digest.toString('base64'), at);
    recordEvent(ctx.db, {
      connectionId: row.id,
      type: 'hpb_fetched',
      actor: ctx.actor,
      meta: {
        auth_digest: formatForLetter(keys.authentication.digest.toString('base64')),
        enc_digest: formatForLetter(keys.encryption.digest.toString('base64')),
      },
      at,
    });
  })();

  return connectionDetail(ctx.db, key);
}

/**
 * The human step: confirm the bank's key digests against its published letter.
 *
 * This is the only place a connection becomes usable, and the check is
 * deliberately a comparison of what the operator TYPED against what was
 * stored. Accepting "yes, looks right" without the values would make the whole
 * exchange trust itself, which is exactly what it must not do.
 *
 * Whitespace and case are normalised, because the operator is copying a value
 * off a printed page and the grouping is presentation.
 */
export function verifyBankKeys(
  ctx: ExchangeContext,
  key: string,
  claimed: { authDigest: string; encDigest: string },
): ConnectionDetail {
  const { row, state } = loaded(ctx.db, key);
  if (state !== 'hpb_fetched') {
    throw new DomainError(409, `there are no freshly fetched bank keys to confirm; this connection is ${state}`);
  }

  const stored = ctx.db
    .prepare('SELECT purpose, digest FROM bank_keys WHERE connection_id = ?')
    .all(row.id) as { purpose: string; digest: string }[];

  const normalise = (value: string): string => value.replace(/[\s:-]/g, '').toUpperCase();
  const hexOf = (base64: string): string => Buffer.from(base64, 'base64').toString('hex').toUpperCase();

  const mismatches: string[] = [];
  for (const [purpose, typed] of [
    ['AUTH', claimed.authDigest],
    ['ENC', claimed.encDigest],
  ] as const) {
    const row2 = stored.find((s) => s.purpose === purpose);
    if (row2 === undefined) {
      mismatches.push(`${purpose}: no key was fetched`);
      continue;
    }
    if (normalise(typed) !== hexOf(row2.digest)) mismatches.push(purpose);
  }

  if (mismatches.length > 0) {
    // A mismatch is not a typo to shrug at: it is what a substituted key looks
    // like. It is recorded, and the connection stays unusable.
    const at = (ctx.now ?? nowIso)();
    recordEvent(ctx.db, {
      connectionId: row.id,
      type: 'bank_keys_rejected',
      actor: ctx.actor,
      meta: { mismatched: mismatches },
      at,
    });
    throw new DomainError(
      409,
      `the digests do not match what the bank sent (${mismatches.join(', ')}). ` +
        'Do not proceed: fetch the keys again and compare against the bank’s own letter.',
    );
  }

  const at = (ctx.now ?? nowIso)();
  ctx.db.transaction(() => {
    ctx.db
      .prepare('UPDATE bank_keys SET verified_at = ?, verified_by = ? WHERE connection_id = ?')
      .run(at, ctx.actor ?? null, row.id);
    recordEvent(ctx.db, { connectionId: row.id, type: 'bank_keys_verified', actor: ctx.actor, at });
  })();

  return connectionDetail(ctx.db, key);
}

export function suspend(ctx: ExchangeContext, key: string, reason: string): ConnectionDetail {
  const { row, state } = loaded(ctx.db, key);
  if (state === 'suspended') throw new DomainError(409, 'this connection is already suspended');
  recordEvent(ctx.db, {
    connectionId: row.id,
    type: 'suspended',
    actor: ctx.actor,
    meta: { reason },
    at: (ctx.now ?? nowIso)(),
  });
  return connectionDetail(ctx.db, key);
}

/**
 * Step a connection back out of `failed` so the setup can be retried.
 *
 * A `failed` event is recorded whenever the bank refuses a setup message, and
 * plenty of those are transient — a host that was down, a subscriber the bank
 * had not activated yet, a typo in the partner id since corrected. Before this
 * existed, any one of them ended the connection permanently: every lifecycle
 * route answered 409, `bank_connections.key` is UNIQUE, and there is no delete
 * route, so the only way out was editing the database by hand.
 *
 * It moves BACKWARDS, to the last step actually completed. Clearing a failure
 * can never be a way to reach `ready` without a human confirming the bank's
 * digests, which is the one thing this whole service is built around.
 */
export function clearFailure(ctx: ExchangeContext, key: string): ConnectionDetail {
  const { row, state } = loaded(ctx.db, key);
  if (state !== 'failed') throw new DomainError(409, `this connection is ${state}, not failed`);
  recordEvent(ctx.db, { connectionId: row.id, type: 'cleared', actor: ctx.actor, at: (ctx.now ?? nowIso)() });
  return connectionDetail(ctx.db, key);
}

export function resume(ctx: ExchangeContext, key: string): ConnectionDetail {
  const { row, state } = loaded(ctx.db, key);
  if (state !== 'suspended') throw new DomainError(409, `this connection is ${state}, not suspended`);
  const verified = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM bank_keys WHERE connection_id = ? AND verified_at IS NOT NULL')
    .get(row.id) as { n: number };
  if (verified.n < 2) {
    throw new DomainError(409, 'the bank keys are no longer confirmed — fetch and verify them again');
  }
  recordEvent(ctx.db, { connectionId: row.id, type: 'resumed', actor: ctx.actor, at: (ctx.now ?? nowIso)() });
  return connectionDetail(ctx.db, key);
}

/**
 * The gate every order passes: a connection must be `ready`, which can only be
 * reached through a human confirmation of the bank's keys.
 */
export function requireReady(db: Database.Database, key: string): ConnectionRow {
  const { row, state } = loaded(db, key);
  if (state === 'ready') return row;
  if (state === 'hpb_fetched') {
    throw new DomainError(
      409,
      'the bank’s keys have been fetched but nobody has confirmed them against the bank’s letter yet',
    );
  }
  throw new DomainError(409, `this connection is ${state} and cannot carry an order`);
}

/** Send one setup message and record the outcome. */
async function exchange(
  ctx: ExchangeContext,
  row: ConnectionRow,
  body: string,
  successEvent: string,
  at: string,
): Promise<void> {
  const raw = await ctx.transport.send(row.url, body);
  const response = parseResponse(raw);
  if (!response.verdict.ok) {
    recordEvent(ctx.db, {
      connectionId: row.id,
      type: 'failed',
      actor: ctx.actor,
      meta: { step: successEvent, code: response.verdict.technical.code, message: response.verdict.message },
      at,
    });
    throw new DomainError(502, response.verdict.message);
  }
  recordEvent(ctx.db, { connectionId: row.id, type: successEvent, actor: ctx.actor, at });
}

/** A public id for anything a module quotes back to us. */
export function publicId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export { assertKeyStoreReadable };
