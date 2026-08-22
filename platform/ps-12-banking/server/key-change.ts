import { DomainError } from './errors.js';
import { openSession, type SessionContext } from './bank-session.js';
import { nowIso, recordEvent } from './connections.js';
import {
  activatePendingKeys,
  discardPendingKeys,
  generatePendingKeys,
  pendingCertificatePem,
  pendingRecords,
  type KeyPurpose,
  type PublicKeyRecord,
} from './keystore.js';
import { buildKeyChangeAll, buildKeyChangeAuth, buildTransfer } from './ebics/envelopes.js';
import { newTransactionKey, packOrderData, type EsVersion } from './ebics/crypto.js';
import { parseResponse } from './ebics/parse.js';

/**
 * `HCA` and `HCS` — replacing our own keys without another paper letter.
 *
 * ## Why this exists
 *
 * Until now the only way to change a subscriber key was `SPR`, a new
 * connection, a printed INI letter and a wait of days while the bank processes
 * it. That is an acceptable answer to "the key expired" and a bad one to "the
 * key may have leaked", which is the case where the delay is the damage.
 *
 * `HCA` replaces the authentication and encryption keys. `HCS` replaces those
 * **and the ES key** — the one that authorises payments, and therefore the one
 * that matters after a compromise. The request itself is signed with the keys
 * the bank already knows, and that signature is the authorisation: the bank
 * verifies, with a key it already trusts, that whoever holds it asked for the
 * replacement.
 *
 * ## The ordering, which is the whole design
 *
 * 1. Generate the replacements and **commit them as pending**.
 * 2. Send the request, signed with the current keys.
 * 3. Only on the bank's acceptance, retire the old and promote the pending.
 *
 * Step 1 before step 2 is not an optimisation. The unrecoverable failure here
 * is the bank moving to a key this service does not hold — from that point no
 * message we can send is valid and the fix is re-initialising on paper. A
 * pending set that never gets activated is, by contrast, a row to delete.
 *
 * That ordering leaves exactly one gap: the bank accepts and this service dies
 * before step 3. The keys are on disk, so nothing is lost, but the two sides
 * disagree about which key is live. `completeKeyChange` is the door out of
 * that, and it is deliberately a separate, explicitly-named operation rather
 * than something inferred — an operator has to have established, with the bank,
 * that the change went through.
 */

export interface KeyChangeResult {
  /** Which order type was sent. */
  orderType: 'HCA' | 'HCS';
  /** The keys now in force — after a successful change, the new ones. */
  keys: PublicKeyRecord[];
  code: string;
  message: string;
}

const PURPOSES: Record<'HCA' | 'HCS', KeyPurpose[]> = {
  HCA: ['AUTH', 'ENC'],
  // ES first, so a reader sees immediately that this is the one that moves the
  // key which authorises payments.
  HCS: ['ES', 'AUTH', 'ENC'],
};

/**
 * Rotate this connection's keys.
 *
 * `includeSignature` chooses between `HCA` and `HCS`. It defaults to false
 * because `HCA` is the routine case (a certificate nearing expiry) and `HCS`
 * changes the key that signs money — a choice worth making explicitly.
 */
export async function changeKeys(
  ctx: SessionContext,
  connectionKey: string,
  options: { includeSignature?: boolean } = {},
): Promise<KeyChangeResult> {
  const session = openSession(ctx, connectionKey);
  const { connection, subscriber, keys, bank, at } = session;
  const orderType = options.includeSignature === true ? 'HCS' : 'HCA';

  // A pending set from a different order type would send certificates for keys
  // this request does not name — HCA carrying an unused pending ES key, say.
  // Refusing is right: the operator has to say which change they meant.
  const existing = pendingRecords(ctx.db, connection.id);
  if (existing.length > 0 && existing.length !== PURPOSES[orderType].length) {
    throw new DomainError(
      409,
      `this connection has a pending key change for ${existing.length} keys, which is not the ${PURPOSES[orderType].length} ` +
        `that ${orderType} replaces. Complete or discard it before starting a different one.`,
    );
  }

  // COMMITTED BEFORE ANYTHING GOES ON THE WIRE. See the header.
  generatePendingKeys(ctx.db, {
    connectionId: connection.id,
    keySecret: ctx.keySecret,
    purposes: PURPOSES[orderType],
    esVersion: connection.es_version as EsVersion,
    now: at,
    subject: { partnerId: connection.partner_id, userId: connection.user_id },
  });
  recordEvent(ctx.db, {
    connectionId: connection.id,
    type: 'key_change_prepared',
    actor: ctx.actor,
    meta: { orderType },
    at,
  });

  const certificate = (purpose: KeyPurpose): string =>
    pendingCertificatePem(ctx.db, { connectionId: connection.id, purpose });
  const transactionKey = newTransactionKey();
  const shared = { subscriber, keys, bank, transactionKey, timestamp: at };
  const upload =
    orderType === 'HCS'
      ? buildKeyChangeAll({
          ...shared,
          replacement: {
            esCertificatePem: certificate('ES'),
            esVersion: connection.es_version as EsVersion,
            authCertificatePem: certificate('AUTH'),
            encCertificatePem: certificate('ENC'),
          },
        })
      : buildKeyChangeAuth({
          ...shared,
          replacement: { authCertificatePem: certificate('AUTH'), encCertificatePem: certificate('ENC') },
        });

  const init = parseResponse(await ctx.transport.send(connection.url, upload.init), bank.authPublicPem);
  refuse(ctx, connection.id, orderType, init, at);
  if (init.transactionId === null) {
    throw new DomainError(502, 'the bank accepted the request but opened no transaction');
  }

  // One segment: a handful of certificates is a few kilobytes at most.
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
  refuse(ctx, connection.id, orderType, transfer, at);

  // ACCEPTED. From here the bank expects the new keys, so promote them.
  const promoted = activatePendingKeys(ctx.db, connection.id, at);
  recordEvent(ctx.db, {
    connectionId: connection.id,
    type: 'keys_changed',
    actor: ctx.actor,
    meta: { orderType, digests: promoted.map((k) => ({ purpose: k.purpose, digest: k.digest })) },
    at,
  });

  return {
    orderType,
    keys: promoted,
    code: transfer.verdict.business.code,
    message: transfer.verdict.message,
  };
}

