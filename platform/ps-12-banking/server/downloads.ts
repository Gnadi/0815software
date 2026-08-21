import type Database from 'better-sqlite3';
import { DomainError } from './errors.js';
import { listConnections, nowIso, publicId, requireReady } from './connections.js';
import { privatePemFor } from './keystore.js';
import { bankProfile } from './bank-registry.js';
import { buildDownloadInit, buildDownloadSegment, buildReceipt, type Btf, type Subscriber, type SubscriberKeys } from './ebics/envelopes.js';
import { decryptTransactionKey, unpackOrderData, type EsVersion } from './ebics/crypto.js';
import { parseResponse } from './ebics/parse.js';
import { EBICS_NO_DOWNLOAD_DATA } from './ebics/codes.js';
import { sha256Hex } from './payload.js';
import { isStatement, isStatusReport, readStatusReports, verdictOfReports } from './reports.js';
import { documentsIn, ZipError } from './zip.js';
import { foldStatus, recordOrderEvent } from './orders.js';
import type { BtfInput, DownloadDetail, DownloadKind, DownloadRow, TickResult } from '../shared/types.js';

/**
 * Fetching what the bank has for us, and folding it back into the orders.
 *
 * ## The one rule that matters
 *
 * **The positive receipt goes out only after the bytes are committed.** A
 * receipt is how the bank learns we have a file; it then stops offering it.
 * Sending one before the file is stored is how a bank statement disappears
 * permanently — the bank marks it collected, the process dies, and there is no
 * second copy anywhere.
 *
 * So the order is: fetch every segment, reassemble, decrypt, `INSERT` and
 * commit, and only then acknowledge. The cost of getting this wrong in the
 * other direction is a duplicate, which `UNIQUE (connection, sha256)` absorbs.
 * The cost of getting it wrong this way is unrecoverable.
 *
 * ## What is parsed, and what is not
 *
 * A `pain.002` is read, because it is the answer to "did that payment file go
 * through?" and nothing else in the stack can answer it. A `camt.053` is
 * stored whole and left alone: it is an account statement, and matching
 * bookings to invoices belongs to the module that has the invoices.
 */

export interface DownloadContext {
  db: Database.Database;
  keySecret: Buffer;
  transport: { send(url: string, body: string): Promise<string> };
  actor?: string;
  now?: () => string;
}

interface ConnectionRow {
  id: number;
  key: string;
  bank_key: string;
  url: string;
  host_id: string;
  partner_id: string;
  user_id: string;
  es_version: string;
}

interface DownloadDbRow {
  id: number;
  connection_id: number;
  public_id: string;
  kind: string;
  btf: string;
  sha256: string;
  byte_length: number;
  transaction_id: string | null;
  fetched_at: string;
  acknowledged_at: string | null;
  processed_at: string | null;
}

// ── Reading ───────────────────────────────────────────────────────────

function toRow(db: Database.Database, row: DownloadDbRow): DownloadRow {
  const connection = db.prepare('SELECT key FROM bank_connections WHERE id = ?').get(row.connection_id) as
    | { key: string }
    | undefined;
  return {
    public_id: row.public_id,
    connection: connection?.key ?? '',
    kind: row.kind as DownloadKind,
    btf: JSON.parse(row.btf) as BtfInput,
    sha256: row.sha256,
    byte_length: row.byte_length,
    fetched_at: row.fetched_at,
    acknowledged_at: row.acknowledged_at,
    processed_at: row.processed_at,
  };
}

export function listDownloads(
  db: Database.Database,
  opts: { connection?: string; kind?: string; limit?: number } = {},
): DownloadRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.connection !== undefined) {
    where.push('c.key = ?');
    args.push(opts.connection);
  }
  if (opts.kind !== undefined) {
    where.push('d.kind = ?');
    args.push(opts.kind);
  }
  const rows = db
    .prepare(
      `SELECT d.id, d.connection_id, d.public_id, d.kind, d.btf, d.sha256, d.byte_length,
              d.transaction_id, d.fetched_at, d.acknowledged_at, d.processed_at
         FROM downloads d JOIN bank_connections c ON c.id = d.connection_id
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY d.id DESC LIMIT ?`,
    )
    .all(...args, opts.limit ?? 100) as DownloadDbRow[];
  return rows.map((row) => toRow(db, row));
}

