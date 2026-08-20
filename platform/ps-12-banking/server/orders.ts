import type Database from 'better-sqlite3';
import { DomainError } from './errors.js';
import { nowIso, publicId, requireReady } from './connections.js';
import { privatePemFor } from './keystore.js';
import { Transport } from './transport.js';
import { buildTransfer, buildUploadInit, type Btf, type Subscriber, type SubscriberKeys } from './ebics/envelopes.js';
import { newTransactionKey, packOrderData, type EsVersion } from './ebics/crypto.js';
import { parseResponse } from './ebics/parse.js';
import type { Verdict } from './ebics/codes.js';
import { checkCeilings, inspectPayload, type PayloadFacts } from './payload.js';
import { bankProfile } from './bank-registry.js';
import type { BtfInput, Order, OrderDetail, OrderEvent, OrderStatus } from '../shared/types.js';

/**
 * Submitting a payment file.
 *
 * The order of operations here is the safety design, not a style choice.
 * Everything that can refuse the submission runs **before** anything is
 * signed, because at signature class E a signature is the payment: once the ES
 * key has been applied there is no taking it back, only a recall request and a
 * phone call to the bank.
 *
 *   1. is the connection allowed to carry an order at all?   (a human verified
 *      the bank's keys — connections.ts)
 *   2. have we sent this exact file before?                  (two layers, below)
 *   3. is it within this connection's ceilings?              (payload.ts)
 *   4. only now: sign, encrypt, and talk to the bank.
 *
 * ## Sent at most once, twice over
 *
 * A caller's `idempotency_key` catches the ordinary case — a retried HTTP
 * request, a double-clicked button. `UNIQUE (connection_id, msg_id)` catches
 * the case the caller did not think about: the same file submitted again
 * without a key, or under a new key. MOD-04's payment run is byte-stable and
 * carries a stored `MsgId`, so both layers converge on the same answer.
 *
 * ## `rejected` and `failed` are not the same thing
 *
 * A rejection is a decision the bank made and told us about; a failure is a
 * conversation that broke, and whether the bank has the file is **unknown**.
 * Merging them would make one of the two safe to resubmit look like the other.
 * They are kept apart all the way to the API.
 */

/** EBICS caps one order-data segment at 1 MB of base64. */
export const SEGMENT_LIMIT = 1_000_000;

export interface OrderContext {
  db: Database.Database;
  keySecret: Buffer;
  transport: Transport;
  actor?: string;
  now?: () => string;
  /** Injectable so an envelope can be asserted byte for byte in tests. */
  transactionKey?: () => Buffer;
  /**
   * Segment size in base64 characters. Banks publish their own maximum and a
   * few are below the protocol's; overriding it is also how the segmentation
   * path gets exercised without a megabyte of test data.
   */
  segmentLimit?: number;
}

export interface SubmitInput {
  connection: string;
  btf: BtfInput;
  payload: Buffer;
  idempotencyKey?: string;
}

interface OrderRow {
  id: number;
  connection_id: number;
  public_id: string;
  msg_id: string;
  btf: string;
  payload_sha256: string;
  amount_minor: number | null;
  tx_count: number | null;
  idempotency_key: string | null;
  transaction_id: string | null;
  created_by: string | null;
  created_at: string;
}

// ── Events and the status folded from them ────────────────────────────

function recordOrderEvent(
  db: Database.Database,
  params: { orderId: number; type: string; code?: string | null; meta?: Record<string, unknown>; at: string },
): void {
  db.prepare('INSERT INTO order_events (order_id, type, ebics_code, meta, created_at) VALUES (?, ?, ?, ?, ?)').run(
    params.orderId,
    params.type,
    params.code ?? null,
    JSON.stringify(params.meta ?? {}),
    params.at,
  );
}

function eventsOf(db: Database.Database, orderId: number): OrderEvent[] {
  const rows = db
    .prepare('SELECT type, ebics_code, meta, created_at FROM order_events WHERE order_id = ? ORDER BY id')
    .all(orderId) as { type: string; ebics_code: string | null; meta: string; created_at: string }[];
  return rows.map((row) => ({
    type: row.type,
    ebics_code: row.ebics_code,
    meta: JSON.parse(row.meta) as Record<string, unknown>,
    created_at: row.created_at,
  }));
}

/**
 * Fold the stream into a status.
 *
 * `accepted`, `rejected` and `failed` are terminal and win over anything
 * earlier, so a late progress event cannot walk an order back out of a decision
 * the bank already made.
 */
