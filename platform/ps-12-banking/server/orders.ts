import type Database from 'better-sqlite3';
import { DomainError } from './errors.js';
import { chainAppend } from './chain.js';
import { nowIso, productOf, publicId, requireReady } from './connections.js';
import { privatePemFor } from './keystore.js';
import { Transport } from './transport.js';
import { buildTransfer, buildUploadInit, type Btf, type Subscriber, type SubscriberKeys } from './ebics/envelopes.js';
import { newTransactionKey, packOrderData, type EsVersion } from './ebics/crypto.js';
import { parseResponse } from './ebics/parse.js';
import type { Verdict } from './ebics/codes.js';
import { checkCeilings, inspectPayload, type PayloadFacts } from './payload.js';
import { austrianPaymentProblems } from './austrian.js';
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
  /**
   * The Business Transaction Format. Optional: omitted, the connection's own
   * bank profile supplies the credit-transfer BTF.
   *
   * That default is the point of the profile registry. A calling module knows
   * it has produced a pain.001; it should not also have to know that this
   * bank wants `SCT/AT/pain.001` while the one next door wants no scope at
   * all. An operator picks the profile once, when they set the connection up
   * and have the bank's documentation in front of them.
   */
  btf?: BtfInput;
  payload: Buffer;
  idempotencyKey?: string;
}

/** How a connection wants Verification of Payee handled. */
export type VopMode = 'default' | 'opt_out' | 'opt_in';

/** The ServiceOption each mode asks for. `default` asks for nothing. */
const VOP_OPTION: Record<VopMode, string | null> = { default: null, opt_out: 'VOO', opt_in: 'VOI' };

/**
 * The BTF this order will actually be sent with.
 *
 * A caller-supplied one always wins — a bank that needs a different BTF for
 * one message must stay reachable without editing the registry, and a caller
 * that names its own BTF has taken responsibility for all of it, Verification
 * of Payee included.
 *
 * ## Verification of Payee
 *
 * Since 09.10.2025 the ServiceOption says whether the bank should check the
 * payee's name against the IBAN: `VOO` opts out, `VOI` opts in. Send neither
 * and the market's default applies — OPT-OUT for SCT and SCI in both the
 * German and the Austrian tables. `vop: 'default'` is exactly that, and is
 * what every connection has unless someone chose otherwise.
 *
 * The option slot is **shared**, which is the trap here. It also carries the
 * payment's own kind, and the published tables combine the two into single
 * codes: a salary payment opting out is `CFDVOO`, not `CFD` plus `VOO`. Only
 * some combinations exist — the Austrian table has `CFDVOO` and `THMVOI` but
 * no `URGVOO` — so this refuses to compose one rather than inventing a code
 * the bank never published. An operator who needs a combined option names it
 * on the BTF directly.
 */
export function resolveBtf(
  connection: { bank_key: string; vop?: string | null },
  btf?: BtfInput,
): BtfInput {
  if (btf !== undefined) return btf;
  const profile = bankProfile(connection.bank_key);
  if (profile === undefined) {
    throw new DomainError(409, `this connection's bank profile "${connection.bank_key}" is not one this service knows`);
  }

  return applyVop(profile.creditTransfer, (connection.vop ?? 'default') as VopMode);
}

/**
 * Put the Verification-of-Payee choice into a BTF's ServiceOption.
 *
 * Separate from `resolveBtf` because the interesting case — a BTF that
 * already uses the option slot — cannot be reached through any shipped bank
 * profile, and an unreachable branch is one nothing can test.
 */
