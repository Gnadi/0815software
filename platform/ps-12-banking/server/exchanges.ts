import type Database from 'better-sqlite3';

import { DomainError } from './errors.js';
import { chainAppend, markPruned } from './chain.js';

/**
 * The bank conversation log.
 *
 * Everything else in this service records what a bank round-trip *meant*: an
 * order event says `rejected` with a code, a connection event says
 * `hpb_fetched`. That is the right shape for driving the machine, and it is
 * the wrong shape for the one conversation this service exists to survive —
 * the bank saying "we never received it", or "your signature did not verify",
 * about a payment that has already left. A parsed verdict cannot be shown to
 * anybody. The bytes can.
 *
 * So every POST to a bank lands here, whole: the envelope as sent, the answer
 * as received, the HTTP status, the wall-clock window it occupied, and — when
 * the conversation never completed — why. `Transport` is the single place
 * that talks to a bank, which is what makes "every" a claim and not a hope.
 *
 * **On keeping the bytes.** An EBICS envelope carries the authentication
 * signature, the ES signature over the order data, and the order data itself
 * encrypted under a transaction key that is itself encrypted to the bank. It
 * never carries a private key: `keystore.ts` decrypts one into memory to sign
 * and nothing serialises it. Storing an envelope therefore adds no secret to
 * the database that is not already in it — and `test/exchanges.test.ts` pins
 * that by asserting no stored exchange contains PEM private-key material.
 */

/** What a conversation was for. Free-form, but written as `area.phase`. */
export interface ExchangeScope {
  /** The connection this belongs to, when the caller knows it. */
  connection?: number | null;
  /** The order this belongs to, for the phases that carry one. */
  order?: number | null;
  /** e.g. `order.initialisation`, `hpb`, `download.transfer`. */
  phase: string;
}

export interface ExchangeRecord extends ExchangeScope {
  url: string;
  request: string;
  response: string | null;
  httpStatus: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

/** The seam `Transport` writes through. Tests pass a collector; boot passes SQLite. */
export type ExchangeRecorder = (record: ExchangeRecord) => void;

/**
 * Persist exchanges into the database.
 *
 * Deliberately swallows its own failures. A conversation with a bank must not
 * fail because its audit copy could not be written — the payment is the point
 * and the log is the record of it; losing the record is bad, and turning a
 * successful payment into an exception because of it is worse.
 */
export function sqliteRecorder(db: Database.Database): ExchangeRecorder {
  const insert = db.prepare(
    `INSERT INTO bank_exchanges
       (connection_id, order_id, phase, url, request, response, http_status, error,
        started_at, finished_at, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const append = db.transaction((record: ExchangeRecord) => {
    const info = insert.run(
      record.connection ?? null,
      record.order ?? null,
      record.phase,
      record.url,
      record.request,
      record.response,
      record.httpStatus,
      record.error,
      record.startedAt,
      record.finishedAt,
      record.durationMs,
    );
    // Insert and chain link together — see `recordOrderEvent`.
    chainAppend(db, 'bank_exchanges', Number(info.lastInsertRowid), () => record.finishedAt);
  });
  return (record) => {
    try {
      append(record);
    } catch (err) {
      console.warn(`[ps-12] a bank exchange could not be recorded: ${err instanceof Error ? err.message : err}`);
    }
  };
}

// ── Reading ───────────────────────────────────────────────────────────

/** One row without its bodies — what a listing shows. */
export interface ExchangeSummary {
  id: number;
  connection: string | null;
  order: string | null;
  phase: string;
  url: string;
  http_status: number | null;
  error: string | null;
  request_bytes: number;
  response_bytes: number | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

/** One row with its bodies — what an investigation needs. */
export interface ExchangeDetail extends ExchangeSummary {
  request: string;
  response: string | null;
}

interface ExchangeRow {
  id: number;
  connection_key: string | null;
  order_public_id: string | null;
  phase: string;
  url: string;
  request: string;
  response: string | null;
  http_status: number | null;
  error: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

const SELECT = `
  SELECT e.id, c.key AS connection_key, o.public_id AS order_public_id, e.phase, e.url,
         e.request, e.response, e.http_status, e.error, e.started_at, e.finished_at, e.duration_ms
    FROM bank_exchanges e
    LEFT JOIN bank_connections c ON c.id = e.connection_id
    LEFT JOIN orders o           ON o.id = e.order_id`;

function summarise(row: ExchangeRow): ExchangeSummary {
  return {
    id: row.id,
    connection: row.connection_key,
    order: row.order_public_id,
    phase: row.phase,
    url: row.url,
    http_status: row.http_status,
    error: row.error,
    request_bytes: Buffer.byteLength(row.request, 'utf8'),
    response_bytes: row.response === null ? null : Buffer.byteLength(row.response, 'utf8'),
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: row.duration_ms,
  };
}

export function listExchanges(
  db: Database.Database,
  filter: { connection?: string; order?: string; limit?: number } = {},
): ExchangeSummary[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.connection !== undefined) {
    where.push('c.key = ?');
    params.push(filter.connection);
  }
  if (filter.order !== undefined) {
    where.push('o.public_id = ?');
    params.push(filter.order);
  }
  const sql = `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY e.id DESC LIMIT ?`;
  params.push(filter.limit ?? 100);
  return (db.prepare(sql).all(...params) as ExchangeRow[]).map(summarise);
}

/** One exchange, bodies included. Admin-only at the route — this is payment data. */
export function exchangeDetail(db: Database.Database, id: number): ExchangeDetail {
  const row = db.prepare(`${SELECT} WHERE e.id = ?`).get(id) as ExchangeRow | undefined;
  if (row === undefined) throw new DomainError(404, `no exchange ${id}`);
  return { ...summarise(row), request: row.request, response: row.response };
}

/**
 * Drop conversations older than the retention window.
 *
 * Envelopes are large — a thousand-transfer pain.001 makes a megabyte of
 * base64 — so keeping every one forever turns the audit trail into the reason
 * the disk fills. The default window is longer than any bank's own dispute
 * period, and the parsed history in `order_events` is never pruned: what ages
 * out is the evidence, not the record.
 */
export function pruneExchanges(db: Database.Database, retentionDays: number, now: () => string): number {
  if (retentionDays <= 0) return 0;
  const at = now();
  const cutoff = new Date(new Date(at).getTime() - retentionDays * 86_400_000).toISOString();
  return db.transaction(() => {
    const result = db.prepare('DELETE FROM bank_exchanges WHERE started_at < ?').run(cutoff);
    // The links stay — removing them would break every link after — but they
    // are marked, so verification stops expecting content that was aged out
    // on purpose and can still tell that from a row somebody deleted.
    markPruned(db, 'bank_exchanges', at);
    return result.changes;
  })();
}