export function foldStatus(events: OrderEvent[]): OrderStatus {
  let status: OrderStatus = 'queued';
  for (const event of events) {
    switch (event.type) {
      case 'queued':
        status = 'queued';
        break;
      case 'initialised':
        status = 'initialised';
        break;
      case 'transferred':
        status = 'transferred';
        break;
      case 'accepted':
        return 'accepted';
      case 'rejected':
        return 'rejected';
      case 'failed':
        return 'failed';
      default:
        break;
    }
  }
  return status;
}

function toOrder(db: Database.Database, row: OrderRow, connectionKey: string): Order {
  const events = eventsOf(db, row.id);
  const last = [...events].reverse().find((e) => e.ebics_code !== null || typeof e.meta.message === 'string');
  return {
    public_id: row.public_id,
    connection: connectionKey,
    msg_id: row.msg_id,
    btf: JSON.parse(row.btf) as BtfInput,
    status: foldStatus(events),
    payload_sha256: row.payload_sha256,
    amount_minor: row.amount_minor,
    tx_count: row.tx_count,
    transaction_id: row.transaction_id,
    created_by: row.created_by,
    created_at: row.created_at,
    ebics_code: last?.ebics_code ?? null,
    message: typeof last?.meta.message === 'string' ? last.meta.message : null,
  };
}

function connectionKeyOf(db: Database.Database, connectionId: number): string {
  const row = db.prepare('SELECT key FROM bank_connections WHERE id = ?').get(connectionId) as
    | { key: string }
    | undefined;
  return row?.key ?? '';
}

// ── Reading ───────────────────────────────────────────────────────────

export function listOrders(db: Database.Database, opts: { connection?: string; limit?: number } = {}): Order[] {
  const rows = db
    .prepare(
      `SELECT o.* FROM orders o JOIN bank_connections c ON c.id = o.connection_id
       ${opts.connection ? 'WHERE c.key = ?' : ''}
       ORDER BY o.id DESC LIMIT ?`,
    )
    .all(...(opts.connection ? [opts.connection] : []), opts.limit ?? 100) as OrderRow[];
  return rows.map((row) => toOrder(db, row, connectionKeyOf(db, row.connection_id)));
}

export function orderDetail(db: Database.Database, publicIdValue: string): OrderDetail {
  const row = db.prepare('SELECT * FROM orders WHERE public_id = ?').get(publicIdValue) as OrderRow | undefined;
  if (row === undefined) throw new DomainError(404, `no order ${publicIdValue}`);
  return {
    ...toOrder(db, row, connectionKeyOf(db, row.connection_id)),
    events: eventsOf(db, row.id),
  };
}

// ── The dry run ───────────────────────────────────────────────────────

/**
 * What would be sent, without sending it.
 *
 * Nothing is signed and nothing is stored, so this is safe to call as often as
 * a caller likes — which is the point: a module can check a file against the
 * ceilings and the BTF before committing to it.
 */
export function previewOrder(
  db: Database.Database,
  input: SubmitInput,
): { msg_id: string; payload_sha256: string; amount_minor: number | null; tx_count: number | null; btf: BtfInput; problems: ReturnType<typeof checkCeilings> } {
  const connection = requireReady(db, input.connection);
  const facts = inspectPayload(input.payload, input.btf);
  return {
    msg_id: facts.msgId,
    payload_sha256: facts.sha256,
    amount_minor: facts.amountMinor,
    tx_count: facts.txCount,
    btf: input.btf,
    problems: checkCeilings(facts, {
      maxAmountMinor: connection.max_amount_minor,
      maxTransfers: connection.max_transfers,
    }),
  };
}

// ── Submitting ────────────────────────────────────────────────────────

export interface SubmitResult {
  order: OrderDetail;
  /** True when an earlier submission of the same file produced this order. */
  replayed: boolean;
}

/**
 * Submit a file to the bank.
 *
 * Returns the order either way — accepted, rejected or failed — because a
 * caller needs to record the outcome against its own record, and an exception
 * for "the bank said no" would lose the order id it needs to do that. Only
 * problems that stop the submission *before* signing throw.
 */
