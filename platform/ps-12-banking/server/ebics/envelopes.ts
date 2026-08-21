import { deflateSync } from 'node:zlib';
import { document, el, type NsMap, type XmlElement } from './xml.js';
import { buildAuthSignature, DS_NS, EBICS_NS } from './dsig.js';
import {
  encryptTransactionKey,
  packOrderData,
  publicKeyDigest,
  sha256,
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
  const { subscriber, keys, bank, btf } = params;

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
        el('e:OrderDetails', {}, [
          el('e:AdminOrderType', {}, ['BTU']),
          el('e:BTUOrderParams', {}, [btfElement(btf)]),
        ]),
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
function btfElement(btf: Btf): XmlElement {
  const msgAttrs: Record<string, string> = {};
  if (btf.msgVariant !== undefined) msgAttrs.variant = btf.msgVariant;
  if (btf.msgVersion !== undefined) msgAttrs.version = btf.msgVersion;
  if (btf.msgFormat !== undefined) msgAttrs.format = btf.msgFormat;

  return el('e:Service', {}, [
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
  const { subscriber, keys, bank, btf } = params;

  const root = el('e:ebicsRequest', { Version: H005, Revision: '1' }, [
    el('e:header', { authenticate: 'true' }, [
      staticHeader(subscriber, [
        el('e:Nonce', {}, [nonceFrom(params.timestamp, subscriber)]),
        el('e:Timestamp', {}, [params.timestamp]),
        el('e:PartnerID', {}, [subscriber.partnerId]),
        el('e:UserID', {}, [subscriber.userId]),
        productElement(subscriber),
        el('e:OrderDetails', {}, [
          el('e:AdminOrderType', {}, ['BTD']),
          el('e:BTDOrderParams', {}, [
            btfElement(btf),
            params.dateRange === undefined
              ? null
              : el('e:DateRange', {}, [
                  el('e:Start', {}, [params.dateRange.from]),
                  el('e:End', {}, [params.dateRange.to]),
                ]),
          ]),
        ]),
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
