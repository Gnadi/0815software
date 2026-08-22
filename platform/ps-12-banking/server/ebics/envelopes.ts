import { deflateSync } from 'node:zlib';
import { document, el, type NsMap, type XmlElement } from './xml.js';
import { buildAuthSignature, DS_NS, EBICS_NS } from './dsig.js';
import {
  encryptTransactionKey,
  packOrderData,
  publicKeyDigest,
  sha256,
  signDigest,
  signOrderData,
  type EsVersion,
} from './crypto.js';
import { certificateDer } from './x509.js';

/**
 * The EBICS 3.0 (H005) messages this service sends.
 *
 * Five shapes cover the whole protocol, and they differ in how much protection
 * they carry — which is the thing to keep straight, because it is decided by
 * what the bank can possibly know at that moment:
 *
 * | Message | Used for | Protection |
 * | ------- | -------- | ---------- |
 * | `ebicsHEVRequest` | asking which versions a bank speaks | none — it is asked before anything is set up |
 * | `ebicsUnsecuredRequest` | INI, HIA — sending OUR public keys | none, and it cannot have any: the bank has no key of ours yet. This is why the INI letter exists: a signed sheet of paper, posted separately, is what binds these keys to a customer. |
 * | `ebicsNoPubKeyDigestsRequest` | HPB — fetching the BANK's keys | authenticated (X002), but carries no key digests, because we do not have the bank's keys yet to digest |
 * | `ebicsRequest` | BTU upload, BTD download, and every transfer/receipt | fully authenticated and encrypted |
 *
 * Every builder here is **pure**: same inputs, same bytes. Nothing reads the
 * clock or a database — timestamps and nonces are passed in — which is what
 * lets the golden-envelope tests assert exact output, and what lets a request
 * be rebuilt identically when a transfer is resumed.
 */

export { EBICS_NS, DS_NS } from './dsig.js';

/**
 * The signature namespace — a SEPARATE one from the request namespace.
 *
 * `UserSignatureData` and `SignaturePubKeyOrderData` are declared in
 * `ebics_signature_S002.xsd`, whose target namespace is this. Both were built
 * in the H005 namespace for a long time and every test passed, because the
 * mock bank read them back out of the same wrong place.
 */
export const ESIG_NS = 'http://www.ebics.org/S002';

/** The prefixes every message here is written with. */
export const NS: NsMap = { e: EBICS_NS, ds: DS_NS, esig: ESIG_NS };

export const H005 = 'H005';

/**
 * Which client software is speaking — the `Product` element.
 *
 * Optional in H005 (`minOccurs="0"` in both `ebics_request` and
 * `ebics_keymgmt_request`) and easy to dismiss for that reason, but the
 * Austrian specification's own worked `ebicsRequest` example carries it, and
 * banks use it to tell one customer product from another when a support call
 * comes in. `InstituteID` is the id the bank assigned to that product, when it
 * assigned one at all.
 */
export interface Product {
  /** The product identification. `ProductType`: at most 64 characters. */
  name: string;
  /** ISO 639 two-letter language code, e.g. "de". The schema requires it. */
  language: string;
  /** The issuing institute's id for this product, when the bank gave one. */
  instituteId?: string;
}

/** Who we are to the bank: the three ids from the EBICS contract. */
export interface Subscriber {
  /** The bank's own id for its EBICS server, e.g. "EBIXHOST". */
  hostId: string;
  /** The customer id. */
  partnerId: string;
  /** The individual subscriber (user) id. */
  userId: string;
  /** The client software, when the connection names one. */
  product?: Product;
}

/** Our key material, as the builders need it. */
export interface SubscriberKeys {
  /** Electronic signature key (A005/A006) — signs order data. */
  esPrivatePem: string;
  esVersion: EsVersion;
  /** Identification and authentication key (X002) — signs requests. */
  authPrivatePem: string;
  /** Encryption key (E002) — the bank encrypts downloads to it. */
  encPrivatePem: string;
}

/** What we hold of the bank's keys, once HPB has run. */
export interface BankKeys {
  authPublicPem: string;
  encPublicPem: string;
}

/**
 * The Business Transaction Format — EBICS 3.0's replacement for order types.
 *
 * The values are bank- and country-specific (`SCT`/`DE`/`pain.001`/`XML` is a
 * German SEPA credit transfer), which is exactly why they are a parameter here
 * and a config entry in `bank-registry.ts` rather than a constant. A wrong BTF
 * is the most common reason a technically perfect upload is refused.
 */
export interface Btf {
  /** Service name, e.g. "SCT" (SEPA credit transfer). */
  serviceName: string;
  /** Scope: a country code, "BIL" for bilaterally agreed, or omitted. */
  scope?: string;
  /** Service option, when the bank defines one. */
  option?: string;
  /** Message name, e.g. "pain.001". */
  msgName: string;
  /** Message version, e.g. "09". */
  msgVersion?: string;
  /** Message variant, when the bank defines one. For pain.001.001.09: "001". */
  msgVariant?: string;
  /** Encoding format of the message, e.g. "XML", "JSON", "PDF". Rarely needed. */
  msgFormat?: string;
  /** Container type, e.g. "XML" or "ZIP". */
  container?: string;
}

/** "SCT/DE/pain.001/XML" — how a bank writes a BTF in its documentation. */
export function btfToString(btf: Btf): string {
  return [btf.serviceName, btf.scope ?? '', btf.option ?? '', btf.msgName, btf.container ?? '']
    .join('/')
    .replace(/\/+$/, '');
}

// ── Shared fragments ──────────────────────────────────────────────────

function staticHeader(subscriber: Subscriber, children: (XmlElement | null)[]): XmlElement {
  return el('e:static', {}, [
    el('e:HostID', {}, [subscriber.hostId]),
    ...children,
  ]);
}

