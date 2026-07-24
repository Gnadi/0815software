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
    const tail = db.prepare('SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1').get() as
      | { hash: string }
      | undefined;
    const prevHash = tail?.hash ?? null;
    const hash = computeHash(fields, prevHash);
    const info = db
      .prepare(
        `INSERT INTO audit_events
           (actor, org, action, resource, before_json, after_json, metadata, prev_hash, hash, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    return mapEvent(db.prepare('SELECT * FROM audit_events WHERE id = ?').get(info.lastInsertRowid) as EventRow);
  })();
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

/** Recompute the whole chain and report the first broken link, if any. */
export function verifyChain(db: Database.Database): ChainVerdict {
  const rows = db.prepare('SELECT * FROM audit_events ORDER BY id').all() as EventRow[];
  let prevHash: string | null = null;
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
      return { valid: false, count: rows.length, broken_at: row.id };
    }
    prevHash = row.hash;
  }
  return { valid: true, count: rows.length };
}
