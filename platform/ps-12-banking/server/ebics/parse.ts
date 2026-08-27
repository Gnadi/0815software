import { at, attrOf, childrenOf, findAll, parse, textOf, type XmlElement } from './xml.js';
import { EBICS_NS, HEV_NS } from './envelopes.js';
import { verdictOf, type Verdict } from './codes.js';
import { verifyAuthSignature } from './dsig.js';
import { publicKeyDigest, publicKeyParts } from './crypto.js';
import { certificateFromBase64, publicPemFromCertificate } from './x509.js';
import { DS_NS } from './dsig.js';

/**
 * Reading what the bank said.
 *
 * Two rules shape this file, and both exist because a response is attacker-
 * reachable input the moment anything sits between us and the bank:
 *
 * 1. **Verify before you believe.** `parseResponse` takes the bank's public key
 *    when we have one and refuses a response whose `AuthSignature` does not
 *    check out. A caller that skips that step gets a `verified: false` it has to
 *    look at, rather than a silently-trusted document.
 * 2. **Both return codes, always.** `verdictOf` reads the technical code from
 *    the header and the business code from the body, because a transport that
 *    succeeded says nothing about whether the payment was accepted.
 */

export class ResponseError extends Error {}

export interface EbicsResponse {
  /** The parsed document, for anything a caller needs beyond the common fields. */
  root: XmlElement;
  /** The bank's verdict, from both return codes. */
  verdict: Verdict;
  /** Present from the initialisation phase onwards. */
  transactionId: string | null;
  /**
   * The bank's own order number for an upload — its handle, not ours.
   *
   * Different from `transactionId`, which identifies one conversation and is
   * forgotten when it ends. This one outlives it: it is what the customer
   * protocol (`HAC`) logs every action under, and what a VEU queue entry is
   * named by. Without recording it, a `HAC` entry saying an order was refused
   * cannot be tied to the payment file it refused.
   */
  orderId: string | null;
  /** How many segments the bank says a download has. */
  segments: number | null;
  /** The current segment's number, during a download transfer. */
  segmentNumber: number | null;
  /** True when the bank marked this the last segment. */
  lastSegment: boolean;
  /** The (still encrypted) order data of a download, base64 as received. */
  orderData: string | null;
  /** The RSA-wrapped transaction key of a download. */
  transactionKey: string | null;
  /** Whether the AuthSignature was checked, and whether it held. */
  verified: boolean;
  /** Why verification failed, when it did. */
  verificationError?: string;
}

/**
 * Parse and — when a bank key is known — verify a response.
 *
 * `bankAuthPublicPem` is optional for exactly one reason: the HPB response that
 * *delivers* the bank's keys cannot be verified against them. Every other call
 * site has a key and must pass it.
 */
export function parseResponse(xml: string, bankAuthPublicPem?: string): EbicsResponse {
  let root: XmlElement;
  try {
    root = parse(xml);
  } catch (err) {
    throw new ResponseError(`the bank's response is not usable XML: ${err instanceof Error ? err.message : err}`);
  }

  if (root.uri !== EBICS_NS) {
    throw new ResponseError(`unexpected response namespace ${root.uri ?? '(none)'} — expected ${EBICS_NS}`);
  }

  const header = at(root, EBICS_NS, 'header');
  const mutable = header === null ? null : at(header, EBICS_NS, 'mutable');
  const technical = textOf(mutable === null ? null : at(mutable, EBICS_NS, 'ReturnCode')).trim();
  const business = textOf(at(root, EBICS_NS, 'body', 'ReturnCode')).trim();
  const reportText = textOf(mutable === null ? null : at(mutable, EBICS_NS, 'ReportText')).trim();

  if (technical === '') {
    throw new ResponseError('the response carries no technical return code');
  }

  const staticPart = header === null ? null : at(header, EBICS_NS, 'static');
  const segmentNumberEl = mutable === null ? null : at(mutable, EBICS_NS, 'SegmentNumber');
  const dataTransfer = at(root, EBICS_NS, 'body', 'DataTransfer');

  let verified = false;
  let verificationError: string | undefined;
  if (bankAuthPublicPem !== undefined) {
    const result = verifyAuthSignature({ root, bankAuthPublicPem });
    verified = result.ok;
    verificationError = result.reason;
  }

  return {
    root,
    // A business code is genuinely absent from many responses (an
    // initialisation acknowledgement has nothing to report yet); treating an
    // absent code as OK is correct, treating an absent TECHNICAL code as OK
    // would not be — hence the throw above.
    verdict: verdictOf(technical, business === '' ? '000000' : business, reportText),
    transactionId: nullIfEmpty(textOf(staticPart === null ? null : at(staticPart, EBICS_NS, 'TransactionID')).trim()),
    // In the MUTABLE header, beside the return code — not the static one where
    // TransactionID lives.
    orderId: nullIfEmpty(textOf(mutable === null ? null : at(mutable, EBICS_NS, 'OrderID')).trim()),
    segments: intOrNull(textOf(header === null ? null : at(header, EBICS_NS, 'static', 'NumSegments')).trim()),
    segmentNumber: intOrNull(textOf(segmentNumberEl).trim()),
    lastSegment: segmentNumberEl !== null && attrOf(segmentNumberEl, 'lastSegment') === 'true',
    orderData: nullIfEmpty(
      textOf(dataTransfer === null ? null : at(dataTransfer, EBICS_NS, 'OrderData')).replace(/\s+/g, ''),
    ),
    transactionKey: nullIfEmpty(
      textOf(
        dataTransfer === null ? null : at(dataTransfer, EBICS_NS, 'DataEncryptionInfo', 'TransactionKey'),
      ).replace(/\s+/g, ''),
    ),
    verified,
    verificationError,
  };
}