/**
 * `Product`, or nothing at all when the connection does not name one.
 *
 * Position is not free: the schema puts it after `UserID`/`SystemID` and
 * before `OrderDetails` in both request families, so it is passed in at each
 * call site rather than appended by `staticHeader`. `schema.test.ts` is what
 * proves the placement, since a misplaced optional element is exactly the kind
 * of mistake a mock bank that reads by name would never notice.
 */
function productElement(subscriber: Subscriber): XmlElement | null {
  const product = subscriber.product;
  if (product === undefined) return null;
  const attrs: Record<string, string> =
    product.instituteId === undefined
      ? { Language: product.language }
      : { Language: product.language, InstituteID: product.instituteId };
  return el('e:Product', attrs, [product.name]);
}

/** The `PubKeyValue` shape used wherever a public key goes on the wire. */
/**
 * A public key on the wire — as an X.509 certificate, which is the only form
 * EBICS 3.0 defines.
 *
 * `PubKeyValue`, the modulus-and-exponent element this used to emit, appears
 * nowhere in the H005 schema set: `PubKeyInfoType` requires `<ds:X509Data>` in
 * both the EBICS and the S002 namespace. Every INI and HIA this service sent
 * was therefore a shape no H005 bank defines — and the tests passed, because
 * the mock bank read the same invented shape back out.
 */
function x509Data(certificatePem: string): XmlElement {
  return el('ds:X509Data', {}, [
    el('ds:X509Certificate', {}, [certificateDer(certificatePem).toString('base64')]),
  ]);
}

// ── HEV: which versions does this bank speak? ─────────────────────────

/**
 * The one message that is not in the H005 namespace — it is the question you
 * ask *before* you know which version to speak, so it has a namespace of its
 * own and no protection at all.
 */
export const HEV_NS = 'http://www.ebics.org/H000';

export function buildHev(hostId: string): string {
  return document(el('h:ebicsHEVRequest', {}, [el('h:HostID', {}, [hostId])]), { h: HEV_NS });
}

// ── INI and HIA: sending our own public keys ──────────────────────────

/**
 * INI — the electronic signature key.
 *
 * Unsecured by necessity: the bank has nothing of ours to verify against yet.
 * What makes this safe is out-of-band — the INI letter, printed with the key's
 * digest, signed by hand and posted. Until the bank matches that sheet to this
 * message, the subscriber stays inactive.
 */
export function buildIni(params: {
  subscriber: Subscriber;
  /** The X.509 certificate over the A005/A006 key. */
  esCertificatePem: string;
  esVersion: EsVersion;
  timestamp: string;
}): string {
  // In the S002 namespace, not H005 — `SignaturePubKeyOrderData` is declared
  // in `ebics_signature_S002.xsd`, and so are all of its children.
  const orderData = document(
    el('esig:SignaturePubKeyOrderData', {}, [
      el('esig:SignaturePubKeyInfo', {}, [
        x509Data(params.esCertificatePem),
        el('esig:SignatureVersion', {}, [params.esVersion]),
      ]),
      el('esig:PartnerID', {}, [params.subscriber.partnerId]),
      el('esig:UserID', {}, [params.subscriber.userId]),
    ]),
    NS,
  );

  return unsecuredRequest(params.subscriber, 'INI', orderData);
}

/**
 * HIA — the authentication and encryption keys, sent the same way and for the
 * same reason.
 */
export function buildHia(params: {
  subscriber: Subscriber;
  /** The X.509 certificate over the X002 key. */
  authCertificatePem: string;
  /** The X.509 certificate over the E002 key. */
  encCertificatePem: string;
  timestamp: string;
}): string {
  const orderData = document(
    el('e:HIARequestOrderData', {}, [
      el('e:AuthenticationPubKeyInfo', {}, [
        x509Data(params.authCertificatePem),
        el('e:AuthenticationVersion', {}, ['X002']),
      ]),
      el('e:EncryptionPubKeyInfo', {}, [
        x509Data(params.encCertificatePem),
        el('e:EncryptionVersion', {}, ['E002']),
      ]),
      el('e:PartnerID', {}, [params.subscriber.partnerId]),
      el('e:UserID', {}, [params.subscriber.userId]),
    ]),
    NS,
  );

  return unsecuredRequest(params.subscriber, 'HIA', orderData);
}

/** The envelope INI and HIA share: order data deflated and base64'd, no crypto. */
function unsecuredRequest(subscriber: Subscriber, orderType: 'INI' | 'HIA', orderDataXml: string): string {
  const packed = deflateToBase64(Buffer.from(orderDataXml, 'utf8'));
  return document(
    el('e:ebicsUnsecuredRequest', { Version: H005, Revision: '1' }, [
      el('e:header', { authenticate: 'true' }, [
        staticHeader(subscriber, [
          el('e:PartnerID', {}, [subscriber.partnerId]),
          el('e:UserID', {}, [subscriber.userId]),
          productElement(subscriber),
          el('e:OrderDetails', {}, [el('e:AdminOrderType', {}, [orderType])]),
          el('e:SecurityMedium', {}, ['0000']),
        ]),
        el('e:mutable', {}),
      ]),
      el('e:body', {}, [el('e:DataTransfer', {}, [el('e:OrderData', {}, [packed])])]),
    ]),
    NS,
  );
}

/** zlib deflate, then base64 — how INI/HIA order data is packaged. There is no
 *  encryption step here because there is no key yet to encrypt with. */
function deflateToBase64(data: Buffer): string {
  return deflateSync(data).toString('base64');
}

// ── HPB: fetching the bank's keys ─────────────────────────────────────

