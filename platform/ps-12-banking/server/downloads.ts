import type Database from 'better-sqlite3';
import { DomainError } from './errors.js';
import { listConnections, nowIso, productOf, publicId, requireReady } from './connections.js';
import { activeSubscriptions, recordPoll } from './subscriptions.js';
import { privatePemFor } from './keystore.js';
import { buildDownloadInit, buildDownloadSegment, buildReceipt, type Btf, type Subscriber, type SubscriberKeys } from './ebics/envelopes.js';
import { decryptTransactionKey, unpackOrderData, type EsVersion } from './ebics/crypto.js';
import { parseResponse } from './ebics/parse.js';
import { EBICS_NO_DOWNLOAD_DATA } from './ebics/codes.js';
import { sha256Hex } from './payload.js';
import { isStatusReport, readStatusReports, verdictOfReports } from './reports.js';
import { isAccountMessage } from './camt.js';
import { documentsIn, ZipError } from './zip.js';
import { isCustomerInfo, readCustomerInfo } from './cim.js';
import {
  entriesForOrder,
  isCustomerAcknowledgement,
  readCustomerAcknowledgement,
  verdictOfEntries,
  type CustomerAcknowledgement,
  type HacEntry,
} from './hac.js';
import { foldStatus, recordOrderEvent } from './orders.js';
import type { ExchangeScope } from './exchanges.js';
import { chainAppend } from './chain.js';
import { applyStatements } from './statements.js';
import type {
  BtfInput,
  DownloadDetail,
  DownloadKind,
  DownloadRow,
  HacEntrySummary,
  TickResult,
} from '../shared/types.js';

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
 * through?" and nothing else in the stack can answer it. A `camt.053` is read
 * into bookings by `statements.ts` — reading the bank's own format is what
 * this service is for. What a booking MEANS, which invoice it settles, stays
 * with the module that has the invoices.
 */

export interface DownloadContext {
  db: Database.Database;
  keySecret: Buffer;
  transport: { send(url: string, body: string, scope?: ExchangeScope): Promise<string> };
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
  product_name: string | null;
  product_language: string | null;
  product_institute_id: string | null;
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

  // Both of these are read on the way OUT rather than stored, and for the same
  // reason: the bytes are the record, so a better reader improves every file
  // already collected instead of only the next one.
  if (row.kind !== 'info' && row.kind !== 'protocol') return { ...toRow(db, row), reports };
  const content = db.prepare('SELECT content FROM downloads WHERE id = ?').get(row.id) as { content: Buffer };

  if (row.kind === 'protocol') {
    const log = documentsOf(content.content).map(readCustomerAcknowledgement).find((l) => l !== null) ?? null;
    return { ...toRow(db, row), reports, customer_protocol: log === null ? null : summarise(log) };
  }

  const message = readCustomerInfo(content.content);
  return {
    ...toRow(db, row),
    reports,
    customer_info:
      message === null
        ? null
        : {
            message_id: message.messageId,
            created_at: message.createdAt,
            notices: message.notices,
          },
  };
}

/**
 * A customer acknowledgement, in the shape the API hands over.
 *
 * `orders` is the part worth having: the raw entry list is chronological
 * across every subscriber and every order at once, and the question an
 * operator actually has is "what happened to THAT payment?". Folding by order
 * number answers it, and `entriesForOrder` deliberately includes the entries
 * that only REFER to an order — a co-signature is part of the payment's story
 * even though it carries its own order number.
 */
