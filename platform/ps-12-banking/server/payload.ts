import { createHash } from 'node:crypto';
import { at, findAll, parse, textOf } from './ebics/xml.js';
import type { BtfInput, FieldError } from '../shared/types.js';

/**
 * Looking inside the file — as little as possible, and no less.
 *
 * This service is deliberately payload-agnostic: a caller hands over bytes and
 * a BTF, and nothing here knows what an invoice is. But two of its promises
 * cannot be kept on opaque bytes:
 *
 * - **"A payment file is submitted at most once."** That needs the file's own
 *   identity, which for an ISO 20022 message is its `MsgId` — the same value
 *   the bank uses for its duplicate check.
 * - **"Ceilings hold."** At signature class E a module's service token is
 *   enough to move money, so the amount and the transfer count have to be known
 *   *before* anything is signed, and they live inside the file.
 *
 * So the compromise is narrow and stated: when the BTF says the message is
 * `pain.001`, this file reads exactly four things out of it — MsgId, number of
 * transactions, control sum, currency. Anything else stays opaque, and its
 * identity falls back to the SHA-256 of the bytes, which is a perfectly good
 * answer to "have I sent this before?".
 *
 * It reads. It never rewrites: the bytes that get signed are the bytes the
 * caller supplied, unchanged.
 */

/** What could be learned about a payload. Nulls are honest, not failures. */
export interface PayloadFacts {
  /** The file's identity: its MsgId, or `sha256:<hex>` when it has none. */
  msgId: string;
  /** SHA-256 of exactly the bytes that will be signed. */
  sha256: string;
  /** Total in minor units, when the file states one. */
  amountMinor: number | null;
  /** Number of transactions, when the file states one. */
  txCount: number | null;
  currency: string | null;
  /**
   * How many distinct currencies the file's amounts are in.
   *
   * More than one means `CtrlSum` is a sum of unlike things, so comparing it
   * against a single-currency ceiling is meaningless — see `checkCeilings`.
   */
  currencyCount: number;
  /** True when this was read as an ISO 20022 message rather than as bytes. */
  inspected: boolean;
}

const PAIN_NS_PREFIX = 'urn:iso:std:iso:20022:tech:xsd:';

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Read what can be read.
 *
 * Never throws on a malformed payload: a file this cannot parse is simply
 * opaque, and the *bank* is the authority on whether it is valid. Refusing here
 * would mean this service second-guessing an ISO 20022 schema it does not ship
 * — and being wrong about it would block a payment that was fine.
 */
export function inspectPayload(payload: Buffer, btf: BtfInput): PayloadFacts {
  const sha256 = sha256Hex(payload);
  const opaque: PayloadFacts = {
    msgId: `sha256:${sha256}`,
    sha256,
    amountMinor: null,
    txCount: null,
    currency: null,
    currencyCount: 0,
    inspected: false,
  };

  if (!btf.msg_name.toLowerCase().startsWith('pain.001')) return opaque;

  let root;
  try {
    root = parse(payload.toString('utf8'));
  } catch {
    return opaque;
  }
  if (root.uri === null || !root.uri.startsWith(PAIN_NS_PREFIX)) return opaque;

  const ns = root.uri;
  const header = at(root, ns, 'CstmrCdtTrfInitn', 'GrpHdr');
  if (header === null) return opaque;

  const msgId = textOf(at(header, ns, 'MsgId')).trim();
  const nbOfTxs = textOf(at(header, ns, 'NbOfTxs')).trim();
  const ctrlSum = textOf(at(header, ns, 'CtrlSum')).trim();

  // The currency is on the amounts, not the header. Both the value and the
  // COUNT are carried out: `checkCeilings` refuses a file that mixes them,
  // which needs to know there was more than one — a single `currency: null`
  // cannot tell "mixed" from "none stated".
  const amounts = findAll(root, (node) => node.uri === ns && node.local === 'InstdAmt');
  const currencies = new Set(
    amounts.map((node) => node.attrs.find((a) => a.local === 'Ccy')?.value ?? '').filter((c) => c !== ''),
  );

  return {
    msgId: msgId === '' ? `sha256:${sha256}` : msgId,
    sha256,
    amountMinor: parseDecimalToMinor(ctrlSum),
    txCount: /^\d+$/.test(nbOfTxs) ? Number.parseInt(nbOfTxs, 10) : null,
    currency: currencies.size === 1 ? [...currencies][0]! : null,
    currencyCount: currencies.size,
    inspected: true,
  };
}

/**
 * "1234.56" → 123456.
 *
 * Parsed as digits rather than through `Number`, because the whole point of
 * this value is to be compared against a ceiling: a float that rounds
 * 999999.995 into 999999.99 would let a payment through by a cent, and a file
 * with more precision than the scheme allows should be refused, not truncated.
 */
export function parseDecimalToMinor(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (match === null) return null;
  const minor = `${match[1]}${(match[2] ?? '').padEnd(2, '0')}`;
  const parsed = Number.parseInt(minor, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export interface Ceilings {
  maxAmountMinor: number;
  maxTransfers: number;
}

/**
 * The last check before anything is signed.
 *
 * At signature class E a signed order is money gone, and the credential that
 * reaches this service is a *module's* service token — so the limits are
 * enforced here, on the server, rather than trusted to the caller.
 *
 * An UNREADABLE payload is refused when ceilings are set, and that is
 * deliberate: "I could not tell how much this is" is not a reason to send it.
 * The caller's way out is a BTF that names what the file is.
 */
export function checkCeilings(facts: PayloadFacts, ceilings: Ceilings): FieldError[] {
  const problems: FieldError[] = [];

  if (!facts.inspected) {
    problems.push({
      field: 'payload_base64',
      message:
        'this payload could not be read as the message its BTF names, so its amount cannot be checked ' +
        'against this connection’s limits',
    });
    return problems;
  }

  if (facts.amountMinor === null) {
    problems.push({ field: 'payload_base64', message: 'the file states no control sum, so it cannot be checked against the limit' });
  } else if (facts.amountMinor > ceilings.maxAmountMinor) {
    problems.push({
      field: 'payload_base64',
      message: `the file totals ${formatMinor(facts.amountMinor)} which is over this connection’s limit of ${formatMinor(ceilings.maxAmountMinor)}`,
    });
  }

  // A control sum that adds euros to francs is not a number a ceiling can be
  // compared against. The comment above `currency` used to promise this check
  // and nothing performed it, so a mixed-currency file was measured against a
  // single-currency limit.
  if (facts.currencyCount > 1) {
    problems.push({
      field: 'payload_base64',
      message:
        'this file mixes currencies, so its control sum cannot be checked against a limit — ' +
        'send one file per currency',
    });
  }

  if (facts.txCount === null) {
    problems.push({ field: 'payload_base64', message: 'the file states no transaction count' });
  } else if (facts.txCount > ceilings.maxTransfers) {
    problems.push({
      field: 'payload_base64',
      message: `the file holds ${facts.txCount} transfers, over this connection’s limit of ${ceilings.maxTransfers}`,
    });
  }

  return problems;
}

/** Minor units as a decimal string, for a message a human reads. */
export function formatMinor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