/**
 * HPB — download the bank's authentication and encryption public keys.
 *
 * Authenticated with X002 (the bank has our key by now, from HIA) but sent as
 * `ebicsNoPubKeyDigestsRequest`, because a normal request has to carry digests
 * of the bank's keys and this is the request that fetches them.
 *
 * **What comes back is not trusted on arrival.** The digests are shown to an
 * operator to compare against the bank's own published letter; only that
 * comparison rules out a substituted key. See `connections.ts`.
 */
export function buildHpb(params: { subscriber: Subscriber; keys: SubscriberKeys; timestamp: string }): string {
  const root = el('e:ebicsNoPubKeyDigestsRequest', { Version: H005, Revision: '1' }, [
    el('e:header', { authenticate: 'true' }, [
      staticHeader(params.subscriber, [
        el('e:Nonce', {}, [nonceFrom(params.timestamp, params.subscriber)]),
        el('e:Timestamp', {}, [params.timestamp]),
        el('e:PartnerID', {}, [params.subscriber.partnerId]),
        el('e:UserID', {}, [params.subscriber.userId]),
        productElement(params.subscriber),
        el('e:OrderDetails', {}, [
          el('e:AdminOrderType', {}, ['HPB']),
        ]),
        el('e:SecurityMedium', {}, ['0000']),
      ]),
      el('e:mutable', {}),
    ]),
    el('e:body', {}),
  ]);

  return signed(root, params.keys.authPrivatePem);
}

/**
 * A deterministic nonce.
 *
 * EBICS wants 128 bits of nonce per request, and the obvious implementation is
 * `randomBytes(16)` — which would make every envelope unreproducible and every
 * golden test impossible. Deriving it from the timestamp and the subscriber
 * keeps the builders pure while still giving a distinct value per request, and
 * the caller supplies a timestamp it does not repeat.
 */
function nonceFrom(timestamp: string, subscriber: Subscriber): string {
  return sha256(`${timestamp}|${subscriber.hostId}|${subscriber.partnerId}|${subscriber.userId}`)
    .subarray(0, 16)
    .toString('hex')
    .toUpperCase();
}

// ── BTU: uploading a signed payment file ──────────────────────────────

export interface UploadInit {
  subscriber: Subscriber;
  keys: SubscriberKeys;
  bank: BankKeys;
  btf: Btf;
  /** The file itself — a pain.001 document, unencrypted and uncompressed. */
  orderData: Buffer;
  /** A fresh AES key for this transaction. Never reuse one. */
  transactionKey: Buffer;
  timestamp: string;
  /** How many segments the order data will be sent in. */
  segments: number;
  /**
   * Ask the bank to spool this order into its distributed-signature (VEU/EDS)
   * queue instead of requiring every signature up front.
   *
   * Default false, which is signature class E as this service is designed:
   * the ES attached here is all the authorisation the order needs, and a bank
   * that wants more signatures rejects it outright. Set it when the account's
   * bank agreement requires a second signatory, who then approves the order in
   * their own software or the bank's portal.
   *
   * **PS-12 cannot show you that queue.** The management order types (HVU,
   * HVZ, HVD, HVT, HVE, HVS) are not implemented, so an order spooled this way
   * is out of this service's sight until a pain.002 comes back for it.
   */
  requestEDS?: boolean;
}

/**
 * `SignatureFlag` — the element that says what the attached ES is *for*.
 *
 * It replaces EBICS 2.5's order attribute (`OZHNN`/`DZHNN`), and the schema's
 * own documentation is unusually explicit about the default:
 *
 * > If not present the order doesn't contain any ES and shall be authorised
 * > outside EBICS. If present the order shall be authorised within EBICS.
 *
 * This service attaches a class-E bank-technical signature to every upload —
 * the whole reason it exists is that nobody has to log into online banking
 * afterwards. Sending no flag said the opposite of that, which is why the
 * element is not optional here even though it is optional in the schema.
 *
 * `requestEDS="true"` is the distributed-signature (VEU) case: spool the order
 * and wait for the missing signatures rather than rejecting it.
 */
function signatureFlag(requestEDS: boolean): XmlElement {
  return el('e:SignatureFlag', requestEDS ? { requestEDS: 'true' } : {});
}

/**
 * The initialisation phase of an upload: everything the bank needs to accept
 * the transaction, except the data itself.
 *
 * The **UserSignature** built here is the bank-technical signature (class E):
 * the A005/A006 signature over the order data that authorises the payment. It
 * travels encrypted alongside the file, which is why `signOrderData` runs on
 * the plaintext before anything is packed.
 */
export function buildUploadInit(params: UploadInit): string {
  return uploadInitialisation({
    ...params,
    orderDetails: [
      el('e:AdminOrderType', {}, ['BTU']),
      el('e:BTUOrderParams', {}, [btfElement(params.btf), signatureFlag(params.requestEDS === true)]),
    ],
  });
}

/**
 * The initialisation phase every signed upload shares — BTU, SPR, HVE.
 *
 * They differ only in `OrderDetails`: which admin order type, and which
 * `OrderParams` substitution goes with it. Everything else — the ES over the
 * order data, the transaction key encrypted to the bank, the digest the bank
 * checks the reassembled file against — is identical, and was worth having in
 * one place the moment a second order type needed it.
 */