export async function submitOrder(ctx: OrderContext, input: SubmitInput): Promise<SubmitResult> {
  const connection = requireReady(ctx.db, input.connection);
  const at = (ctx.now ?? nowIso)();

  // 1. Replay, on the caller's key.
  if (input.idempotencyKey !== undefined) {
    const existing = ctx.db
      .prepare('SELECT * FROM orders WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as OrderRow | undefined;
    if (existing !== undefined) {
      return { order: orderDetail(ctx.db, existing.public_id), replayed: true };
    }
  }

  const facts = inspectPayload(input.payload, input.btf);

  // 2. Replay, on the file's own identity — the layer that catches a caller
  //    who forgot a key, or invented a new one for the same file.
  const seen = ctx.db
    .prepare('SELECT * FROM orders WHERE connection_id = ? AND msg_id = ?')
    .get(connection.id, facts.msgId) as OrderRow | undefined;
  if (seen !== undefined) {
    const previous = orderDetail(ctx.db, seen.public_id);
    if (previous.status === 'rejected' || previous.status === 'failed') {
      // A refused file may legitimately be corrected and resent — but not
      // under the same MsgId, because the bank keys its own duplicate check on
      // exactly that. Saying so is more useful than a bare 409.
      throw new DomainError(
        409,
        `this file was already submitted as ${previous.public_id} and ${previous.status}. ` +
          'Give the corrected file a new MsgId before resubmitting: the bank rejects a repeated one.',
      );
    }
    return { order: previous, replayed: true };
  }

  // 3. Ceilings — the last gate before the ES key is used.
  const problems = checkCeilings(facts, {
    maxAmountMinor: connection.max_amount_minor,
    maxTransfers: connection.max_transfers,
  });
  if (problems.length > 0) {
    throw new DomainError(422, 'this file is outside what this connection may send', problems);
  }

  // 4. Record the order, then sign and send it.
  const orderId = ctx.db.transaction((): number => {
    const info = ctx.db
      .prepare(
        `INSERT INTO orders
           (connection_id, public_id, msg_id, btf, payload_sha256, amount_minor, tx_count,
            idempotency_key, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        connection.id,
        publicId('ord'),
        facts.msgId,
        JSON.stringify(input.btf),
        facts.sha256,
        facts.amountMinor,
        facts.txCount,
        input.idempotencyKey ?? null,
        ctx.actor ?? null,
        at,
      );
    const id = Number(info.lastInsertRowid);
    recordOrderEvent(ctx.db, { orderId: id, type: 'queued', at, meta: { sha256: facts.sha256 } });
    return id;
  })();

  const row = ctx.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow;
  await transmit(ctx, connection, row, input, facts);
  return { order: orderDetail(ctx.db, row.public_id), replayed: false };
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
  max_amount_minor: number;
  max_transfers: number;
}

/** Sign, encrypt, and run the initialisation + transfer phases. */
async function transmit(
  ctx: OrderContext,
  connection: ConnectionRow,
  order: OrderRow,
  input: SubmitInput,
  facts: PayloadFacts,
): Promise<void> {
  const at = (ctx.now ?? nowIso)();
  const subscriber: Subscriber = {
    hostId: connection.host_id,
    partnerId: connection.partner_id,
    userId: connection.user_id,
  };

  const keys: SubscriberKeys = {
    esPrivatePem: privatePemFor(ctx.db, { connectionId: connection.id, purpose: 'ES', keySecret: ctx.keySecret }).pem,
    esVersion: connection.es_version as EsVersion,
    authPrivatePem: privatePemFor(ctx.db, { connectionId: connection.id, purpose: 'AUTH', keySecret: ctx.keySecret })
      .pem,
    encPrivatePem: privatePemFor(ctx.db, { connectionId: connection.id, purpose: 'ENC', keySecret: ctx.keySecret })
      .pem,
  };

  const bank = bankKeysOf(ctx.db, connection.id);
  const transactionKey = (ctx.transactionKey ?? newTransactionKey)();

  // Pack once: the segments are slices of THIS string, so the digest the bank
  // checks and the bytes it reassembles come from the same encryption.
  const packed = packOrderData(transactionKey, input.payload);
  // The bank's own published maximum, when its profile names one below the
  // protocol's; an explicit context override wins over both (tests use it).
  const limit = ctx.segmentLimit ?? bankProfile(connection.bank_key)?.segmentLimit ?? SEGMENT_LIMIT;
  const segments = splitSegments(packed, limit);

  const btf: Btf = {
    serviceName: input.btf.service_name,
    scope: input.btf.scope,
    option: input.btf.option,
    msgName: input.btf.msg_name,
    msgVersion: input.btf.msg_version,
    container: input.btf.container,
  };

  let transactionId: string;
  try {
    const initBody = buildUploadInit({
      subscriber,
      keys,
      bank,
      btf,
      orderData: input.payload,
      transactionKey,
      timestamp: at,
      segments: segments.length,
    });
    const response = parseResponse(await ctx.transport.send(connection.url, initBody), bank.authPublicPem);

    if (!response.verified) {
      // A response we cannot attribute to the bank is not an answer. Refusing
      // to act on it is the whole reason the key was verified by a human.
      return fail(ctx, order, at, `the bank's response could not be verified: ${response.verificationError}`);
    }
    if (!response.verdict.ok) {
      return reject(ctx, order, at, response.verdict);
    }
    if (response.transactionId === null) {
      return fail(ctx, order, at, 'the bank accepted the initialisation but returned no transaction id');
    }
    transactionId = response.transactionId;
  } catch (err) {
    // The request never completed. Whether the bank has the file is UNKNOWN,
    // which is precisely why this is `failed` and not `rejected`.
    return fail(ctx, order, at, err instanceof Error ? err.message : String(err));
  }

  ctx.db.prepare('UPDATE orders SET transaction_id = ? WHERE id = ?').run(transactionId, order.id);
  recordOrderEvent(ctx.db, {
    orderId: order.id,
    type: 'initialised',
    at,
    meta: { transaction_id: transactionId, segments: segments.length, tx_count: facts.txCount },
  });

  // Transfer phase — segments are 1-based and must arrive in order.
  for (const [index, segment] of segments.entries()) {
    const number = index + 1;
    const last = number === segments.length;
    try {
      const body = buildTransfer({
        subscriber,
        keys,
        transactionId,
        segmentNumber: number,
        lastSegment: last,
        segment,
      });
      const response = parseResponse(await ctx.transport.send(connection.url, body), bank.authPublicPem);
      if (!response.verified) {
        return fail(ctx, order, at, `the bank's response could not be verified: ${response.verificationError}`);
      }
      if (!response.verdict.ok) {
        return reject(ctx, order, at, response.verdict);
      }
      recordOrderEvent(ctx.db, { orderId: order.id, type: 'segment_sent', at, meta: { segment: number, last } });
    } catch (err) {
      return fail(ctx, order, at, err instanceof Error ? err.message : String(err));
    }
  }

  recordOrderEvent(ctx.db, { orderId: order.id, type: 'transferred', at, meta: { segments: segments.length } });
  recordOrderEvent(ctx.db, {
    orderId: order.id,
    type: 'accepted',
    at,
    code: '000000',
    meta: { message: 'the bank accepted the order' },
  });
}

function reject(ctx: OrderContext, order: OrderRow, at: string, verdict: Verdict): void {
  // Record the code that actually DECIDED the verdict. A business rejection
  // travels with technical code 000000, so storing the technical one would
  // file a refused payment under a code that reads as "OK".
  const deciding = verdict.technical.severity !== 'ok' ? verdict.technical : verdict.business;

  // A technical fault that might not recur is still not an acceptance, but it
  // is worth distinguishing in the record: the operator's next move differs.
  recordOrderEvent(ctx.db, {
    orderId: order.id,
    type: verdict.severity === 'retryable' ? 'failed' : 'rejected',
    at,
    code: deciding.code,
    meta: { message: verdict.message, severity: verdict.severity },
  });
}

function fail(ctx: OrderContext, order: OrderRow, at: string, message: string): void {
  recordOrderEvent(ctx.db, { orderId: order.id, type: 'failed', at, meta: { message } });
}

function bankKeysOf(db: Database.Database, connectionId: number): { authPublicPem: string; encPublicPem: string } {
  const rows = db
    .prepare('SELECT purpose, public_pem, verified_at FROM bank_keys WHERE connection_id = ?')
    .all(connectionId) as { purpose: string; public_pem: string; verified_at: string | null }[];
  const auth = rows.find((r) => r.purpose === 'AUTH');
  const enc = rows.find((r) => r.purpose === 'ENC');
  if (auth === undefined || enc === undefined) throw new DomainError(409, 'the bank keys are missing');
  if (auth.verified_at === null || enc.verified_at === null) {
    // requireReady already covers this; the second check is here because this
    // function is what actually hands a key to the encryption step.
    throw new DomainError(409, 'the bank keys have not been confirmed by a human');
  }
  return { authPublicPem: auth.public_pem, encPublicPem: enc.public_pem };
}

/**
 * Split the packed order data into segments the bank will accept.
 *
 * Slicing the base64 rather than the bytes is what the protocol asks for: the
 * bank concatenates the segments back into one base64 string before decoding,
 * so a boundary inside a base64 quantum is fine — but re-encoding each byte
 * slice separately would insert padding mid-stream and corrupt the file.
 */
export function splitSegments(packed: string, limit = SEGMENT_LIMIT): string[] {
  if (packed.length <= limit) return [packed];
  const out: string[] = [];
  for (let i = 0; i < packed.length; i += limit) out.push(packed.slice(i, i + limit));
  return out;
}