function nullIfEmpty(value: string): string | null {
  return value === '' ? null : value;
}

function intOrNull(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  return Number.parseInt(value, 10);
}

// ── HEV: the version probe ────────────────────────────────────────────

/** Which protocol versions a bank advertises, and for which host. */
export interface HevResult {
  hostId: string;
  versions: { protocol: string; revision: string }[];
}

export function parseHev(xml: string): HevResult {
  const root = parse(xml);
  const versions = findAll(root, (n) => n.uri === HEV_NS && n.local === 'VersionNumber').map((node) => ({
    protocol: attrOf(node, 'ProtocolVersion') ?? '',
    revision: textOf(node).trim(),
  }));
  return { hostId: textOf(at(root, HEV_NS, 'HostID')).trim(), versions };
}

// ── HPB: the bank's public keys ───────────────────────────────────────

/** One of the bank's keys, as HPB delivers it. */
export interface BankPublicKey {
  /** "X002" or "E002". */
  version: string;
  modulus: Buffer;
  exponent: Buffer;
  /** SPKI PEM — from the certificate, for use with node:crypto. */
  pem: string;
  /** The certificate as sent, when the bank sent one. Kept as the record. */
  certificatePem: string | null;
  /** The digest an operator compares against the bank's published letter. */
  digest: Buffer;
}

export interface HpbResult {
  authentication: BankPublicKey;
  encryption: BankPublicKey;
}

/**
 * Read the bank's keys out of a decrypted HPB response.
 *
 * The digests computed here are the ones a human has to confirm. Nothing in
 * this file decides that they are right — `connections.ts` will not let a
 * connection go live until an operator says the digests match what the bank
 * published, because the response itself cannot prove it came from the bank.
 */
export function parseHpbOrderData(xml: string): HpbResult {
  const root = parse(xml);

  const read = (container: string, versionElement: string): BankPublicKey => {
    const info = at(root, EBICS_NS, container);
    if (info === null) throw new ResponseError(`the HPB response has no ${container}`);

    // EBICS 3.0 sends the bank's keys as X.509 certificates: `PubKeyInfoType`
    // requires `<ds:X509Data>` and `PubKeyValue` is not in the H005 schema at
    // all. The modulus-and-exponent form is still read as a fallback, because
    // a bank running an H004-era implementation behind an H005 endpoint is
    // exactly the sort of thing a first connection turns up, and accepting it
    // costs nothing — the digest a human confirms is computed the same way
    // either way.
    const certificate = findAll(info, (n) => n.uri === DS_NS && n.local === 'X509Certificate')[0];
    const pem =
      certificate !== undefined
        ? publicPemFromCertificate(certificateFromBase64(textOf(certificate)))
        : legacyPubKeyValuePem(info, container);

    const { modulus, exponent } = publicKeyParts(pem);
    return {
      version: textOf(at(info, EBICS_NS, versionElement)).trim(),
      modulus,
      exponent,
      pem,
      certificatePem: certificate === undefined ? null : certificateFromBase64(textOf(certificate)),
      digest: publicKeyDigest(pem),
    };
  };

  return {
    authentication: read('AuthenticationPubKeyInfo', 'AuthenticationVersion'),
    encryption: read('EncryptionPubKeyInfo', 'EncryptionVersion'),
  };
}