function uploadInitialisation(params: {
  subscriber: Subscriber;
  keys: SubscriberKeys;
  bank: BankKeys;
  orderData: Buffer;
  transactionKey: Buffer;
  timestamp: string;
  segments: number;
  orderDetails: (XmlElement | null)[];
}): string {
  const { subscriber, keys, bank } = params;

  // esig:UserSignatureData → esig:OrderSignatureData, and the sequence is
  // SignatureVersion, SignatureValue, PartnerID, UserID — all ELEMENTS. This
  // was `e:OrderSignature` with the ids as attributes, which is not a shape
  // the schema defines anywhere.
  const userSignature = document(
    el('esig:UserSignatureData', {}, [
      el('esig:OrderSignatureData', {}, [
        el('esig:SignatureVersion', {}, [keys.esVersion]),
        el('esig:SignatureValue', {}, [
          signOrderData(keys.esPrivatePem, params.orderData, keys.esVersion).toString('base64'),
        ]),
        el('esig:PartnerID', {}, [subscriber.partnerId]),
        el('esig:UserID', {}, [subscriber.userId]),
      ]),
    ]),
    NS,
  );

  const root = el('e:ebicsRequest', { Version: H005, Revision: '1' }, [
    el('e:header', { authenticate: 'true' }, [
      staticHeader(subscriber, [
        el('e:Nonce', {}, [nonceFrom(params.timestamp, subscriber)]),
        el('e:Timestamp', {}, [params.timestamp]),
        el('e:PartnerID', {}, [subscriber.partnerId]),
        el('e:UserID', {}, [subscriber.userId]),
        productElement(subscriber),
        el('e:OrderDetails', {}, params.orderDetails),
        el('e:BankPubKeyDigests', {}, [
          el('e:Authentication', { Version: 'X002', Algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' }, [
            publicKeyDigest(bank.authPublicPem).toString('base64'),
          ]),
          el('e:Encryption', { Version: 'E002', Algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' }, [
            publicKeyDigest(bank.encPublicPem).toString('base64'),
          ]),
        ]),
        el('e:SecurityMedium', {}, ['0000']),
        el('e:NumSegments', {}, [String(params.segments)]),
      ]),
      el('e:mutable', {}, [el('e:TransactionPhase', {}, ['Initialisation'])]),
    ]),
    el('e:body', {}, [
      el('e:DataTransfer', {}, [
        el('e:DataEncryptionInfo', { authenticate: 'true' }, [
          el('e:EncryptionPubKeyDigest', { Version: 'E002', Algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' }, [
            publicKeyDigest(bank.encPublicPem).toString('base64'),
          ]),
          el('e:TransactionKey', {}, [
            encryptTransactionKey(bank.encPublicPem, params.transactionKey).toString('base64'),
          ]),
        ]),
        el('e:SignatureData', { authenticate: 'true' }, [
          packOrderData(params.transactionKey, Buffer.from(userSignature, 'utf8')),
        ]),
        el('e:DataDigest', { SignatureVersion: keys.esVersion }, [
          sha256(params.orderData).toString('base64'),
        ]),
      ]),
    ]),
  ]);

  return signed(root, keys.authPrivatePem);
}

/**
 * The order data an `SPR` carries: a single space.
 *
 * **This byte is the one thing here not derived from the published schema.**
 * The schema forces the shape — an `ebicsRequest` upload initialisation must
 * carry `SignatureData`, `DataDigest` and `NumSegments`, so SPR must sign
 * *something* — but it cannot say what, and the EBICS specification text that
 * does is not in this repository. A single blank is what the specification
 * prescribes as far as this was written from; treat it as unconfirmed until a
 * real bank accepts one.
 *
 * The failure mode is at least honest: a bank that disagrees rejects the
 * request with a return code, `sendSpr` records that code and does NOT move
 * the connection to `locked`. An operator locking a compromised key sees the
 * refusal rather than a green tick over nothing.
 */
export const SPR_ORDER_DATA = Buffer.from(' ', 'utf8');

/**
 * SPR — lock this subscriber at the bank.
 *
 * The Austrian implementation guideline says plainly that Austrian institutes
 * support it ("Die österreichischen Institute unterstützen die Sperre des
 * Anwenders mittels Auftragsart SPR"), and at signature class E it is the only
 * way to stop a compromised key without telephoning the bank.
 *
 * It is an ordinary signed upload with `StandardOrderParams` — the catch-all
 * the schema defines for admin order types that carry no BTF — and no date
 * range, since it is about now.
 */
export function buildSpr(params: {
  subscriber: Subscriber;
  keys: SubscriberKeys;
  bank: BankKeys;
  transactionKey: Buffer;
  timestamp: string;
}): string {
  return uploadInitialisation({
    ...params,
    orderData: SPR_ORDER_DATA,
    segments: 1,
    orderDetails: [el('e:AdminOrderType', {}, ['SPR']), el('e:StandardOrderParams', {})],
  });
}

/**
 * The `Service` element — the BTF itself.
 *
 * The order is the schema's (`RestrictedServiceType`): ServiceName, Scope,
 * ServiceOption, Container, MsgName. Two things here were wrong for a long
 * time and only a schema check could have said so:
 *
 * - **`Container` is a flag element, not a text value**, and it sits BEFORE
 *   `MsgName`. It used to be dropped entirely: the API took a `container`,
 *   stored it, showed it, and never put it on the wire. For a download that
 *   silently asks for the wrong thing.
 * - **`MsgName` carries `variant` and `format` as well as `version`.** An
 *   ISO 20022 name decomposes: pain.001.001.09 is MsgName `pain.001`,
 *   variant `001`, version `09`. Sending only the version says less than the
 *   bank asked for.
 */