export function applyVop(btf: BtfInput, mode: VopMode): BtfInput {
  const option = VOP_OPTION[mode] ?? null;
  if (option === null) return btf;

  if (btf.option !== undefined) {
    throw new DomainError(
      409,
      `this connection asks for Verification of Payee ${option}, but the BTF already puts "${btf.option}" in ` +
        `the ServiceOption. The published tables combine the two into a single code — CFD with VOO is "CFDVOO" — ` +
        `and only some combinations exist: the Austrian table has CFDVOO and THMVOI but no URGVOO. Name the ` +
        `combined option on the order's own BTF rather than letting this service concatenate one.`,
    );
  }
  return { ...btf, option };
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

export function recordOrderEvent(
  db: Database.Database,
  params: {
    orderId: number;
    type: string;
    code?: string | null;
    meta?: Record<string, unknown>;
    /**
     * When this step happened — its OWN moment, not the conversation's.
     *
     * This used to be one timestamp computed once per submission and stamped
     * on every event of it, so a twelve-segment upload read as twelve things
     * happening in the same instant. Nobody could then say how long the bank
     * took, or which segment it was on when it stopped answering, which is
     * exactly the question asked about the upload that did not come back.
     */
    at: string;
    /** Who caused it: an operator's username, `service`, or `ticker`. */
    actor?: string | null;
  },
): void {
  // The insert and its chain link are one transaction. A record committed
  // without a link is indistinguishable from one written past the log, and
  // `verifyChain` reports it as exactly that.
  db.transaction(() => {
    const info = db
      .prepare('INSERT INTO order_events (order_id, type, ebics_code, meta, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        params.orderId,
        params.type,
        params.code ?? null,
        JSON.stringify(params.meta ?? {}),
        params.actor ?? null,
        params.at,
      );
    chainAppend(db, 'order_events', Number(info.lastInsertRowid), () => params.at);
  })();
}

function eventsOf(db: Database.Database, orderId: number): OrderEvent[] {
  const rows = db
    .prepare('SELECT type, ebics_code, meta, actor, created_at FROM order_events WHERE order_id = ? ORDER BY id')
    .all(orderId) as {
    type: string;
    ebics_code: string | null;
    meta: string;
    actor: string | null;
    created_at: string;
  }[];
  return rows.map((row) => ({
    type: row.type,
    ebics_code: row.ebics_code,
    meta: JSON.parse(row.meta) as Record<string, unknown>,
    actor: row.actor,
    created_at: row.created_at,
  }));
}

/**
 * Fold the stream into a status.
 *
 * Two rules, and the second is why this is not a simple last-write-wins:
 *
 * 1. **A progress event never walks an order back out of a decision.** Once
 *    the bank has said something about this order, a late `initialised` — a
 *    retry that raced, an event replayed out of order — must not turn it back
 *    into work in progress.
 * 2. **A later decision supersedes an earlier one.** An order accepted at
 *    upload and rejected a day later by a payment status report is rejected.
 *    The bank taking a file is not the bank having paid it, so `accepted` is
 *    a decision that can still be overtaken.
 */
export function foldStatus(events: OrderEvent[]): OrderStatus {
  const DECISIONS = new Set(['accepted', 'settled', 'rejected', 'failed']);
  let status: OrderStatus = 'queued';
  let decided = false;

  for (const event of events) {
    if (DECISIONS.has(event.type)) {
      // TWO ANSWERS THAT CANNOT BOTH BE TRUE.
      //
      // `settled` says the money moved; `rejected` says it did not. Either
      // order of arrival is reachable and both are ordinary bank behaviour: a
      // SEPA return lands days after a settlement, and a bank that refused an
      // order in its customer protocol can still send a status report for the
      // same MsgId. Taking the later one picks a side on recency alone.
      //
      // That is not a cosmetic choice. MOD-04 sets a run's items back to
      // inactive on `rejected` — releasing those bills into the pool for
      // another payment run — and marks the run executed on `settled`. So
      // resolving this silently decides between paying a supplier twice and
      // leaving a real invoice unpaid. Neither is a decision to make from the
      // order of two rows.
      //
      // `accepted` is NOT part of this: it means the bank took the file, not
      // that the payment succeeded, so `accepted` → `rejected` is the ordinary
      // path and not a contradiction. `failed` means UNKNOWN — the
      // conversation broke — so any later definite answer resolves it rather
      // than contradicting it.
      const opposes =
        (status === 'settled' && event.type === 'rejected') ||
        (status === 'rejected' && event.type === 'settled');
      if (opposes) status = 'contested';
      // Terminal: once the record holds both answers, nothing later un-holds
      // them. A third event is more to read, not a resolution.
      else if (status !== 'contested') status = event.type as OrderStatus;
      decided = true;
      continue;
    }
    if (decided) continue;
    if (event.type === 'queued' || event.type === 'initialised' || event.type === 'transferred') {
      status = event.type;
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
  const btf = resolveBtf(connection, input.btf);
  const facts = inspectPayload(input.payload, btf);
  return {
    msg_id: facts.msgId,
    payload_sha256: facts.sha256,
    amount_minor: facts.amountMinor,
    tx_count: facts.txCount,
    btf,
    problems: [
      ...checkCeilings(facts, {
        maxAmountMinor: connection.max_amount_minor,
        maxTransfers: connection.max_transfers,
      }),
      ...austrianPaymentProblems(input.payload),
    ],
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
  const btf = resolveBtf(connection, input.btf);
  const at = (ctx.now ?? nowIso)();

  // 1. Replay, on the caller's key — SCOPED TO THIS CONNECTION.
  //
  // The scope matters: an idempotency key is the caller's word, and MOD-04
  // builds it from the run's MsgId. Two connections legitimately carry the
  // same run to two banks, and an unscoped lookup answered the second with the
  // FIRST bank's order and silently dropped the file.
  if (input.idempotencyKey !== undefined) {
    const existing = ctx.db
      .prepare('SELECT * FROM orders WHERE connection_id = ? AND idempotency_key = ?')
      .get(connection.id, input.idempotencyKey) as OrderRow | undefined;
    if (existing !== undefined) {
      return { order: orderDetail(ctx.db, existing.public_id), replayed: true };
    }
  }

  const facts = inspectPayload(input.payload, btf);

  // 2. Replay, on the file's own identity — the layer that catches a caller
  //    who forgot a key, or invented a new one for the same file.
  const seen = ctx.db
    .prepare('SELECT * FROM orders WHERE connection_id = ? AND msg_id = ?')
    .get(connection.id, facts.msgId) as OrderRow | undefined;
  if (seen !== undefined) {
    const previous = orderDetail(ctx.db, seen.public_id);
    // ONLY a finished, successful order replays silently. Everything else gets
    // a 409 that names the state.
    //
    // The inverted version of this test — replay everything except `rejected`
    // and `failed` — looked equivalent and was not. An order stuck at `queued`
    // (the process died between the INSERT and the bank answering) came back
    // as a cheerful success for ever, so that payment file could never be sent
    // again while MOD-04 went on reporting the run as submitted. Enumerating
    // what may replay, rather than what may not, is why this reads the way it
    // does.
    if (previous.status !== 'accepted' && previous.status !== 'settled') {
      throw new DomainError(
        409,
        `this file was already submitted as ${previous.public_id} and is ${previous.status}. ` +
          (previous.status === 'rejected' || previous.status === 'failed'
            ? 'Give the corrected file a new MsgId before resubmitting: the bank rejects a repeated one.'
            : 'Check that order before sending anything else — the bank may already hold this file.'),
      );
    }
    return { order: previous, replayed: true };
  }

  // 3. Ceilings, and the Austrian payment formats — the last gate before the
  //    ES key is used. A malformed Finanzamtszahlung is refused by the bank
  //    AFTER a signature has authorised it, and at class E that signature is
  //    the money; catching it here costs one parse and no round trip.
  const problems = [
    ...checkCeilings(facts, {
      maxAmountMinor: connection.max_amount_minor,
      maxTransfers: connection.max_transfers,
    }),
    ...austrianPaymentProblems(input.payload),
  ];
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
        JSON.stringify(btf),
        facts.sha256,
        facts.amountMinor,
        facts.txCount,
        input.idempotencyKey ?? null,
        ctx.actor ?? null,
        at,
      );
    const id = Number(info.lastInsertRowid);
    recordOrderEvent(ctx.db, {
      orderId: id,
      type: 'queued',
      at,
      actor: ctx.actor ?? null,
      meta: { sha256: facts.sha256 },
    });
    return id;
  })();

  const row = ctx.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow;
  await transmit(ctx, connection, row, { payload: input.payload, btf }, facts);
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
  product_name: string | null;
  product_language: string | null;
  product_institute_id: string | null;
  request_eds: number;
  vop: string;
  max_amount_minor: number;
  max_transfers: number;
}

/** Sign, encrypt, and run the initialisation + transfer phases. */
async function transmit(
  ctx: OrderContext,
  connection: ConnectionRow,
  order: OrderRow,
  input: { payload: Buffer; btf: BtfInput },
  facts: PayloadFacts,
): Promise<void> {
  // `at` is the ENVELOPE's timestamp: it is signed into every request of this
  // conversation and must therefore be one value. `clock()` is the log's, read
  // fresh for each event, so the history records when each step actually
  // happened rather than when the conversation began.
  const clock = ctx.now ?? nowIso;
  const at = clock();
  const subscriber: Subscriber = {
    hostId: connection.host_id,
    partnerId: connection.partner_id,
    userId: connection.user_id,
    ...productOf(connection),
  };

  /**
   * Everything between recording the order and reaching the network.
   *
   * Wrapped so that a throw here — an unreadable key store is the realistic
   * one — becomes a `failed` event on the order rather than an exception
   * escaping to a 500. An order that stays at bare `queued` is the worst of
   * both worlds: nothing was sent, but the MsgId is taken, and the replay
   * guard cannot tell that from a submission that died mid-flight.
   */
  let keys: SubscriberKeys;
  let bank: { authPublicPem: string; encPublicPem: string };
  let packed: string;
  let btf: Btf;
  let segments: string[];
  let transactionKey: Buffer;
  try {
    keys = {
      esPrivatePem: privatePemFor(ctx.db, { connectionId: connection.id, purpose: 'ES', keySecret: ctx.keySecret }).pem,
      esVersion: connection.es_version as EsVersion,
      authPrivatePem: privatePemFor(ctx.db, { connectionId: connection.id, purpose: 'AUTH', keySecret: ctx.keySecret })
        .pem,
      encPrivatePem: privatePemFor(ctx.db, { connectionId: connection.id, purpose: 'ENC', keySecret: ctx.keySecret })
        .pem,
    };

    bank = bankKeysOf(ctx.db, connection.id);
    transactionKey = (ctx.transactionKey ?? newTransactionKey)();

    // Pack once: the segments are slices of THIS string, so the digest the bank
    // checks and the bytes it reassembles come from the same encryption.
    packed = packOrderData(transactionKey, input.payload);
    // The bank's own published maximum, when its profile names one below the
    // protocol's; an explicit context override wins over both (tests use it).
    const limit = ctx.segmentLimit ?? bankProfile(connection.bank_key)?.segmentLimit ?? SEGMENT_LIMIT;
    segments = splitSegments(packed, limit);

    btf = {
      serviceName: input.btf.service_name,
      scope: input.btf.scope,
      option: input.btf.option,
      msgName: input.btf.msg_name,
      msgVersion: input.btf.msg_version,
      container: input.btf.container,
    };
  } catch (err) {
    // Nothing has been signed and nothing has been sent, but the order exists,
    // so it has to carry an outcome a human can act on.
    return fail(ctx, order, clock(), `could not prepare the order: ${err instanceof Error ? err.message : String(err)}`);
  }

  let transactionId: string;
  let ebicsOrderId: string | null = null;
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
      requestEDS: connection.request_eds === 1,
    });
    const response = parseResponse(
      await ctx.transport.send(connection.url, initBody, {
        connection: connection.id,
        order: order.id,
        phase: 'order.initialisation',
      }),
      bank.authPublicPem,
    );

    if (!response.verified) {
      // A response we cannot attribute to the bank is not an answer. Refusing
      // to act on it is the whole reason the key was verified by a human.
      return fail(ctx, order, clock(), `the bank's response could not be verified: ${response.verificationError}`);
    }
    if (!response.verdict.ok) {
      return reject(ctx, order, clock(), response.verdict);
    }
    if (response.transactionId === null) {
      return fail(ctx, order, clock(), 'the bank accepted the initialisation but returned no transaction id');
    }
    transactionId = response.transactionId;
    // The bank's own order number, when it sends one. Optional in H005, so an
    // absent one is not an error — but it is what the customer protocol logs
    // every later action under, so it is worth recording when offered.
    ebicsOrderId = response.orderId;
  } catch (err) {
    // The request never completed. Whether the bank has the file is UNKNOWN,
    // which is precisely why this is `failed` and not `rejected`.
    return fail(ctx, order, clock(), err instanceof Error ? err.message : String(err));
  }

  ctx.db
    .prepare('UPDATE orders SET transaction_id = ?, ebics_order_id = ? WHERE id = ?')
    .run(transactionId, ebicsOrderId, order.id);
  recordOrderEvent(ctx.db, {
    orderId: order.id,
    type: 'initialised',
    at: clock(),
    actor: ctx.actor ?? null,
    meta: {
      transaction_id: transactionId,
      ...(ebicsOrderId === null ? {} : { ebics_order_id: ebicsOrderId }),
      segments: segments.length,
      tx_count: facts.txCount,
    },
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
      const response = parseResponse(
        await ctx.transport.send(connection.url, body, {
          connection: connection.id,
          order: order.id,
          phase: `order.transfer.segment-${number}`,
        }),
        bank.authPublicPem,
      );
      if (!response.verified) {
        return fail(ctx, order, clock(), `the bank's response could not be verified: ${response.verificationError}`);
      }
      if (!response.verdict.ok) {
        return reject(ctx, order, clock(), response.verdict);
      }
      recordOrderEvent(ctx.db, {
        orderId: order.id,
        type: 'segment_sent',
        at: clock(),
        actor: ctx.actor ?? null,
        meta: { segment: number, last },
      });
    } catch (err) {
      return fail(ctx, order, clock(), err instanceof Error ? err.message : String(err));
    }
  }

  recordOrderEvent(ctx.db, {
    orderId: order.id,
    type: 'transferred',
    at: clock(),
    actor: ctx.actor ?? null,
    meta: { segments: segments.length },
  });
  recordOrderEvent(ctx.db, {
    orderId: order.id,
    type: 'accepted',
    at: clock(),
    actor: ctx.actor ?? null,
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
    actor: ctx.actor ?? null,
    code: deciding.code,
    meta: { message: verdict.message, severity: verdict.severity },
  });
}

function fail(ctx: OrderContext, order: OrderRow, at: string, message: string): void {
  recordOrderEvent(ctx.db, { orderId: order.id, type: 'failed', at, actor: ctx.actor ?? null, meta: { message } });
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
