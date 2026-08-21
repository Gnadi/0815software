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