function summarise(log: CustomerAcknowledgement): NonNullable<DownloadDetail['customer_protocol']> {
  const entry = (e: HacEntry): HacEntrySummary => ({
    action: e.action,
    user_id: e.userId,
    partner_id: e.partnerId,
    order_id: e.orderId,
    admin_order_type: e.adminOrderType,
    service_name: e.serviceName,
    msg_name: e.msgName,
    timestamp: e.timestamp,
    references_order_id: e.references.orderId,
    reason_code: e.reasonCode,
    additional_info: e.additionalInfo,
  });

  const orderIds: string[] = [];
  for (const e of log.entries) {
    // The order an entry is ABOUT: a HVE names its own number and refers to
    // the payment, so the reference wins where there is one.
    const id = e.references.orderId ?? e.orderId;
    if (id !== null && !orderIds.includes(id)) orderIds.push(id);
  }

  return {
    message_id: log.messageId,
    created_at: log.createdAt,
    host_id: log.hostId,
    entries: log.entries.map(entry),
    orders: orderIds.map((orderId) => {
      const entries = entriesForOrder(log, orderId);
      return { order_id: orderId, verdict: verdictOfEntries(entries), entries: entries.map(entry) };
    }),
  };
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

/**
 * What kind of file this is — from the BTF, and from the BYTES.
 *
 * The content check is not belt-and-braces. **A HAC customer acknowledgement
 * is a `pain.002.001.03`, the same message name as a payment status report**,
 * in the same namespace with the same root element. Classifying on the BTF
 * alone would file the bank's own activity log as a set of payment verdicts
 * and hand it to `applyReports`, which exists to settle and reject orders.
 *
 * So the bytes decide, and they are checked first. `isCustomerAcknowledgement`
 * reads the one element that distinguishes them — see `hac.ts`.
 */
function kindOf(btf: BtfInput, documents: Buffer[]): DownloadKind {
  if (documents.some(isCustomerAcknowledgement)) return 'protocol';
  if (isStatusReport(btf.msg_name)) return 'status';
  // camt.052 and camt.054 are filed as statements too: they carry the same
  // bookings and are read by the same reader. What they MEAN differs, and that
  // is recorded per statement rather than per download — see statements.ts.
  if (isAccountMessage(btf.msg_name)) return 'statement';
  if (isCustomerInfo(btf.msg_name)) return 'info';
  return 'other';
}

/** The documents inside a download — one file, or the members of its archive. */
function documentsOf(content: Buffer): Buffer[] {
  try {
    return documentsIn(content);
  } catch (err) {
    console.warn(`[ps-12] a download could not be opened as an archive: ${err instanceof ZipError ? err.message : err}`);
    return [];
  }
}

function subscriberOf(row: ConnectionRow): Subscriber {
  return {
    hostId: row.host_id,
    partnerId: row.partner_id,
    userId: row.user_id,
    ...productOf(row),
  };
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
      { connection: connection.id, phase: `btd.initialisation.${btf.msg_name ?? btf.service_name ?? 'unnamed'}` },
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
        { connection: connection.id, phase: `btd.segment-${number}` },
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
  // Opened once: the kind depends on what is inside, not only on the BTF.
  const documents = documentsOf(content);
  const kind = kindOf(btf, documents);

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
          kind,
          JSON.stringify(btf),
          digest,
          content.byteLength,
          content,
          init.transactionId,
          at,
        );
      const downloadId = Number(info.lastInsertRowid);
      // Chained inside the same transaction that stored it: an order later
      // says `settled, source: dl_…`, and the link is what stops the file
      // behind that verdict from being swapped afterwards.
      chainAppend(ctx.db, 'downloads', downloadId, () => at);
      // A HAC's entries are NOT payment verdicts, and the kind check above is
      // what keeps them out of this table.
      for (const report of kind === 'protocol' ? [] : documents.flatMap(readStatusReports)) {
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
        { connection: connection.id, phase: 'btd.receipt' },
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

// ── Folding a status report into its order ────────────────────────────

/**
 * Apply every unprocessed status report to the order it names.
 *
 * The order's event stream is append-only, so this records what the bank said
 * rather than overwriting anything — and a report that would not change the
 * order's status is skipped, so a re-processed download cannot fill the stream
 * with duplicates.
 */
export function applyReports(db: Database.Database, now: () => string, actor?: string): number {
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
        events.map((e) => ({
          type: e.type,
          ebics_code: e.ebics_code,
          meta: {},
          actor: null,
          created_at: e.created_at,
        })),
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
        actor: actor ?? null,
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

/**
 * Apply every unprocessed customer acknowledgement to the orders it names.
 *
 * ## Why this is worth doing at all
 *
 * A `pain.002` status report answers "did the payment settle?". The customer
 * protocol answers a different and earlier question: **"did the bank accept
 * the file, and did my signature hold?"** An order refused at the signature
 * step never reaches a status report, so without this it sits at `accepted`
 * forever while the money never moves.
 *
 * ## What it deliberately does NOT claim
 *
 * A `HAC` verdict of `processed` means the bank finished handling the order at
 * the EBICS level — the file arrived, the signatures verified, it was passed
 * on. **It does not mean the payment executed**, which only a `pain.002` can
 * say. So a positive protocol entry records nothing: the order's status
 * already reflects an accepted upload, and calling it `settled` here would be
 * a settlement this service invented.
 *
 * A failure is the other way round. It is information nothing else will ever
 * carry, so it is recorded.
 */
export function applyCustomerProtocol(db: Database.Database, now: () => string, actor?: string): number {
  const pending = db
    .prepare(
      `SELECT d.id AS download_id, d.public_id, d.connection_id
         FROM downloads d
        WHERE d.kind = 'protocol' AND d.processed_at IS NULL
        ORDER BY d.id`,
    )
    .all() as { download_id: number; public_id: string; connection_id: number }[];

  let updated = 0;
  for (const row of pending) {
    const content = db.prepare('SELECT content FROM downloads WHERE id = ?').get(row.download_id) as {
      content: Buffer;
    };
    const log = documentsOf(content.content).map(readCustomerAcknowledgement).find((l) => l !== null) ?? null;
    if (log !== null) {
      const ids = new Set<string>();
      for (const entry of log.entries) {
        const id = entry.references.orderId ?? entry.orderId;
        if (id !== null) ids.add(id);
      }

      for (const orderId of ids) {
        const entries = entriesForOrder(log, orderId);
        if (verdictOfEntries(entries) !== 'failed') continue;

        // The bank's order number, which is null on an order the bank never
        // gave one for. Such an order cannot be matched, and inventing a match
        // on anything else would attach a stranger's failure to a real
        // payment.
        const order = db
          .prepare('SELECT id FROM orders WHERE connection_id = ? AND ebics_order_id = ?')
          .get(row.connection_id, orderId) as { id: number } | undefined;
        if (order === undefined) continue;

        const events = db
          .prepare('SELECT type, ebics_code, meta, created_at FROM order_events WHERE order_id = ? ORDER BY id')
          .all(order.id) as { type: string; ebics_code: string | null; meta: string; created_at: string }[];
        const current = foldStatus(
          events.map((e) => ({
          type: e.type,
          ebics_code: e.ebics_code,
          meta: {},
          actor: null,
          created_at: e.created_at,
        })),
        );
        // Already known to have gone wrong. Re-processing a protocol file must
        // not fill the stream with duplicates.
        if (current === 'rejected' || current === 'failed') continue;

        const failure = entries.find((e) => e.reasonCode !== null && !['TS01', 'DS01', 'DS05', 'DS06'].includes(e.reasonCode.toUpperCase()));
        recordOrderEvent(db, {
          orderId: order.id,
          type: 'rejected',
          at: now(),
          actor: actor ?? null,
          code: failure?.reasonCode ?? null,
          meta: {
            message: `the bank's protocol records this order as failed at ${failure?.action ?? 'an unnamed step'}`,
            source: row.public_id,
            ebics_order_id: orderId,
          },
        });
        updated += 1;
      }
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
let tickInFlight = false;

export async function tick(ctx: DownloadContext): Promise<TickResult> {
  const now = ctx.now ?? nowIso;
  const result: TickResult = { downloads_fetched: 0, orders_updated: 0, statements_read: 0, problems: [] };

  // ONE PASS AT A TIME.
  //
  // A pass is network-bound and serial: connections times subscriptions times
  // three round trips, each with a 30-second ceiling. A slow bank can push it
  // past the interval a scheduler calls this on, and a second pass starting on
  // top of the first would ask the same bank for the same files again — twice
  // the round trips on a payment connection, and a receipt for a transaction
  // the other pass already closed.
  //
  // Nothing would be corrupted: the digest index absorbs the duplicate bytes.
  // But a bank is not a resource to hammer by accident, so an overlapping call
  // is told the truth and returns immediately rather than queueing.
  if (tickInFlight) {
    result.problems.push({ connection: '', message: 'a tick is already running — this pass was skipped' });
    return result;
  }
  tickInFlight = true;
  try {
    return await runTick(ctx, now, result);
  } finally {
    tickInFlight = false;
  }
}

async function runTick(ctx: DownloadContext, now: () => string, result: TickResult): Promise<TickResult> {

  for (const connection of listConnections(ctx.db)) {
    if (connection.state !== 'ready') continue;

    // WHAT gets fetched is the connection's own subscription list, not a pair
    // hard-coded here. A connection with no enabled subscriptions polls
    // nothing, deliberately: that is an operator's choice, and inventing a
    // fallback would make an emptied list silently un-emptiable.
    const row = ctx.db.prepare('SELECT id FROM bank_connections WHERE key = ?').get(connection.key) as { id: number };
    for (const subscription of activeSubscriptions(ctx.db, row.id)) {
      const at = now();
      try {
        const fetched = await fetchOne(ctx, connection.key, subscription.btf, lookback(subscription.lookback_days, at));
        if (fetched.download !== null && !fetched.duplicate) result.downloads_fetched += 1;
        recordPoll(ctx.db, subscription.id, at, null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordPoll(ctx.db, subscription.id, at, message);
        result.problems.push({
          connection: connection.key,
          message: `${subscription.btf.msg_name}: ${message}`,
        });
      }
    }
  }

  result.orders_updated = applyReports(ctx.db, now, ctx.actor) + applyCustomerProtocol(ctx.db, now, ctx.actor);
  // Statements last: they are the slowest to read and nothing else waits on
  // them, so an operator watching a tick sees the payment answers first.
  result.statements_read = applyStatements(ctx.db, now);
  return result;
}

/**
 * The `DateRange` a subscription's lookback asks for, or none.
 *
 * Deliberately inclusive of today and of the whole lookback window: banks
 * differ on whether an absent range means "everything not yet collected" or
 * "today", and re-asking for a file already collected costs a duplicate the
 * digest index absorbs, while asking for one day too few loses a statement.
 */
function lookback(days: number | null, at: string): { from: string; to: string } | undefined {
  if (days === null) return undefined;
  const to = new Date(at);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - days);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}
