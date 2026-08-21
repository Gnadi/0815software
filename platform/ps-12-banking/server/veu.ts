import type Database from 'better-sqlite3';
import { DomainError } from './errors.js';
import { nowIso, requireReady } from './connections.js';
import { privatePemFor } from './keystore.js';
import { Transport } from './transport.js';
import {
  buildDownloadSegment,
  buildReceipt,
  buildTransfer,
  buildVeuCancel,
  buildVeuDetail,
  buildVeuOverview,
  buildVeuSignature,
  buildVeuTransactions,
  type BankKeys,
  type Btf,
  type Subscriber,
  type SubscriberKeys,
  type VeuOrderRef,
} from './ebics/envelopes.js';
import {
  decryptTransactionKey,
  newTransactionKey,
  packOrderData,
  unpackOrderData,
  type EsVersion,
} from './ebics/crypto.js';
import { parseResponse, parseVeuDetail, parseVeuOverview, parseVeuTransactions } from './ebics/parse.js';
import { EBICS_NO_DOWNLOAD_DATA } from './ebics/codes.js';
import { productOf } from './connections.js';
import type { BtfInput } from '../shared/types.js';
import type { VeuDetail, VeuOrder, VeuTransactions } from './ebics/parse.js';

/**
 * The distributed-signature queue — VEU, or EDS in the English spec.
 *
 * When an order needs more signatures than it arrived with, a bank asked with
 * `SignatureFlag requestEDS="true"` spools it rather than refusing it. These
 * six order types are how a second signatory then sees it and acts on it.
 *
 * ## The rule this file exists to enforce
 *
 * **A caller never supplies the digest that gets signed.** `sign` and `cancel`
 * fetch the order's `DataDigest` themselves, with `HVD`, immediately before
 * using it. The alternative — taking a digest from the request body — would
 * make this service a signing oracle: hand it any 32 bytes and it returns our
 * ES over them, which is a signature over any document the caller likes,
 * including a payment file it wrote. The extra round trip is the price of not
 * being that.
 *
 * ## What is NOT here
 *
 * Nothing is stored. The queue lives at the bank and these are views of it; a
 * copy here would be a second source of truth that goes stale the moment
 * another signatory acts. `downloads` is for files we are meant to keep.
 */

export interface VeuContext {
  db: Database.Database;
  keySecret: Buffer;
  transport: Transport;
  actor?: string;
  now?: () => string;
}

interface ConnectionRow {
  id: number;
  key: string;
  url: string;
  host_id: string;
  partner_id: string;
  user_id: string;
  es_version: string;
  product_name: string | null;
  product_language: string | null;
  product_institute_id: string | null;
}

/** Which order a per-order request is about, as the API takes it. */
export interface VeuOrderInput {
  /** Defaults to our own partner id — a queue usually holds our own orders. */
  partnerId?: string;
  btf: BtfInput;
  orderId: string;
}

/** `HVU` — what is waiting for a signature. */
export async function overview(
  ctx: VeuContext,
  connectionKey: string,
  options: { orderType?: 'HVU' | 'HVZ'; serviceFilter?: BtfInput[] } = {},
): Promise<VeuOrder[]> {
  const { connection, subscriber, keys, bank, at } = load(ctx, connectionKey);
  const body = buildVeuOverview({
    subscriber,
    keys,
    bank,
    timestamp: at,
    orderType: options.orderType ?? 'HVU',
    ...(options.serviceFilter === undefined ? {} : { serviceFilter: options.serviceFilter.map(toBtf) }),
  });

  const data = await collect(ctx, connection, subscriber, keys, bank, body);
  // An empty queue is the ordinary case and answers EBICS_NO_DOWNLOAD_DATA.
  return data === null ? [] : parseVeuOverview(data.toString('utf8'));
}

/** `HVD` — one order's digest, display file and signers. */
export async function detail(ctx: VeuContext, connectionKey: string, order: VeuOrderInput): Promise<VeuDetail> {
  const { connection, subscriber, keys, bank, at } = load(ctx, connectionKey);
  const body = buildVeuDetail({ subscriber, keys, bank, timestamp: at, order: toRef(subscriber, order) });
  const data = await collect(ctx, connection, subscriber, keys, bank, body);
  if (data === null) throw new DomainError(404, 'the bank has no such order waiting for a signature');
  return parseVeuDetail(data.toString('utf8'));
}