export function downloadDetail(db: Database.Database, publicIdValue: string): DownloadDetail {
  const row = db
    .prepare(
      `SELECT id, connection_id, public_id, kind, btf, sha256, byte_length,
              transaction_id, fetched_at, acknowledged_at, processed_at
         FROM downloads WHERE public_id = ?`,
    )
    .get(publicIdValue) as DownloadDbRow | undefined;
  if (row === undefined) throw new DomainError(404, `no download ${publicIdValue}`);
  const reports = db
    .prepare(
      'SELECT msg_id, status_code, reason_code, reason, created_at FROM download_reports WHERE download_id = ? ORDER BY id',
    )
    .all(row.id) as DownloadDetail['reports'];
  return { ...toRow(db, row), reports };
}

/** The file itself. Separate from the metadata so a list never carries blobs. */
export function downloadContent(db: Database.Database, publicIdValue: string): Buffer {
  const row = db.prepare('SELECT content FROM downloads WHERE public_id = ?').get(publicIdValue) as
    | { content: Buffer }
    | undefined;
  if (row === undefined) throw new DomainError(404, `no download ${publicIdValue}`);
  return row.content;
}

// ── Fetching ──────────────────────────────────────────────────────────

function kindOf(btf: BtfInput): DownloadKind {
  if (isStatusReport(btf.msg_name)) return 'status';
  if (isStatement(btf.msg_name)) return 'statement';
  return 'other';
}

function subscriberOf(row: ConnectionRow): Subscriber {
  return { hostId: row.host_id, partnerId: row.partner_id, userId: row.user_id };
}

function keysOf(ctx: DownloadContext, row: ConnectionRow): SubscriberKeys {
  return {
    esPrivatePem: privatePemFor(ctx.db, { connectionId: row.id, purpose: 'ES', keySecret: ctx.keySecret }).pem,
    esVersion: row.es_version as EsVersion,
    authPrivatePem: privatePemFor(ctx.db, { connectionId: row.id, purpose: 'AUTH', keySecret: ctx.keySecret }).pem,
    encPrivatePem: privatePemFor(ctx.db, { connectionId: row.id, purpose: 'ENC', keySecret: ctx.keySecret }).pem,
  };
}

function bankKeysOf(db: Database.Database, connectionId: number): { authPublicPem: string; encPublicPem: string } {
  const rows = db
    .prepare('SELECT purpose, public_pem, verified_at FROM bank_keys WHERE connection_id = ?')
    .all(connectionId) as { purpose: string; public_pem: string; verified_at: string | null }[];
  const auth = rows.find((r) => r.purpose === 'AUTH');
  const enc = rows.find((r) => r.purpose === 'ENC');
  if (auth === undefined || enc === undefined) throw new DomainError(409, 'the bank keys are missing');
  return { authPublicPem: auth.public_pem, encPublicPem: enc.public_pem };
}

function toBtf(btf: BtfInput): Btf {
  return {
    serviceName: btf.service_name,
    scope: btf.scope,
    option: btf.option,
    msgName: btf.msg_name,
    msgVersion: btf.msg_version,
    msgVariant: btf.msg_variant,
    msgFormat: btf.msg_format,
    container: btf.container,
  };
}

export interface FetchResult {
  /** Null when the bank had nothing — the ordinary answer most of the time. */
  download: DownloadRow | null;
  /** True when these exact bytes were already stored: an interrupted receipt. */
  duplicate: boolean;
}

/**
 * Fetch one file for one BTF.
 *
 * A bank with nothing to give answers `090005`, which is **not an error** —
 * it is the normal answer on most polls, and treating it as a failure would
 * fill an operator's screen with red on a system that is working.
 */
