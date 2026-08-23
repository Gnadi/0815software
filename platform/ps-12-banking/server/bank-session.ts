import type Database from 'better-sqlite3';
import { DomainError } from './errors.js';
import { nowIso, productOf, requireReady } from './connections.js';
import { privatePemFor } from './keystore.js';
import type { Transport } from './transport.js';
import {
  buildDownloadSegment,
  buildReceipt,
  type BankKeys,
  type Subscriber,
  type SubscriberKeys,
} from './ebics/envelopes.js';
import { decryptTransactionKey, unpackOrderData, type EsVersion } from './ebics/crypto.js';
import { parseResponse } from './ebics/parse.js';
import { EBICS_NO_DOWNLOAD_DATA } from './ebics/codes.js';

/**
 * One connection, opened for one exchange — and the download loop that every
 * read of the bank runs.
 *
 * Three files were assembling the same five things (the connection row, our
 * subscriber, our three private keys, the bank's two public keys, the
 * timestamp) and two of them were also walking the same segment loop. That is
 * one loop too many for something whose failure mode is a file the bank
 * believes it delivered.
 *
 * ## What is NOT here
 *
 * `downloads.ts` keeps its own copy of the loop, and deliberately: it has to
 * commit the bytes to the database *between* the last segment and the receipt.
 * Everything in this file acknowledges as soon as it has the data, which is
 * right for a queue view and wrong for a bank statement. Folding the two
 * together would put a `store this` callback in the middle of the loop and
 * make the ordering rule invisible — see the header of `downloads.ts` for why
 * that ordering is the one thing there worth protecting.
 */

export interface SessionContext {
  db: Database.Database;
  keySecret: Buffer;
  transport: Transport;
  actor?: string;
  now?: () => string;
}

/** The connection columns anything talking to a bank needs. */
export interface ConnectionRow {
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

export interface BankSession {
  connection: ConnectionRow;
  subscriber: Subscriber;
  keys: SubscriberKeys;
  bank: BankKeys;
  /** One timestamp for the whole exchange, so a retry is byte-identical. */
  at: string;
}

/**
 * Open a session on a connection that is `ready`.
 *
 * `ready` means a human confirmed the bank's key digests. Everything reached
 * through this function therefore inherits that gate, which is the point of
 * having one door.
 */
export function openSession(ctx: SessionContext, connectionKey: string): BankSession {
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
    bank: verifiedBankKeys(ctx.db, connection.id),
    at: (ctx.now ?? nowIso)(),
  };
}

/**
 * The bank's public keys, and only if a human confirmed their digests.
 *
 * The check is repeated here rather than left to `requireReady` because these
 * are the keys an outgoing message is encrypted to and an incoming one is
 * verified against. Falling back to unconfirmed keys would make the human step
 * decorative.
 */
export function verifiedBankKeys(db: Database.Database, connectionId: number): BankKeys {
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

/**
 * Run a download to completion and give back the plaintext, or null when the
 * bank had nothing.
 *
 * The receipt goes out last and its failure is swallowed: a receipt that did
 * not land makes the bank offer the answer again, which for a view of
 * something the bank still holds costs one extra request and nothing else.
 * Nothing read through here is the only copy of anything.
 */
export async function collectDownload(
  ctx: SessionContext,
  session: BankSession,
  body: string,
): Promise<Buffer | null> {
  const { connection, subscriber, keys, bank } = session;
  const init = parseResponse(
    await ctx.transport.send(connection.url, body, { connection: connection.id, phase: 'download.initialisation' }),
    bank.authPublicPem,
  );
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
  // Segments are 1-based and the first arrived with the initialisation.
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
        { connection: connection.id, phase: `download.segment-${number}` },
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
      { connection: connection.id, phase: 'download.receipt' },
    );
  } catch {
    // See above: being re-offered a view is free.
  }
  return content;
}