/** The H004-era shape, kept as a fallback. See `parseHpbOrderData`. */
function legacyPubKeyValuePem(info: XmlElement, container: string): string {
  const value = at(info, EBICS_NS, 'PubKeyValue');
  const rsa = value === null ? null : firstRsaKeyValue(value);
  if (rsa === null) {
    throw new ResponseError(`the HPB response has neither an X.509 certificate nor an RSA key in ${container}`);
  }
  return spkiPemFromParts(base64Buffer(textOf(rsa.modulus)), base64Buffer(textOf(rsa.exponent)));
}

function firstRsaKeyValue(value: XmlElement): { modulus: XmlElement; exponent: XmlElement } | null {
  // The key value is in the XML-DSig namespace, not the EBICS one — a detail
  // that quietly returns "no key found" if you look in the wrong namespace.
  const modulus = findAll(value, (n) => n.local === 'Modulus')[0];
  const exponent = findAll(value, (n) => n.local === 'Exponent')[0];
  if (modulus === undefined || exponent === undefined) return null;
  return { modulus, exponent };
}

function base64Buffer(value: string): Buffer {
  return Buffer.from(value.replace(/\s+/g, ''), 'base64');
}

// ── DER encoding for the bank's key ───────────────────────────────────

/**
 * Rebuild an SPKI PEM from a raw modulus and exponent.
 *
 * The bank sends the two integers; `node:crypto` wants a key object. There is
 * no built-in "make me an RSA key from n and e" that takes raw bytes, so the
 * DER is assembled here: a small, well-defined structure, and far less
 * machinery than the alternative of taking on an ASN.1 library.
 */
export function spkiPemFromParts(modulus: Buffer, exponent: Buffer): string {
  const rsaPublicKey = derSequence([derInteger(modulus), derInteger(exponent)]);
  const algorithm = derSequence([
    // OID 1.2.840.113549.1.1.1 (rsaEncryption), then an explicit NULL.
    Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]),
    Buffer.from([0x05, 0x00]),
  ]);
  const spki = derSequence([algorithm, derBitString(rsaPublicKey)]);
  const body = (spki.toString('base64').match(/.{1,64}/g) ?? []).join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derSequence(parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x30]), derLength(body.length), body]);
}

function derInteger(value: Buffer): Buffer {
  // DER integers are signed, so a leading byte >= 0x80 needs a zero in front —
  // omit it and the modulus is read as a negative number.
  const body = value[0]! >= 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value;
  return Buffer.concat([Buffer.from([0x02]), derLength(body.length), body]);
}

function derBitString(content: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([0x00]), content]); // 0 unused bits
  return Buffer.concat([Buffer.from([0x03]), derLength(body.length), body]);
}

/** Every `<ReturnCode>` in a response, for logging a rejection in full. */
export function allReturnCodes(root: XmlElement): string[] {
  return childrenOf(root, EBICS_NS, 'body')
    .flatMap((body) => findAll(body, (n) => n.uri === EBICS_NS && n.local === 'ReturnCode'))
    .map((node) => textOf(node).trim());
}

// ── VEU: reading the distributed-signature queue ──────────────────────

/**
 * One order waiting in the bank's distributed-signature queue.
 *
 * `HVU` and `HVZ` answer with the same shape; `HVZ` fills in more of it. The
 * fields that matter to a human deciding whether to sign are the amount, the
 * account and who signed already — and those come from `HVZ`, which is why an
 * overview built on `HVU` alone is a list of order ids and little else.
 */
export interface VeuOrder {
  /** The bank's id for the queued order — every later request names it. */
  orderId: string;
  /** The BTF it was submitted under. */
  service: {
    serviceName: string;
    scope: string | null;
    option: string | null;
    msgName: string;
    container: string | null;
  };
  orderDataSize: number;
  /** How many signatures it needs, how many it has, and whether we may sign. */
  signing: { required: number; done: number; readyToBeSigned: boolean };
  /** Who submitted it. */
  originator: { partnerId: string; userId: string; name: string | null; timestamp: string };
  /** Who has signed it so far, and at what authorisation level. */
  signers: {
    partnerId: string;
    userId: string;
    name: string | null;
    timestamp: string;
    authorisationLevel: string;
  }[];
  additionalOrderInfo: string | null;
  /**
   * The digest a co-signature is computed over — `HVZ` and `HVD` carry it,
   * `HVU` does not. Base64 as the bank sent it.
   */
  dataDigest: string | null;
  /**
   * From `HVZ` only: the summary a human actually reads before signing.
   *
   * The schema calls this group `HVZPaymentOrderDetailsStructure` and makes
   * every part of it optional, so every field here can be null even when the
   * group itself is present.
   */
  summary: {
    /** How many payments the collective order holds. */
    totalOrders: number | null;
    totalAmount: string | null;
    isCredit: boolean | null;
    currency: string | null;
    /** Free text naming the ordering party, when the bank sends it. */
    orderPartyInfo: string | null;
    /** The account the first payment comes from — a sample, not a total. */
    firstAccount: VeuAccount | null;
  } | null;
}