function btfElement(btf: Btf, name: 'Service' | 'ServiceFilter' = 'Service'): XmlElement {
  const msgAttrs: Record<string, string> = {};
  if (btf.msgVariant !== undefined) msgAttrs.variant = btf.msgVariant;
  if (btf.msgVersion !== undefined) msgAttrs.version = btf.msgVersion;
  if (btf.msgFormat !== undefined) msgAttrs.format = btf.msgFormat;

  // HVU and HVZ name the same structure `ServiceFilter`; everywhere else it is
  // `Service`. Same children either way — the schema types differ only in that
  // ServiceType leaves every child optional, which a filter needs and an
  // actual BTF does not.
  return el(`e:${name}`, {}, [
    el('e:ServiceName', {}, [btf.serviceName]),
    btf.scope !== undefined ? el('e:Scope', {}, [btf.scope]) : null,
    btf.option !== undefined ? el('e:ServiceOption', {}, [btf.option]) : null,
    btf.container !== undefined ? el('e:Container', { containerType: btf.container }) : null,
    el('e:MsgName', msgAttrs, [btf.msgName]),
  ]);
}

/**
 * The transfer phase: one segment of the packed order data.
 *
 * Segments are 1-based and must arrive in order; the bank tracks the number and
 * refuses a gap. `lastSegment` tells it when to stop waiting.
 */
export function buildTransfer(params: {
  subscriber: Subscriber;
  keys: SubscriberKeys;
  transactionId: string;
  segmentNumber: number;
  lastSegment: boolean;
  /** One segment of the base64 order data. */
  segment: string;
}): string {
  const root = el('e:ebicsRequest', { Version: H005, Revision: '1' }, [
    el('e:header', { authenticate: 'true' }, [
      el('e:static', {}, [
        el('e:HostID', {}, [params.subscriber.hostId]),
        el('e:TransactionID', {}, [params.transactionId]),
      ]),
      el('e:mutable', {}, [
        el('e:TransactionPhase', {}, ['Transfer']),
        el(
          'e:SegmentNumber',
          params.lastSegment ? { lastSegment: 'true' } : {},
          [String(params.segmentNumber)],
        ),
      ]),
    ]),
    el('e:body', {}, [
      el('e:DataTransfer', {}, [el('e:OrderData', {}, [params.segment])]),
    ]),
  ]);

  return signed(root, params.keys.authPrivatePem);
}

// ── BTD: downloading what the bank has for us ─────────────────────────

/**
 * The initialisation phase of a download.
 *
 * Two things are absent that an upload carries, and their absence is the whole
 * difference: there is no order data and **no bank-technical signature**. We
 * are not authorising anything — we are asking. So the ES key never appears in
 * a download, which is why `SubscriberKeys.esPrivatePem` is untouched here.
 *
 * The date range is optional and inclusive. Omitting it asks for whatever the
 * bank has not yet handed over, which is the ordinary case: a positive receipt
 * is what marks a file as collected, so "new since last time" is the bank's
 * bookkeeping rather than ours.
 */
export function buildDownloadInit(params: {
  subscriber: Subscriber;
  keys: SubscriberKeys;
  bank: BankKeys;
  btf: Btf;
  timestamp: string;
  /** Inclusive ISO dates. Both or neither — a half-open range is not a range. */
  dateRange?: { from: string; to: string };
}): string {
  return downloadInitialisation({
    ...params,
    orderDetails: [
      el('e:AdminOrderType', {}, ['BTD']),
      el('e:BTDOrderParams', {}, [
        btfElement(params.btf),
        params.dateRange === undefined
          ? null
          : el('e:DateRange', {}, [
              el('e:Start', {}, [params.dateRange.from]),
              el('e:End', {}, [params.dateRange.to]),
            ]),
      ]),
    ],
  });
}

/**
 * The initialisation phase every download shares — BTD and the four VEU reads.
 *
 * Like its upload counterpart, they differ only in `OrderDetails`. There is no
 * body at all: a download asks, it does not send.
 */
function downloadInitialisation(params: {
  subscriber: Subscriber;
  keys: SubscriberKeys;
  bank: BankKeys;
  timestamp: string;
  orderDetails: (XmlElement | null)[];
}): string {
  const { subscriber, keys, bank } = params;

  const root = el('e:ebicsRequest', { Version: H005, Revision: '1' }, [
    el('e:header', { authenticate: 'true' }, [
      staticHeader(subscriber, [
        el('e:Nonce', {}, [nonceFrom(params.timestamp, subscriber)]),
        el('e:Timestamp', {}, [params.timestamp]),
        el('e:PartnerID', {}, [subscriber.partnerId]),
        el('e:UserID', {}, [subscriber.userId]),
        productElement(subscriber),
        el('e:OrderDetails', {}, params.orderDetails),
        el('e:BankPubKeyDigests', {}, [
          el('e:Authentication', { Version: 'X002', Algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' }, [
            publicKeyDigest(bank.authPublicPem).toString('base64'),
          ]),
          el('e:Encryption', { Version: 'E002', Algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' }, [
            publicKeyDigest(bank.encPublicPem).toString('base64'),
          ]),
        ]),
        el('e:SecurityMedium', {}, ['0000']),
      ]),
      el('e:mutable', {}, [el('e:TransactionPhase', {}, ['Initialisation'])]),
    ]),
    el('e:body', {}, []),
  ]);

  return signed(root, keys.authPrivatePem);
}

// ── Asking the bank about itself ──────────────────────────────────────

/**
 * The read-only administrative downloads.
 *
 * | | asks |
 * | --- | --- |
 * | `HTD` | what THIS subscriber may do — accounts, order types, signature class |
 * | `HKD` | the same for the whole customer, every subscriber included |
 * | `HPD` | the bank's own parameters and capabilities |
 * | `HAA` | which order types are available at all |
 * | `HAC` | the customer protocol: what the bank did with each order |
 *
 * All five are `ebicsRequest` downloads with `StandardOrderParams` — the
 * catch-all the schema defines for admin order types that carry no BTF — so
 * they differ only in the three letters. That is why they are one function.
 *
 * `HTD` is the cheapest useful request there is: read-only, no money, and it
 * answers "does this bank agree about who I am and what I may send" before a
 * payment is ever built. It is the sensible first live call after `HPB`.
 *
 * **`HAC` is here but its answer cannot be parsed.** The customer protocol's
 * order data is specified outside the H005 schema set — it is not in the ten
 * files the EBICS Working Group publishes — so this service fetches it and
 * stores the bytes without claiming to understand them. See `downloads.ts`.
 */