/**
 * Record the outcome of a refusal and stop — leaving the pending keys alone.
 *
 * They are deliberately NOT discarded here. A refusal at the transfer phase is
 * ambiguous from this side: the bank may have registered the change and failed
 * afterwards. Discarding on a guess is the one move that cannot be undone, so
 * the operator decides, with `discardKeyChange`, once they know.
 */
function refuse(
  ctx: SessionContext,
  connectionId: number,
  orderType: string,
  response: ReturnType<typeof parseResponse>,
  at: string,
): void {
  if (!response.verified) {
    throw new DomainError(502, `the bank's response could not be verified: ${response.verificationError}`);
  }
  if (response.verdict.ok) return;
  recordEvent(ctx.db, {
    connectionId,
    type: 'key_change_refused',
    actor: ctx.actor,
    meta: { orderType, code: response.verdict.technical.code, message: response.verdict.message },
    at,
  });
  throw new DomainError(
    502,
    `${response.verdict.message} — the keys were NOT changed. The prepared keys are still pending; ` +
      'discard them once you have established with the bank that the change did not go through.',
  );
}

/** What a pending key change looks like from outside. */
export function pendingKeyChange(ctx: SessionContext, connectionKey: string): PublicKeyRecord[] {
  return pendingRecords(ctx.db, connectionIdOf(ctx, connectionKey));
}

/**
 * Promote a pending set the bank has accepted but this service never recorded.
 *
 * The recovery for a crash between the bank's acceptance and step 3. It moves
 * the connection to keys the operator must have CONFIRMED the bank holds —
 * getting that wrong leaves every later message signed with a key the bank has
 * retired, which is the same outage from the other side.
 */
export function completeKeyChange(ctx: SessionContext, connectionKey: string): PublicKeyRecord[] {
  const connectionId = connectionIdOf(ctx, connectionKey);
  if (pendingRecords(ctx.db, connectionId).length === 0) {
    throw new DomainError(409, 'this connection has no pending key change');
  }
  const at = (ctx.now ?? nowIso)();
  const promoted = activatePendingKeys(ctx.db, connectionId, at);
  recordEvent(ctx.db, {
    connectionId,
    type: 'keys_changed',
    actor: ctx.actor,
    meta: { manual: true, digests: promoted.map((k) => ({ purpose: k.purpose, digest: k.digest })) },
    at,
  });
  return promoted;
}

/** Throw a pending set away, once the bank has confirmed it did not take. */
export function discardKeyChange(ctx: SessionContext, connectionKey: string): void {
  const connectionId = connectionIdOf(ctx, connectionKey);
  const at = (ctx.now ?? nowIso)();
  if (discardPendingKeys(ctx.db, connectionId, at) === 0) {
    throw new DomainError(409, 'this connection has no pending key change');
  }
  recordEvent(ctx.db, { connectionId, type: 'key_change_discarded', actor: ctx.actor, at });
}

function connectionIdOf(ctx: SessionContext, key: string): number {
  const row = ctx.db.prepare('SELECT id FROM bank_connections WHERE key = ?').get(key) as { id: number } | undefined;
  if (row === undefined) throw new DomainError(404, `no connection "${key}"`);
  return row.id;
}