/** Read an `HVUResponseOrderData` or an `HVZResponseOrderData`. */
export function parseVeuOverview(xml: string): VeuOrder[] {
  const root = parse(xml);
  return childrenOf(root, EBICS_NS, 'OrderDetails').map(readVeuOrder);
}

/**
 * What `HVD` says about one order.
 *
 * `dataDigest` is the whole point: it is what `HVE` signs. A co-signatory must
 * not hash the order data and sign that instead — they may not have the order
 * data at all, which is what `orderDataAvailable` is telling you.
 */
export interface VeuDetail {
  dataDigest: string;
  /** The bank's own human-readable rendering of the order, when it sent one. */
  displayFile: Buffer | null;
  orderDataAvailable: boolean;
  orderDataSize: number;
  orderDetailsAvailable: boolean;
  signers: VeuOrder['signers'];
}

export function parseVeuDetail(xml: string): VeuDetail {
  const root = parse(xml);
  const digest = textOf(at(root, EBICS_NS, 'DataDigest')).replace(/\s+/g, '');
  if (digest === '') throw new ResponseError('the HVD response carries no DataDigest');
  const display = textOf(at(root, EBICS_NS, 'DisplayFile')).replace(/\s+/g, '');
  return {
    dataDigest: digest,
    displayFile: display === '' ? null : Buffer.from(display, 'base64'),
    orderDataAvailable: boolOf(root, 'OrderDataAvailable'),
    orderDataSize: intOf(root, 'OrderDataSize'),
    orderDetailsAvailable: boolOf(root, 'OrderDetailsAvailable'),
    signers: readSigners(root),
  };
}

/**
 * One account named by a queued transaction.
 *
 * `role` is the field that matters and the one a first reading misses:
 * `Originator`, `Recipient`, `Charges` or `Other`. An HVT transaction carries
 * two or three of these, and without the role there is no way to tell who is
 * paying whom — which is the entire question a co-signatory is answering.
 */
export interface VeuAccount {
  role: string;
  /** `AccountNumber`, which is an IBAN when `international` is true. */
  number: string | null;
  international: boolean;
  /** `BankCode` — a BIC when it is international. */
  bankCode: string | null;
  holder: string | null;
  /** The bank's own label for this account, from the `Description` attribute. */
  description: string | null;
}

/** One payment inside a queued collective order, as `HVT` describes it. */
export interface VeuTransaction {
  /** Two or three accounts: payer, payee, and sometimes a charges account. */
  accounts: VeuAccount[];
  amount: string;
  currency: string | null;
  /** True when the money comes IN. Absent on plenty of banks. */
  isCredit: boolean | null;
  executionDate: string | null;
  descriptions: { type: string; text: string }[];
}

export interface VeuTransactions {
  /** How many the order holds in total — not how many came back. */
  total: number;
  transactions: VeuTransaction[];
}

export function parseVeuTransactions(xml: string): VeuTransactions {
  const root = parse(xml);
  return {
    total: intOf(root, 'NumOrderInfos'),
    transactions: childrenOf(root, EBICS_NS, 'OrderInfo').map((info) => {
        const amount = at(info, EBICS_NS, 'Amount');
        const isCredit = amount === null ? null : attrOf(amount, 'isCredit');
        return {
          accounts: childrenOf(info, EBICS_NS, 'AccountInfo').map(readAccount),
          amount: textOf(amount).trim(),
          currency: amount === null ? null : (attrOf(amount, 'Currency') ?? null),
          isCredit: credit(isCredit),
          executionDate: nullIfBlank(textOf(at(info, EBICS_NS, 'ExecutionDate'))),
          descriptions: childrenOf(info, EBICS_NS, 'Description').map((d) => ({
            type: attrOf(d, 'Type') ?? '',
            text: textOf(d).trim(),
          })),
        };
      }),
  };
}