export type AdminDownloadType = 'HTD' | 'HKD' | 'HPD' | 'HAA' | 'HAC';

export function buildAdminDownload(params: {
  subscriber: Subscriber;
  keys: SubscriberKeys;
  bank: BankKeys;
  timestamp: string;
  orderType: AdminDownloadType;
  /** Inclusive ISO dates. `HAC` is the one where this is usually wanted. */
  dateRange?: { from: string; to: string };
}): string {
  return downloadInitialisation({
    ...params,
    orderDetails: [
      el('e:AdminOrderType', {}, [params.orderType]),
      el(
        'e:StandardOrderParams',
        {},
        params.dateRange === undefined
          ? []
          : [
              el('e:DateRange', {}, [
                el('e:Start', {}, [params.dateRange.from]),
                el('e:End', {}, [params.dateRange.to]),
              ]),
            ],
      ),
    ],
  });
}

// ── Renewing the subscriber keys ──────────────────────────────────────

/**
 * `HCA` and `HCS` — replace our own keys without another paper INI letter.
 *
 * Without these the only way to change a key is `SPR` and a fresh
 * initialisation on paper, with a gap in service while the bank processes it.
 * With them a compromised or expiring key is replaced over the wire in one
 * request.
 *
 * | | replaces |
 * | --- | --- |
 * | `HCA` | the authentication (X002) and encryption (E002) keys |
 * | `HCS` | those two AND the ES key that authorises payments |
 *
 * **The old keys sign the change; that is what authorises it.** The request is
 * an ordinary signed upload built with the keys currently on file, and its
 * order data carries the NEW public keys as certificates. A bank that accepts
 * it has verified, with the key it already trusts, that the holder of that key
 * asked for the replacement — which is exactly the property that makes a paper
 * letter unnecessary the second time.
 *
 * So the caller passes both sets, and the distinction matters: `keys` are the
 * ones in use today, `replacement` are the ones that take over if the bank
 * says yes. Swapping them produces a request signed by a key the bank has
 * never seen, which it will refuse.
 */
export interface KeyChange {
  subscriber: Subscriber;
  /** The keys currently registered with the bank. These sign the request. */
  keys: SubscriberKeys;
  bank: BankKeys;
  transactionKey: Buffer;
  timestamp: string;
  /** Certificates over the NEW keys that are to take over. */
  replacement: {
    /** Required for HCS, ignored for HCA — only HCS replaces the ES key. */
    esCertificatePem?: string;
    esVersion?: EsVersion;
    authCertificatePem: string;
    encCertificatePem: string;
  };
}

/**
 * `HCA` — new authentication and encryption keys, ES key unchanged.
 *
 * The order data is an `HCARequestOrderData`, whose shape is `HIA`'s: the two
 * key infos and the partner and user ids. The difference is entirely in what
 * signs the envelope — `HIA` is unsecured because the bank has nothing of ours
 * yet, and this is fully signed because by now it has.
 */
export function buildKeyChangeAuth(params: KeyChange): VeuUpload {
  const orderData = Buffer.from(
    document(
      el('e:HCARequestOrderData', {}, [
        el('e:AuthenticationPubKeyInfo', {}, [
          x509Data(params.replacement.authCertificatePem),
          el('e:AuthenticationVersion', {}, ['X002']),
        ]),
        el('e:EncryptionPubKeyInfo', {}, [
          x509Data(params.replacement.encCertificatePem),
          el('e:EncryptionVersion', {}, ['E002']),
        ]),
        el('e:PartnerID', {}, [params.subscriber.partnerId]),
        el('e:UserID', {}, [params.subscriber.userId]),
      ]),
      NS,
    ),
    'utf8',
  );

  return keyChangeUpload(params, 'HCA', orderData);
}

/**
 * `HCS` — new keys for all three purposes, the ES key included.
 *
 * The one that matters after a compromise: `HCA` leaves the key that
 * authorises payments exactly where it was.
 */
export function buildKeyChangeAll(params: KeyChange): VeuUpload {
  const { esCertificatePem, esVersion } = params.replacement;
  if (esCertificatePem === undefined) {
    throw new Error('HCS replaces the ES key as well, so a certificate over the new ES key is required');
  }

  const orderData = Buffer.from(
    document(
      el('e:HCSRequestOrderData', {}, [
        el('e:AuthenticationPubKeyInfo', {}, [
          x509Data(params.replacement.authCertificatePem),
          el('e:AuthenticationVersion', {}, ['X002']),
        ]),
        el('e:EncryptionPubKeyInfo', {}, [
          x509Data(params.replacement.encCertificatePem),
          el('e:EncryptionVersion', {}, ['E002']),
        ]),
        // In the S002 namespace, like every other signature key info.
        el('esig:SignaturePubKeyInfo', {}, [
          x509Data(esCertificatePem),
          el('esig:SignatureVersion', {}, [esVersion ?? 'A005']),
        ]),
        el('e:PartnerID', {}, [params.subscriber.partnerId]),
        el('e:UserID', {}, [params.subscriber.userId]),
      ]),
      NS,
    ),
    'utf8',
  );

  return keyChangeUpload(params, 'HCS', orderData);
}