/** `HVT` — the individual payments inside a queued collective order. */
export async function transactions(
  ctx: VeuContext,
  connectionKey: string,
  order: VeuOrderInput,
  options: { completeOrderData?: boolean; fetchLimit?: number; fetchOffset?: number } = {},
): Promise<VeuTransactions> {
  const { connection, subscriber, keys, bank, at } = load(ctx, connectionKey);
  const body = buildVeuTransactions({
    subscriber,
    keys,
    bank,
    timestamp: at,
    order: toRef(subscriber, order),
    ...options,
  });
  const data = await collect(ctx, connection, subscriber, keys, bank, body);
  if (data === null) return { total: 0, transactions: [] };
  return parseVeuTransactions(data.toString('utf8'));
}

/** What a signature or a cancellation did. */
export interface VeuActionResult {
  orderId: string;
  /** The digest that was actually signed or cancelled — fetched, not supplied. */
  dataDigest: string;
  code: string;
  message: string;
}

/**
 * `HVE` — add our signature to a queued order.
 *
 * Fetches the digest with `HVD` first, and refuses when the bank says the
 * order is not `readyToBeSigned`: that flag is the bank telling us this
 * subscriber may not sign this order, and sending anyway wastes a round trip
 * to be told the same thing less clearly.
 */
export async function sign(ctx: VeuContext, connectionKey: string, order: VeuOrderInput): Promise<VeuActionResult> {
  return act(ctx, connectionKey, order, 'sign');
}

/** `HVS` — cancel a queued order, naming the digest `HVD` returned for it. */
export async function cancel(ctx: VeuContext, connectionKey: string, order: VeuOrderInput): Promise<VeuActionResult> {
  return act(ctx, connectionKey, order, 'cancel');
}

async function act(
  ctx: VeuContext,
  connectionKey: string,
  order: VeuOrderInput,
  what: 'sign' | 'cancel',
): Promise<VeuActionResult> {
  const { connection, subscriber, keys, bank, at } = load(ctx, connectionKey);
  const ref = toRef(subscriber, order);

  // THE DIGEST COMES FROM THE BANK, NOT FROM THE CALLER. See the file header.
  const hvd = await collect(
    ctx,
    connection,
    subscriber,
    keys,
    bank,
    buildVeuDetail({ subscriber, keys, bank, timestamp: at, order: ref }),
  );
  if (hvd === null) throw new DomainError(404, 'the bank has no such order waiting for a signature');
  const found = parseVeuDetail(hvd.toString('utf8'));

  const transactionKey = newTransactionKey();
  const shared = { subscriber, keys, bank, timestamp: at, transactionKey, order: ref, dataDigest: found.dataDigest };
  const upload = what === 'sign' ? buildVeuSignature(shared) : buildVeuCancel(shared);

  const init = parseResponse(await ctx.transport.send(connection.url, upload.init), bank.authPublicPem);
  if (!init.verified) {
    throw new DomainError(502, `the bank's response could not be verified: ${init.verificationError}`);
  }
  if (!init.verdict.ok) throw new DomainError(502, init.verdict.message);
  if (init.transactionId === null) throw new DomainError(502, 'the bank accepted the request but opened no transaction');

  // One segment: both payloads are a few hundred bytes.
  const transfer = parseResponse(
    await ctx.transport.send(
      connection.url,
      buildTransfer({
        subscriber,
        keys,
        transactionId: init.transactionId,
        segmentNumber: 1,
        lastSegment: true,
        segment: packOrderData(transactionKey, upload.orderData),
      }),
    ),
    bank.authPublicPem,
  );
  if (!transfer.verified) {
    throw new DomainError(502, `the bank's response could not be verified: ${transfer.verificationError}`);
  }
  if (!transfer.verdict.ok) throw new DomainError(502, transfer.verdict.message);

  return {
    orderId: ref.orderId,
    dataDigest: found.dataDigest,
    code: transfer.verdict.business.code,
    message: transfer.verdict.message,
  };
}

// ── Shared machinery ──────────────────────────────────────────────────

/**
 * Run a download to completion and give back the plaintext, or null when the
 * bank had nothing.
 *
 * The receipt is sent last and its failure is swallowed, for the same reason
 * as in `downloads.ts`: a receipt that did not land makes the bank offer the
 * answer again, which for a queue view costs one extra request and nothing
 * else. Unlike a statement, there is nothing here that can be lost.
 */