export async function fetchOne(
  ctx: DownloadContext,
  connectionKey: string,
  btf: BtfInput,
  dateRange?: { from: string; to: string },
): Promise<FetchResult> {
  const connection = requireReady(ctx.db, connectionKey) as unknown as ConnectionRow;
  const at = (ctx.now ?? nowIso)();
  const subscriber = subscriberOf(connection);
  const keys = keysOf(ctx, connection);
  const bank = bankKeysOf(ctx.db, connection.id);

  const init = parseResponse(
    await ctx.transport.send(
      connection.url,
      buildDownloadInit({ subscriber, keys, bank, btf: toBtf(btf), timestamp: at, dateRange }),
    ),
    bank.authPublicPem,
  );
  if (!init.verified) {
    throw new DomainError(502, `the bank's response could not be verified: ${init.verificationError}`);
  }
  // Nothing waiting. The ordinary case, and not a problem.
  if (init.verdict.technical.code === EBICS_NO_DOWNLOAD_DATA || init.verdict.business.code === EBICS_NO_DOWNLOAD_DATA) {
    return { download: null, duplicate: false };
  }
  if (!init.verdict.ok) throw new DomainError(502, init.verdict.message);
  if (init.transactionId === null || init.transactionKey === null || init.orderData === null) {
    throw new DomainError(502, 'the bank started a download but did not send the data');
  }

  const transactionKey = decryptTransactionKey(keys.encPrivatePem, Buffer.from(init.transactionKey, 'base64'));
  const parts: string[] = [init.orderData];

  // Ask for the rest, one at a time. Segments are 1-based and the first
  // arrived with the initialisation, so this starts at 2.
  const total = init.segments ?? 1;
  for (let number = 2; number <= total && !init.lastSegment; number += 1) {
    const next = parseResponse(
      await ctx.transport.send(
        connection.url,
        buildDownloadSegment({
          subscriber,
          keys,
          transactionId: init.transactionId,
          segmentNumber: number,
          lastSegment: number === total,
        }),
      ),
      bank.authPublicPem,
    );
    if (!next.verified) {
      throw new DomainError(502, `the bank's response could not be verified: ${next.verificationError}`);
    }
    if (!next.verdict.ok) throw new DomainError(502, next.verdict.message);
    if (next.orderData === null) throw new DomainError(502, `the bank sent no data for segment ${number}`);
    parts.push(next.orderData);
    if (next.lastSegment) break;
  }

  const content = unpackOrderData(transactionKey, parts.join(''));
  const digest = sha256Hex(content);

  // STORE FIRST. The receipt below tells the bank to stop offering this file,
  // so it must not be sent until these bytes are committed.
  const existing = ctx.db
    .prepare('SELECT public_id FROM downloads WHERE connection_id = ? AND sha256 = ?')
    .get(connection.id, digest) as { public_id: string } | undefined;

  let storedId: string;
  let duplicate = false;
  if (existing !== undefined) {
    // The bank re-offered a file whose receipt it never saw. Correct of it,
    // and exactly what the unique index is here to absorb.
    storedId = existing.public_id;
    duplicate = true;
  } else {
    storedId = publicId('dl');
    ctx.db.transaction(() => {
      const info = ctx.db
        .prepare(
          `INSERT INTO downloads
             (connection_id, public_id, kind, btf, sha256, byte_length, content, transaction_id, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          connection.id,
          storedId,
          kindOf(btf),
          JSON.stringify(btf),
          digest,
          content.byteLength,
          content,
          init.transactionId,
          at,
        );
      const downloadId = Number(info.lastInsertRowid);
      for (const report of reportsIn(content)) {
        ctx.db
          .prepare(
            'INSERT INTO download_reports (download_id, msg_id, status_code, reason_code, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(downloadId, report.msgId, report.statusCode, report.reasonCode, report.reason, at);
      }
    })();
  }

  // Only now.
  try {
    const receipt = parseResponse(
      await ctx.transport.send(
        connection.url,
        buildReceipt({ subscriber, keys, transactionId: init.transactionId, positive: true }),
      ),
      bank.authPublicPem,
    );
    if (receipt.verified && receipt.verdict.ok) {
      ctx.db.prepare('UPDATE downloads SET acknowledged_at = ? WHERE public_id = ?').run(at, storedId);
    }
  } catch {
    // A receipt that did not land leaves the bank offering the file again,
    // which the digest check above turns into a no-op. Losing the file is the
    // failure worth avoiding; fetching it twice is not.
  }

  return { download: downloadDetail(ctx.db, storedId), duplicate };
}

/**
 * The status reports inside whatever the bank sent.
 *
 * EBICS delivers pain.002 inside a ZIP container — one download can carry
 * several — so the archive is opened and every document in it is read. An
 * archive this cannot open yields no reports rather than throwing: the bytes
 * are already stored and the receipt has not gone out yet, so a caller can
 * come back to them, whereas failing here would abandon a file mid-fetch.
 */
function reportsIn(content: Buffer): ReturnType<typeof readStatusReports> {
  let documents: Buffer[];
  try {
    documents = documentsIn(content);
  } catch (err) {
    console.warn(`[ps-12] a download could not be opened as an archive: ${err instanceof ZipError ? err.message : err}`);
    return [];
  }
  return documents.flatMap((document) => readStatusReports(document));
}

// ── Folding a status report into its order ────────────────────────────

/**
 * Apply every unprocessed status report to the order it names.
 *
 * The order's event stream is append-only, so this records what the bank said
 * rather than overwriting anything — and a report that would not change the
 * order's status is skipped, so a re-processed download cannot fill the stream
 * with duplicates.
 */
export function applyReports(db: Database.Database, now: () => string): number {
  const pending = db
    .prepare(
      `SELECT d.id AS download_id, d.public_id, d.connection_id
         FROM downloads d
        WHERE d.kind = 'status' AND d.processed_at IS NULL
        ORDER BY d.id`,
    )
    .all() as { download_id: number; public_id: string; connection_id: number }[];

  let updated = 0;
  for (const row of pending) {
    const reports = db
      .prepare('SELECT msg_id, status_code, reason_code, reason FROM download_reports WHERE download_id = ?')
      .all(row.download_id) as { msg_id: string | null; status_code: string; reason_code: string | null; reason: string | null }[];

    const byMsgId = new Map<string, typeof reports>();
    for (const report of reports) {
      if (report.msg_id === null) continue;
      byMsgId.set(report.msg_id, [...(byMsgId.get(report.msg_id) ?? []), report]);
    }

    for (const [msgId, group] of byMsgId) {
      const order = db
        .prepare('SELECT id, public_id FROM orders WHERE connection_id = ? AND msg_id = ?')
        .get(row.connection_id, msgId) as { id: number; public_id: string } | undefined;
      // A report about a file this service never sent. Kept on the download,
      // not invented onto an order.
      if (order === undefined) continue;

      const verdict = verdictOfReports(
        group.map((r) => ({ msgId: r.msg_id, statusCode: r.status_code, reasonCode: r.reason_code, reason: r.reason })),
      );
      const type = verdict === 'rejected' ? 'rejected' : verdict === 'settled' ? 'settled' : null;
      if (type === null) continue;

      const events = db
        .prepare('SELECT type, ebics_code, meta, created_at FROM order_events WHERE order_id = ? ORDER BY id')
        .all(order.id) as { type: string; ebics_code: string | null; meta: string; created_at: string }[];
      const current = foldStatus(
        events.map((e) => ({ type: e.type, ebics_code: e.ebics_code, meta: {}, created_at: e.created_at })),
      );
      // Nothing to say: the order already knows. Skipping keeps a
      // re-processed download from filling the stream with duplicates.
      if (current === 'rejected' && type === 'rejected') continue;
      if (current === 'settled' && type === 'settled') continue;

      const reason = group.find((r) => r.reason !== null || r.reason_code !== null);
      recordOrderEvent(db, {
        orderId: order.id,
        type,
        at: now(),
        code: reason?.reason_code ?? null,
        meta: {
          message:
            reason?.reason ??
            (type === 'rejected' ? 'the bank reported this payment as rejected' : 'the bank settled this payment'),
          source: row.public_id,
          statuses: group.map((r) => r.status_code),
        },
      });
      updated += 1;
    }

    db.prepare('UPDATE downloads SET processed_at = ? WHERE id = ?').run(now(), row.download_id);
  }

  return updated;
}

// ── The tick ──────────────────────────────────────────────────────────

/**
 * One pass over every ready connection: fetch what is waiting, apply what it
 * says.
 *
 * A connection that cannot be reached is reported, not thrown: one bank being
 * down must not stop the others from being polled, and a scheduler calling
 * this every minute needs an answer rather than a 500.
 */
export async function tick(ctx: DownloadContext): Promise<TickResult> {
  const now = ctx.now ?? nowIso;
  const result: TickResult = { downloads_fetched: 0, orders_updated: 0, problems: [] };

  for (const connection of listConnections(ctx.db)) {
    if (connection.state !== 'ready') continue;
    const profile = bankProfile(connection.bank_key);
    if (profile === undefined) {
      result.problems.push({ connection: connection.key, message: `unknown bank profile "${connection.bank_key}"` });
      continue;
    }

    // Status reports first: they are the answers to what we sent, and an
    // operator looking at a screen mid-tick would rather see those land.
    for (const btf of [profile.paymentStatus, profile.statement]) {
      try {
        const fetched = await fetchOne(ctx, connection.key, btf);
        if (fetched.download !== null && !fetched.duplicate) result.downloads_fetched += 1;
      } catch (err) {
        result.problems.push({
          connection: connection.key,
          message: `${btf.msg_name}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  result.orders_updated = applyReports(ctx.db, now);
  return result;
}