function keyChangeUpload(params: KeyChange, orderType: 'HCA' | 'HCS', orderData: Buffer): VeuUpload {
  return {
    orderData,
    init: uploadInitialisation({
      subscriber: params.subscriber,
      // The CURRENT keys. See the note on KeyChange.
      keys: params.keys,
      bank: params.bank,
      orderData,
      transactionKey: params.transactionKey,
      timestamp: params.timestamp,
      segments: 1,
      orderDetails: [el(`e:AdminOrderType`, {}, [orderType]), el('e:StandardOrderParams', {})],
    }),
  };
}

// ── VEU: the distributed-signature queue ──────────────────────────────

/**
 * The four orders that READ the queue, and the two that change it.
 *
 * When an order needs more signatures than it arrived with, the bank spools it
 * rather than refusing it — that is what `SignatureFlag requestEDS="true"` on
 * a BTU asks for. These are how a second signatory then sees it and acts:
 *
 * | | asks |
 * | --- | --- |
 * | `HVU` | what is waiting for MY signature |
 * | `HVZ` | the same, with the payment details folded in |
 * | `HVD` | one order's digest and its display file |
 * | `HVT` | one order's individual transactions |
 * | `HVE` | add my signature to one order |
 * | `HVS` | cancel one order |
 *
 * `HVU` and `HVZ` take an optional list of service filters; the other four
 * name exactly one order, by partner, service and order id.
 */
export type VeuReadType = 'HVU' | 'HVZ' | 'HVD' | 'HVT';

/** Which order a per-order VEU request is about. */
export interface VeuOrderRef {
  /** The customer the order belongs to — not necessarily ours. */
  partnerId: string;
  /** The BTF the order was submitted under. */
  btf: Btf;
  orderId: string;
}

/**
 * `HVU` / `HVZ` — what is waiting for a signature.
 *
 * `serviceFilter` narrows the answer to particular BTFs; an empty list asks
 * for everything, which is the sensible default for an operator's overview.
 */
export function buildVeuOverview(params: {
  subscriber: Subscriber;
  keys: SubscriberKeys;
  bank: BankKeys;
  timestamp: string;
  /** `HVZ` is `HVU` plus the payment details — same request shape. */
  orderType: 'HVU' | 'HVZ';
  serviceFilter?: Btf[];
}): string {
  return downloadInitialisation({
    ...params,
    orderDetails: [
      el('e:AdminOrderType', {}, [params.orderType]),
      el(
        `e:${params.orderType}OrderParams`,
        {},
        (params.serviceFilter ?? []).map((btf) => btfElement(btf, 'ServiceFilter')),
      ),
    ],
  });
}

/**
 * `HVD` — one order's `DataDigest`, display file and signer list.
 *
 * The digest is the point: it is what `HVE` signs. A co-signatory must never
 * hash the order data themselves and sign that, because they may not have the
 * order data at all — `OrderDataAvailable` is a flag in this very response.
 */
export function buildVeuDetail(params: {
  subscriber: Subscriber;
  keys: SubscriberKeys;
  bank: BankKeys;
  timestamp: string;
  order: VeuOrderRef;
}): string {
  return downloadInitialisation({
    ...params,
    orderDetails: [
      el('e:AdminOrderType', {}, ['HVD']),
      el('e:HVDOrderParams', {}, veuRequestStructure(params.order)),
    ],
  });
}

/**
 * `HVT` — the individual transactions inside one order.
 *
 * `completeOrderData` false asks for the bank's own summary of each
 * transaction rather than the raw file, which is what a human approving a
 * payment actually wants to read. The window is explicit because a collective
 * order can hold thousands.
 */
export function buildVeuTransactions(params: {
  subscriber: Subscriber;
  keys: SubscriberKeys;
  bank: BankKeys;
  timestamp: string;
  order: VeuOrderRef;
  completeOrderData?: boolean;
  fetchLimit?: number;
  fetchOffset?: number;
}): string {
  return downloadInitialisation({
    ...params,
    orderDetails: [
      el('e:AdminOrderType', {}, ['HVT']),
      el('e:HVTOrderParams', {}, [
        ...veuRequestStructure(params.order),
        el('e:OrderFlags', {
          completeOrderData: params.completeOrderData === true ? 'true' : 'false',
          fetchLimit: String(params.fetchLimit ?? 100),
          fetchOffset: String(params.fetchOffset ?? 0),
        }),
      ]),
    ],
  });
}

/**
 * A VEU upload: the initialisation envelope and the bytes its transfer phase
 * must carry.
 *
 * Both are returned together because the caller cannot rebuild the order data
 * itself — it contains a signature, and re-deriving it would mean signing
 * twice and hoping the two agree. The `DataDigest` in the envelope is over
 * exactly these bytes.
 */
export interface VeuUpload {
  init: string;
  orderData: Buffer;
}

/**
 * `HVE` — add our signature to an order already in the queue.
 *
 * The order data this uploads is a `UserSignatureData` document carrying one
 * `OrderSignatureData`: our ES over the **`DataDigest` that `HVD` returned**,
 * not over anything we hashed ourselves. A co-signatory may not have the order
 * data at all — `OrderDataAvailable` is a flag in that same HVD response — so
 * the digest is the only thing there is to sign, and `signDigest` is the one
 * function in this service that takes a hash from outside.
 *
 * The envelope around it is an ordinary signed upload, because the schema
 * leaves no alternative: an upload initialisation must carry `SignatureData`,
 * `DataDigest` and `NumSegments`. So the outer ES signs the signature document
 * and the inner one signs the order — which reads oddly until you notice that
 * the outer one is the transport's own integrity check and the inner one is
 * the authorisation.
 *
 * **Unconfirmed against a real bank**, like SPR: the shape is forced by the
 * schema, but no published document in this repository says HVE's order data
 * is exactly this. A bank that disagrees refuses the request with a code.
 */