async function collect(
  ctx: VeuContext,
  connection: ConnectionRow,
  subscriber: Subscriber,
  keys: SubscriberKeys,
  bank: BankKeys,
  body: string,
): Promise<Buffer | null> {
  const init = parseResponse(await ctx.transport.send(connection.url, body), bank.authPublicPem);
  if (!init.verified) {
    throw new DomainError(502, `the bank's response could not be verified: ${init.verificationError}`);
  }
  if (init.verdict.technical.code === EBICS_NO_DOWNLOAD_DATA || init.verdict.business.code === EBICS_NO_DOWNLOAD_DATA) {
    return null;
  }
  if (!init.verdict.ok) throw new DomainError(502, init.verdict.message);
  if (init.transactionId === null || init.transactionKey === null || init.orderData === null) {
    throw new DomainError(502, 'the bank started a download but did not send the data');
  }

  const transactionKey = decryptTransactionKey(keys.encPrivatePem, Buffer.from(init.transactionKey, 'base64'));
  const parts: string[] = [init.orderData];
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
  try {
    await ctx.transport.send(
      connection.url,
      buildReceipt({ subscriber, keys, transactionId: init.transactionId, positive: true }),
    );
  } catch {
    // See above: re-offering a queue view is free.
  }
  return content;
}

function load(
  ctx: VeuContext,
  connectionKey: string,
): { connection: ConnectionRow; subscriber: Subscriber; keys: SubscriberKeys; bank: BankKeys; at: string } {
  const connection = requireReady(ctx.db, connectionKey) as unknown as ConnectionRow;
  return {
    connection,
    subscriber: {
      hostId: connection.host_id,
      partnerId: connection.partner_id,
      userId: connection.user_id,
      ...productOf(connection),
    },
    keys: {
      esPrivatePem: privatePemFor(ctx.db, { connectionId: connection.id, purpose: 'ES', keySecret: ctx.keySecret }).pem,
      esVersion: connection.es_version as EsVersion,
      authPrivatePem: privatePemFor(ctx.db, { connectionId: connection.id, purpose: 'AUTH', keySecret: ctx.keySecret })
        .pem,
      encPrivatePem: privatePemFor(ctx.db, { connectionId: connection.id, purpose: 'ENC', keySecret: ctx.keySecret })
        .pem,
    },
    bank: bankKeysOf(ctx.db, connection.id),
    at: (ctx.now ?? nowIso)(),
  };
}

function bankKeysOf(db: Database.Database, connectionId: number): BankKeys {
  const rows = db
    .prepare('SELECT purpose, public_pem, verified_at FROM bank_keys WHERE connection_id = ?')
    .all(connectionId) as { purpose: string; public_pem: string; verified_at: string | null }[];
  const auth = rows.find((r) => r.purpose === 'AUTH');
  const enc = rows.find((r) => r.purpose === 'ENC');
  if (auth === undefined || enc === undefined) throw new DomainError(409, 'the bank keys are missing');
  if (auth.verified_at === null || enc.verified_at === null) {
    throw new DomainError(409, 'the bank keys have not been confirmed by a human');
  }
  return { authPublicPem: auth.public_pem, encPublicPem: enc.public_pem };
}

/** A queued order usually belongs to our own customer, so the partner defaults. */
function toRef(subscriber: Subscriber, order: VeuOrderInput): VeuOrderRef {
  if (order.orderId.trim() === '') throw new DomainError(422, 'an order id is required');
  return {
    partnerId: order.partnerId ?? subscriber.partnerId,
    btf: toBtf(order.btf),
    orderId: order.orderId.trim(),
  };
}

function toBtf(btf: BtfInput): Btf {
  return {
    serviceName: btf.service_name,
    msgName: btf.msg_name,
    ...(btf.scope === undefined ? {} : { scope: btf.scope }),
    ...(btf.option === undefined ? {} : { option: btf.option }),
    ...(btf.container === undefined ? {} : { container: btf.container }),
    ...(btf.msg_version === undefined ? {} : { msgVersion: btf.msg_version }),
    ...(btf.msg_variant === undefined ? {} : { msgVariant: btf.msg_variant }),
  };
}