function readVeuOrder(details: XmlElement): VeuOrder {
  const service = at(details, EBICS_NS, 'Service');
  const signing = at(details, EBICS_NS, 'SigningInfo');
  const originator = at(details, EBICS_NS, 'OriginatorInfo');
  const digest = textOf(at(details, EBICS_NS, 'DataDigest')).replace(/\s+/g, '');
  const container = service === null ? null : at(service, EBICS_NS, 'Container');

  return {
    orderId: textOf(at(details, EBICS_NS, 'OrderID')).trim(),
    service: {
      serviceName: textOf(service === null ? null : at(service, EBICS_NS, 'ServiceName')).trim(),
      scope: service === null ? null : nullIfBlank(textOf(at(service, EBICS_NS, 'Scope'))),
      option: service === null ? null : nullIfBlank(textOf(at(service, EBICS_NS, 'ServiceOption'))),
      msgName: textOf(service === null ? null : at(service, EBICS_NS, 'MsgName')).trim(),
      container: container === null ? null : (attrOf(container, 'containerType') ?? null),
    },
    orderDataSize: intOf(details, 'OrderDataSize'),
    signing: {
      required: Number(signing === null ? 0 : (attrOf(signing, 'NumSigRequired') ?? 0)),
      done: Number(signing === null ? 0 : (attrOf(signing, 'NumSigDone') ?? 0)),
      // Absent reads as false. This flag is the bank telling us whether OUR
      // subscriber may sign — guessing "probably yes" would put a signature
      // request on screen that the bank is going to refuse.
      readyToBeSigned: (signing === null ? '' : attrOf(signing, 'readyToBeSigned')) === 'true',
    },
    originator: {
      partnerId: textOf(originator === null ? null : at(originator, EBICS_NS, 'PartnerID')).trim(),
      userId: textOf(originator === null ? null : at(originator, EBICS_NS, 'UserID')).trim(),
      name: originator === null ? null : nullIfBlank(textOf(at(originator, EBICS_NS, 'Name'))),
      timestamp: textOf(originator === null ? null : at(originator, EBICS_NS, 'Timestamp')).trim(),
    },
    signers: readSigners(details),
    additionalOrderInfo: nullIfBlank(textOf(at(details, EBICS_NS, 'AdditionalOrderInfo'))),
    dataDigest: digest === '' ? null : digest,
    summary: readSummary(details),
  };
}

function readSigners(scope: XmlElement): VeuOrder['signers'] {
  return childrenOf(scope, EBICS_NS, 'SignerInfo').map((signer) => {
      const permission = at(signer, EBICS_NS, 'Permission');
      return {
        partnerId: textOf(at(signer, EBICS_NS, 'PartnerID')).trim(),
        userId: textOf(at(signer, EBICS_NS, 'UserID')).trim(),
        name: nullIfBlank(textOf(at(signer, EBICS_NS, 'Name'))),
        timestamp: textOf(at(signer, EBICS_NS, 'Timestamp')).trim(),
        authorisationLevel: permission === null ? '' : (attrOf(permission, 'AuthorisationLevel') ?? ''),
      };
    });
}

/**
 * The payment summary `HVZ` folds in and `HVU` does not.
 *
 * Every field is optional in the schema — the whole group is `minOccurs="0"`
 * and so is each element inside it — so all of it is read defensively. A bank
 * that sends the group but omits an element must produce a null, not an
 * exception in the middle of an operator's overview.
 *
 * Note `Currency` is a SIBLING of `TotalAmount`, not an attribute on it. The
 * amount's only attribute is `isCredit`. Reading it the other way produced a
 * currency that was always null and an amount that looked fine, which is the
 * quietest kind of wrong.
 */
function readSummary(details: XmlElement): VeuOrder['summary'] {
  const totalOrders = at(details, EBICS_NS, 'TotalOrders');
  const total = at(details, EBICS_NS, 'TotalAmount');
  const currency = at(details, EBICS_NS, 'Currency');
  const first = at(details, EBICS_NS, 'FirstOrderInfo');
  if (totalOrders === null && total === null && currency === null && first === null) return null;

  const account = first === null ? null : at(first, EBICS_NS, 'AccountInfo');
  return {
    totalOrders: totalOrders === null ? null : intOf(details, 'TotalOrders'),
    totalAmount: total === null ? null : nullIfBlank(textOf(total)),
    isCredit: total === null ? null : credit(attrOf(total, 'isCredit')),
    currency: currency === null ? null : nullIfBlank(textOf(currency)),
    orderPartyInfo: first === null ? null : nullIfBlank(textOf(at(first, EBICS_NS, 'OrderPartyInfo'))),
    firstAccount: account === null ? null : readAccount(account),
  };
}