export function buildVeuSignature(params: {
  subscriber: Subscriber;
  keys: SubscriberKeys;
  bank: BankKeys;
  timestamp: string;
  transactionKey: Buffer;
  order: VeuOrderRef;
  /** Base64, exactly as `HVD` sent it. */
  dataDigest: string;
}): VeuUpload {
  const signature = signDigest(params.keys.esPrivatePem, Buffer.from(params.dataDigest, 'base64'), params.keys.esVersion);
  const orderData = Buffer.from(
    document(
      el('esig:UserSignatureData', {}, [
        el('esig:OrderSignatureData', {}, [
          el('esig:SignatureVersion', {}, [params.keys.esVersion]),
          el('esig:SignatureValue', {}, [signature.toString('base64')]),
          el('esig:PartnerID', {}, [params.subscriber.partnerId]),
          el('esig:UserID', {}, [params.subscriber.userId]),
        ]),
      ]),
      NS,
    ),
    'utf8',
  );

  return {
    orderData,
    init: uploadInitialisation({
      ...params,
      orderData,
      segments: 1,
      orderDetails: [
        el('e:AdminOrderType', {}, ['HVE']),
        el('e:HVEOrderParams', {}, veuRequestStructure(params.order)),
      ],
    }),
  };
}

/**
 * `HVS` — cancel an order waiting in the queue.
 *
 * The order data is an `HVSRequestOrderData` naming the digest of the order
 * being cancelled, which is the schema's way of making sure a cancellation
 * cannot be aimed at an order the sender has not actually looked at: the
 * digest comes from `HVD`.
 */
export function buildVeuCancel(params: {
  subscriber: Subscriber;
  keys: SubscriberKeys;
  bank: BankKeys;
  timestamp: string;
  transactionKey: Buffer;
  order: VeuOrderRef;
  /** Base64, exactly as `HVD` sent it. */
  dataDigest: string;
}): VeuUpload {
  const orderData = Buffer.from(
    document(
      el('e:HVSRequestOrderData', {}, [
        el('e:CancelledDataDigest', { SignatureVersion: params.keys.esVersion }, [params.dataDigest]),
      ]),
      NS,
    ),
    'utf8',
  );

  return {
    orderData,
    init: uploadInitialisation({
      ...params,
      orderData,
      segments: 1,
      orderDetails: [
        el('e:AdminOrderType', {}, ['HVS']),
        el('e:HVSOrderParams', {}, veuRequestStructure(params.order)),
      ],
    }),
  };
}

/**
 * `HVRequestStructure` — PartnerID, Service, OrderID, in that order.
 *
 * Shared by HVD, HVE, HVS and HVT, and the order is not ours to choose: the
 * schema declares it as a sequence.
 */
function veuRequestStructure(order: VeuOrderRef): XmlElement[] {
  return [
    el('e:PartnerID', {}, [order.partnerId]),
    btfElement(order.btf),
    el('e:OrderID', {}, [order.orderId]),
  ];
}

/**
 * Ask for one more segment of a download in progress.
 *
 * The mirror of `buildTransfer`: there the segment number says what we are
 * sending, here it says what we want next.
 */
export function buildDownloadSegment(params: {
  subscriber: Subscriber;
  keys: SubscriberKeys;
  transactionId: string;
  segmentNumber: number;
  /**
   * Whether this is the last segment being asked for. REQUIRED by the schema —
   * `lastSegment` has no default — and the client does know: the
   * initialisation response said how many segments there are.
   */
  lastSegment: boolean;
}): string {
  const root = el('e:ebicsRequest', { Version: H005, Revision: '1' }, [
    el('e:header', { authenticate: 'true' }, [
      el('e:static', {}, [
        el('e:HostID', {}, [params.subscriber.hostId]),
        el('e:TransactionID', {}, [params.transactionId]),
      ]),
      el('e:mutable', {}, [
        el('e:TransactionPhase', {}, ['Transfer']),
        el('e:SegmentNumber', { lastSegment: params.lastSegment ? 'true' : 'false' }, [
          String(params.segmentNumber),
        ]),
      ]),
    ]),
    el('e:body', {}, []),
  ]);

  return signed(root, params.keys.authPrivatePem);
}

/**
 * The receipt phase, which closes a DOWNLOAD.
 *
 * `positive` is how the bank learns we stored the data: a negative receipt
 * leaves the file queued for the next fetch. Sending a positive receipt before
 * the data is safely written is how downloads get lost.
 */
export function buildReceipt(params: {
  subscriber: Subscriber;
  keys: SubscriberKeys;
  transactionId: string;
  positive: boolean;
}): string {
  const root = el('e:ebicsRequest', { Version: H005, Revision: '1' }, [
    el('e:header', { authenticate: 'true' }, [
      el('e:static', {}, [
        el('e:HostID', {}, [params.subscriber.hostId]),
        el('e:TransactionID', {}, [params.transactionId]),
      ]),
      el('e:mutable', {}, [el('e:TransactionPhase', {}, ['Receipt'])]),
    ]),
    el('e:body', {}, [
      el('e:TransferReceipt', { authenticate: 'true' }, [
        el('e:ReceiptCode', {}, [params.positive ? '0' : '1']),
      ]),
    ]),
  ]);

  return signed(root, params.keys.authPrivatePem);
}

/** Attach the AuthSignature and serialise. Every secured message ends here. */
function signed(root: XmlElement, authPrivatePem: string): string {
  const signature = buildAuthSignature({ root, ns: NS, authPrivatePem });
  // The signature goes between the header and the body, which is where the
  // schema puts it — order is not decorative in a sequence-typed schema.
  const headerIndex = root.children.findIndex((c) => c.kind === 'element' && c.local === 'header');
  root.children.splice(headerIndex + 1, 0, signature);
  return document(root, NS);
}
