import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';
import type { AuditEvent, AuditEventInput, ChainVerdict } from '../shared/types.js';

interface EventRow {
  id: number;
  actor: string;
  org: string | null;
  action: string;
  resource: string;
  before_json: string;
  after_json: string;
  metadata: string;
  prev_hash: string | null;
  hash: string;
  recorded_at: string;
  idempotency_key: string | null;
}

/**
 * The tamper-evident hash. Each event's hash covers its own content AND the
 * previous event's hash, so the log forms a chain: altering or removing any
 * past event breaks every hash after it, which `verifyChain` detects.
 */
export function computeHash(
  fields: {
    actor: string;
    org: string | null;
    action: string;
    resource: string;
    before_json: string;
    after_json: string;
    metadata: string;
    recorded_at: string;
  },
  prevHash: string | null,
): string {
  const canonical = [
    prevHash ?? '',
    fields.actor,
    fields.org ?? '',
    fields.action,
    fields.resource,
    fields.before_json,
    fields.after_json,
    fields.metadata,
    fields.recorded_at,
  ].join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

function mapEvent(row: EventRow): AuditEvent {
  return {
    id: row.id,
    actor: row.actor,
    org: row.org,
    action: row.action,
    resource: row.resource,
    before: JSON.parse(row.before_json),
    after: JSON.parse(row.after_json),
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    hash: row.hash,
    prev_hash: row.prev_hash,
    recorded_at: row.recorded_at,
  };
}

/** Append an event, chaining it to the current tail of the log. */
export function recordEvent(db: Database.Database, input: AuditEventInput, now = Date.now()): AuditEvent {
  const recordedAt = nowIso(now);
  const fields = {
    actor: input.actor,
    org: input.org ?? null,
    action: input.action,
    resource: input.resource,
    before_json: JSON.stringify(input.before ?? null),
    after_json: JSON.stringify(input.after ?? null),
    metadata: JSON.stringify(input.metadata ?? {}),
    recorded_at: recordedAt,
  };

  return db.transaction((): AuditEvent => {
    // Idempotent replay: the same key returns the original event untouched.
    if (input.idempotency_key) {
      const existing = findByIdempotencyKey(db, input.idempotency_key);
      if (existing) return existing;
    }
    const tail = db.prepare('SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1').get() as
      | { hash: string }
      | undefined;
    // With no live rows the chain continues from the RETENTION ANCHOR, not from
    // nothing: once retention has pruned every surviving event the table is
    // empty while the chain is not, and starting the next event at `null` links
    // it to a predecessor `verifyChain` does not believe in — leaving the log
    // permanently unverifiable, with nothing left to repair it from.
    const prevHash = tail?.hash ?? getAnchor(db);
    const hash = computeHash(fields, prevHash);
    const info = db
      .prepare(
        `INSERT INTO audit_events
           (actor, org, action, resource, before_json, after_json, metadata, prev_hash, hash, recorded_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fields.actor,
        fields.org,
        fields.action,
        fields.resource,
        fields.before_json,
        fields.after_json,
        fields.metadata,
        prevHash,
        hash,
        recordedAt,
        input.idempotency_key ?? null,
      );
    // Same transaction as the INSERT: the marker can never lag the log.
    setHead(db, hash);
    return mapEvent(db.prepare('SELECT * FROM audit_events WHERE id = ?').get(info.lastInsertRowid) as EventRow);
  })();
}

/** Look up a previously recorded event by its idempotency key. */
export function findByIdempotencyKey(db: Database.Database, key: string): AuditEvent | null {
  const row = db.prepare('SELECT * FROM audit_events WHERE idempotency_key = ?').get(key) as EventRow | undefined;
  return row ? mapEvent(row) : null;
}

export interface ListFilter {
  actor?: string;
  resource?: string;
  action?: string;
  org?: string;
  since?: string;
  limit?: number;
}

/** List events, newest first, with simple equality/`since` filters. */
export function listEvents(db: Database.Database, filter: ListFilter = {}): AuditEvent[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const [col, val] of [
    ['actor', filter.actor],
    ['resource', filter.resource],
    ['action', filter.action],
    ['org', filter.org],
  ] as const) {
    if (val !== undefined) {
      clauses.push(`${col} = ?`);
      params.push(val);
    }
  }
  if (filter.since !== undefined) {
    clauses.push('recorded_at >= ?');
    params.push(filter.since);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(1, filter.limit ?? 100), 1000);
  const rows = db
    .prepare(`SELECT * FROM audit_events ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as EventRow[];
  return rows.map(mapEvent);
}

const ANCHOR_KEY = 'retention_anchor';
const HEAD_KEY = 'chain_head';

function getMeta(db: Database.Database, key: string): string | undefined {
  return (db.prepare('SELECT value FROM audit_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT INTO audit_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/**
 * The hash the chain is known to end at.
 *
 * A hash chain proves that nothing in the MIDDLE of the log changed: rewrite or
 * remove an event and every hash after it stops matching. It says nothing about
 * events removed from the END — the survivors still form a perfectly valid
 * chain, which is precisely the edit an attacker covering their tracks would
 * make. `DELETE FROM audit_events WHERE id >= n` used to verify clean, and so
 * did wiping the table outright.
 *
 * So the head is recorded separately on every append, and verification checks
 * that the live chain still reaches it. Rewriting this marker as well means
 * recomputing the chain from the anchor — the same work tampering with any
 * other link already costs, which is the bar "tamper-evident" is claiming.
 *
 * Stored as the empty string for "chain is empty and nothing was pruned"
 * (i.e. `null`); ABSENT means a database predating this marker, whose head is
 * unknown and whose truncation therefore cannot be judged.
 */
export function getHead(db: Database.Database): string | null | undefined {
  const raw = getMeta(db, HEAD_KEY);
  if (raw === undefined) return undefined;
  return raw === '' ? null : raw;
}

function setHead(db: Database.Database, hash: string | null): void {
  setMeta(db, HEAD_KEY, hash ?? '');
}

/** The hash the live chain continues from — the last pruned event's hash, or
 *  null when nothing has been pruned. Lets verification survive retention. */
export function getAnchor(db: Database.Database): string | null {
  return getMeta(db, ANCHOR_KEY) ?? null;
}

function setAnchor(db: Database.Database, hash: string): void {
  setMeta(db, ANCHOR_KEY, hash);
}

export interface PruneResult {
  pruned: number;
  /** The anchor the live chain now verifies from (unchanged if nothing pruned). */
  anchor: string | null;
}

/**
 * Retention with integrity: delete events older than `retentionDays` and
 * advance the anchor to the hash of the last pruned event, so `verifyChain`
 * still validates the surviving events.
 *
 * The chain is ordered by `id`, so what gets deleted must be a PREFIX of it —
 * and `recorded_at` is only a proxy for that order. A clock that steps
 * backwards (NTP correction, a restored backup, an injected test clock) makes
 * the two disagree, and deleting by timestamp would then punch a hole in the
 * middle of the chain: every surviving event after the hole fails
 * verification, permanently, with nothing to repair it from. So the cutoff is
 * resolved to an id first, and the delete is expressed on the id.
 */
export function pruneForRetention(db: Database.Database, retentionDays: number, now = Date.now()): PruneResult {
  if (!retentionDays || retentionDays <= 0) return { pruned: 0, anchor: getAnchor(db) };
  const cutoff = nowIso(now - retentionDays * 86_400_000);
  const lastPruned = db
    .prepare('SELECT id, hash FROM audit_events WHERE recorded_at < ? ORDER BY id DESC LIMIT 1')
    .get(cutoff) as { id: number; hash: string } | undefined;
  if (!lastPruned) return { pruned: 0, anchor: getAnchor(db) };
  return db.transaction((): PruneResult => {
    const info = db.prepare('DELETE FROM audit_events WHERE id <= ?').run(lastPruned.id);
    setAnchor(db, lastPruned.hash);
    return { pruned: info.changes, anchor: lastPruned.hash };
  })();
}

/** Recompute the live chain and report the first broken link, if any.
 *  Starts from the retention anchor so pruning never breaks verification. */
export function verifyChain(db: Database.Database): ChainVerdict {
  const rows = db.prepare('SELECT * FROM audit_events ORDER BY id').all() as EventRow[];
  let prevHash: string | null = getAnchor(db);
  for (const row of rows) {
    const expected = computeHash(
      {
        actor: row.actor,
        org: row.org,
        action: row.action,
        resource: row.resource,
        before_json: row.before_json,
        after_json: row.after_json,
        metadata: row.metadata,
        recorded_at: row.recorded_at,
      },
      prevHash,
    );
    if (expected !== row.hash || row.prev_hash !== prevHash) {
      return { valid: false, count: rows.length, broken_at: row.id, broken_kind: 'link' };
    }
    prevHash = row.hash;
  }
  // Every link holds — but do the links still reach the head that was recorded
  // when the last event was appended? If not, the log was cut off at the end.
  const head = getHead(db);
  if (head !== undefined && head !== prevHash) {
    return { valid: false, count: rows.length, broken_kind: 'truncated' };
  }
  return { valid: true, count: rows.length };
}