/**
 * An `AccountInfo`, in either of the two shapes the schema allows for each of
 * its parts: an international account number or a national one, an
 * international bank code or a national one.
 */
function readAccount(account: XmlElement): VeuAccount {
  const number =
    at(account, EBICS_NS, 'AccountNumber') ?? at(account, EBICS_NS, 'NationalAccountNumber');
  const bankCode = at(account, EBICS_NS, 'BankCode') ?? at(account, EBICS_NS, 'NationalBankCode');
  const holder = at(account, EBICS_NS, 'AccountHolder');
  return {
    // Required by the schema on whichever element is present, so an empty
    // string here means the bank sent something the schema forbids.
    role: number === null ? '' : (attrOf(number, 'Role') ?? ''),
    number: number === null ? null : nullIfBlank(textOf(number)),
    international: number !== null && attrOf(number, 'international') === 'true',
    bankCode: bankCode === null ? null : nullIfBlank(textOf(bankCode)),
    holder: holder === null ? null : nullIfBlank(textOf(holder)),
    description: number === null ? null : nullIfBlank(attrOf(number, 'Description') ?? ''),
  };
}

function credit(value: string | null | undefined): boolean | null {
  return value === undefined || value === null ? null : value === 'true';
}

function boolOf(scope: XmlElement, name: string): boolean {
  return textOf(at(scope, EBICS_NS, name)).trim() === 'true';
}

function intOf(scope: XmlElement, name: string): number {
  const value = Number.parseInt(textOf(at(scope, EBICS_NS, name)).trim(), 10);
  return Number.isFinite(value) ? value : 0;
}

function nullIfBlank(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}

// ── HTD and HKD: what this subscriber and this customer may do ────────

/** One order type the bank says is available, from `PartnerInfo/OrderInfo`. */
export interface AvailableOrder {
  /** `BTU`, `BTD`, `HAC`, … */
  adminOrderType: string;
  /** The BTF, for `BTU`/`BTD`. Absent on an administrative order type. */
  service: VeuOrder['service'] | null;
  description: string;
  /** How many signatures the bank requires for it. */
  signaturesRequired: number | null;
}

/** One thing this subscriber is permitted to do, from `UserInfo/Permission`. */
export interface UserPermission {
  adminOrderType: string;
  service: VeuOrder['service'] | null;
  accountId: string | null;
  /** Per-order ceiling the BANK enforces, in the file's own units. */
  maxAmount: string | null;
  /** `E`, `A`, `B` or `T` — which signature class this subscriber holds. */
  authorisationLevel: string | null;
}

/**
 * An account the customer holds, as the bank lists it.
 *
 * The schema carries the account number twice over — `AccountNumber` with
 * `international="true"` is an IBAN, without it a national number, and both
 * may be present (the choice allows two). Same for `BankCode`/BIC. So they are
 * split here rather than folded into one field, because "the account number"
 * is not one thing.
 */
export interface CustomerAccount {
  /** The bank's own id for it, which a `Permission/AccountID` refers to. */
  id: string;
  iban: string | null;
  /** A national account number, or one in a free format the bank names. */
  nationalNumber: string | null;
  bic: string | null;
  nationalBankCode: string | null;
  holder: string | null;
  /** Attributes on the account, not elements — `Currency` defaults to EUR. */
  currency: string;
  description: string | null;
}

/** One subscriber, and what the bank lets them do. */
export interface SubscriberInfo {
  userId: string;
  /** `Ready`, `New`, `Suspended` — the bank's own word for this subscriber. */
  status: string;
  name: string | null;
  permissions: UserPermission[];
}

/**
 * What `HTD` (one subscriber) or `HKD` (the whole customer) answered.
 *
 * This is the bank telling you what it thinks you may do — which is worth
 * more than any transcribed table, because it is specific to this contract and
 * cannot go stale. `orders` is the definitive list of BTFs available to this
 * customer; `subscribers[].permissions` narrows it per person, with the
 * signature class and any per-order ceiling the bank enforces.
 */
export interface CustomerData {
  partner: {
    name: string | null;
    addressLines: string[];
    hostId: string;
  };
  accounts: CustomerAccount[];
  /** Every order type the bank offers this customer. */
  orders: AvailableOrder[];
  /** One entry for HTD, potentially many for HKD. */
  subscribers: SubscriberInfo[];
}

export function parseCustomerData(xml: string): CustomerData {
  const root = parse(xml);
  const partner = at(root, EBICS_NS, 'PartnerInfo');
  const address = partner === null ? null : at(partner, EBICS_NS, 'AddressInfo');
  const bank = partner === null ? null : at(partner, EBICS_NS, 'BankInfo');

  return {
    partner: {
      name: address === null ? null : nullIfBlank(textOf(at(address, EBICS_NS, 'Name'))),
      addressLines:
        address === null
          ? []
          : (['Street', 'PostCode', 'City', 'Region', 'Country'] as const)
              .map((name) => textOf(at(address, EBICS_NS, name)).trim())
              .filter((line) => line !== ''),
      hostId: bank === null ? '' : textOf(at(bank, EBICS_NS, 'HostID')).trim(),
    },
    accounts: partner === null ? [] : childrenOf(partner, EBICS_NS, 'AccountInfo').map(readAccountInfo),
    orders: partner === null ? [] : childrenOf(partner, EBICS_NS, 'OrderInfo').map(readOrderInfo),
    // HTD carries one UserInfo, HKD carries one per subscriber. Same reader.
    subscribers: childrenOf(root, EBICS_NS, 'UserInfo').map(readSubscriber),
  };
}

function readAccountInfo(account: XmlElement): CustomerAccount {
  // `international="true"` is what makes an AccountNumber an IBAN. Reading the
  // first AccountNumber as one would put a German account number in an IBAN
  // field, which every consumer downstream would then treat as payable.
  const numbers = childrenOf(account, EBICS_NS, 'AccountNumber');
  const codes = childrenOf(account, EBICS_NS, 'BankCode');
  const iban = numbers.find((n) => attrOf(n, 'international') === 'true');
  const bic = codes.find((c) => attrOf(c, 'international') === 'true');
  const nationalNumber =
    numbers.find((n) => attrOf(n, 'international') !== 'true') ??
    at(account, EBICS_NS, 'NationalAccountNumber');
  const nationalBankCode =
    codes.find((c) => attrOf(c, 'international') !== 'true') ?? at(account, EBICS_NS, 'NationalBankCode');

  return {
    id: attrOf(account, 'ID') ?? '',
    iban: iban === undefined ? null : nullIfBlank(textOf(iban)),
    nationalNumber: nationalNumber === undefined || nationalNumber === null ? null : nullIfBlank(textOf(nationalNumber)),
    bic: bic === undefined ? null : nullIfBlank(textOf(bic)),
    nationalBankCode:
      nationalBankCode === undefined || nationalBankCode === null ? null : nullIfBlank(textOf(nationalBankCode)),
    holder: nullIfBlank(textOf(at(account, EBICS_NS, 'AccountHolder'))),
    // Both are ATTRIBUTES on AccountType, not elements, and Currency has a
    // schema default of EUR that an absent attribute means literally.
    currency: attrOf(account, 'Currency') ?? 'EUR',
    description: attrOf(account, 'Description') ?? null,
  };
}

function readOrderInfo(info: XmlElement): AvailableOrder {
  const required = textOf(at(info, EBICS_NS, 'NumSigRequired')).trim();
  return {
    adminOrderType: textOf(at(info, EBICS_NS, 'AdminOrderType')).trim(),
    service: readService(at(info, EBICS_NS, 'Service')),
    description: textOf(at(info, EBICS_NS, 'Description')).trim(),
    signaturesRequired: required === '' ? null : Number.parseInt(required, 10),
  };
}

function readSubscriber(user: XmlElement): SubscriberInfo {
  const id = at(user, EBICS_NS, 'UserID');
  return {
    userId: textOf(id).trim(),
    // Required by the schema; empty means the bank sent something it forbids.
    status: id === null ? '' : (attrOf(id, 'Status') ?? ''),
    name: nullIfBlank(textOf(at(user, EBICS_NS, 'Name'))),
    permissions: childrenOf(user, EBICS_NS, 'Permission').map((permission) => ({
      adminOrderType: textOf(at(permission, EBICS_NS, 'AdminOrderType')).trim(),
      service: readService(at(permission, EBICS_NS, 'Service')),
      accountId: nullIfBlank(textOf(at(permission, EBICS_NS, 'AccountID'))),
      maxAmount: nullIfBlank(textOf(at(permission, EBICS_NS, 'MaxAmount'))),
      authorisationLevel: attrOf(permission, 'AuthorisationLevel') ?? null,
    })),
  };
}

/** A `Service` element, shared by OrderInfo and Permission. */
function readService(service: XmlElement | null): VeuOrder['service'] | null {
  if (service === null) return null;
  const container = at(service, EBICS_NS, 'Container');
  return {
    serviceName: textOf(at(service, EBICS_NS, 'ServiceName')).trim(),
    scope: nullIfBlank(textOf(at(service, EBICS_NS, 'Scope'))),
    option: nullIfBlank(textOf(at(service, EBICS_NS, 'ServiceOption'))),
    msgName: textOf(at(service, EBICS_NS, 'MsgName')).trim(),
    container: container === null ? null : (attrOf(container, 'containerType') ?? null),
  };
}

// ── HPD and HAA: what the bank supports, and what it has waiting ──────

/** One URL the bank publishes for itself, with the date it takes effect. */
export interface BankUrl {
  url: string;
  validFrom: string | null;
}

/**
 * What `HPD` answered: the bank's own access and protocol parameters.
 *
 * The versions are the useful part. This service speaks H005/X002/E002 and
 * A005 or A006, and a bank that does not list one of those will refuse
 * everything later with a code that says less than this does. `optionalFeatures`
 * says whether recovery, pre-validation, `HKD`/`HTD` and `HAA` are available at
 * all — the last two being exactly the reads a client would otherwise discover
 * are unsupported by trying them.
 */
export interface BankParameters {
  access: {
    institute: string;
    hostId: string | null;
    urls: BankUrl[];
  };
  versions: {
    /** Space-separated lists in the schema; split here. */
    protocol: string[];
    authentication: string[];
    encryption: string[];
    signature: string[];
  };
  /**
   * Each flag defaults to TRUE when its element is present without the
   * attribute, and is absent from this map when the element is missing — the
   * schema's own distinction between "supported" and "not stated".
   */
  optionalFeatures: {
    recovery?: boolean;
    preValidation?: boolean;
    clientDataDownload?: boolean;
    downloadableOrderData?: boolean;
  };
}

export function parseBankParameters(xml: string): BankParameters {
  const root = parse(xml);
  const access = at(root, EBICS_NS, 'AccessParams');
  const protocol = at(root, EBICS_NS, 'ProtocolParams');
  const versions = protocol === null ? null : at(protocol, EBICS_NS, 'Version');

  // Present without the attribute means supported: the schema's default is
  // `true`, and reading an absent attribute as `false` would report a working
  // feature as missing.
  const flag = (name: string): boolean | undefined => {
    const element = protocol === null ? null : at(protocol, EBICS_NS, name);
    if (element === null) return undefined;
    return (attrOf(element, 'supported') ?? 'true') === 'true';
  };
  const list = (name: string): string[] =>
    versions === null ? [] : textOf(at(versions, EBICS_NS, name)).trim().split(/\s+/).filter((v) => v !== '');

  const features: BankParameters['optionalFeatures'] = {};
  for (const [key, element] of [
    ['recovery', 'Recovery'],
    ['preValidation', 'PreValidation'],
    ['clientDataDownload', 'ClientDataDownload'],
    ['downloadableOrderData', 'DownloadableOrderData'],
  ] as const) {
    const value = flag(element);
    if (value !== undefined) features[key] = value;
  }

  return {
    access: {
      institute: access === null ? '' : textOf(at(access, EBICS_NS, 'Institute')).trim(),
      hostId: access === null ? null : nullIfBlank(textOf(at(access, EBICS_NS, 'HostID'))),
      urls:
        access === null
          ? []
          : childrenOf(access, EBICS_NS, 'URL').map((url) => ({
              url: textOf(url).trim(),
              validFrom: attrOf(url, 'valid_from') ?? null,
            })),
    },
    versions: {
      protocol: list('Protocol'),
      authentication: list('Authentication'),
      encryption: list('Encryption'),
      signature: list('Signature'),
    },
    optionalFeatures: features,
  };
}

/**
 * What `HAA` answered: the BTFs the bank has data waiting for, right now.
 *
 * Different from `HTD`'s order list, and the difference is worth keeping
 * straight: `HTD` says what this customer is *permitted* to fetch, `HAA` says
 * what is *actually waiting*. A tick driven by `HAA` asks only for files that
 * exist, instead of asking for everything and being told `090005` most of the
 * time.
 */
export function parseAvailableOrderData(xml: string): NonNullable<AvailableOrder['service']>[] {
  return childrenOf(parse(xml), EBICS_NS, 'Service')
    .map(readService)
    .filter((service): service is NonNullable<AvailableOrder['service']> => service !== null);
}
