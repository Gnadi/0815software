import { inflateSync } from 'node:zlib';
import {
  at,
  attrOf,
  document,
  el,
  findAll,
  parse,
  textOf,
  type XmlElement,
} from '../server/ebics/xml.js';
import { buildAuthSignature, verifyAuthSignature } from '../server/ebics/dsig.js';
import { EBICS_NS, ESIG_NS, HEV_NS, NS } from '../server/ebics/envelopes.js';
import { certificateDer, certificateFromBase64, publicPemFromCertificate, selfSignedCertificate } from '../server/ebics/x509.js';
import {
  decryptTransactionKey,
  encryptTransactionKey,
  newTransactionKey,
  packOrderData,
  publicKeyParts,
  sha256,
  unpackOrderData,
  verifyOrderData,
} from '../server/ebics/crypto.js';
import { spkiPemFromParts } from '../server/ebics/parse.js';
import { BANK_AUTH, BANK_ENC } from './fixtures/keys.js';

/**
 * A deterministic EBICS bank, for tests.
 *
 * There is no bank in CI, so the only way to know the client half works is to
 * write the other half and make them talk. This one implements the H005
 * conversation the service uses — HEV, INI, HIA, HPB, and the BTU
 * initialisation / transfer phases — well enough to be a real counterparty:
 * it *verifies* what it is sent rather than accepting it.
 *
 * **This file lives in `test/`, deliberately, and must never move into
 * `server/`.** PS-01's mock identity provider is config-gated because the worst
 * it can do is grant a session. This one would accept payment files: a bank
 * that says yes to anything has to be structurally impossible to wire into a
 * running deployment, not merely switched off by default.
 *
 * What it checks, because these are the client bugs worth catching:
 *
 * - the `AuthSignature` verifies against the subscriber's X002 key;
 * - the subscriber is known (INI and HIA both done) before anything else;
 * - the transaction key really is RSA-encrypted to the bank's E002 key;
 * - the bank-technical signature verifies against the ES key from INI, over
 *   the order data the client actually sent;
 * - `DataDigest` matches those same bytes;
 * - segments arrive in order, and the count matches `NumSegments`.
 *
 * On the download side it also holds a queue per BTF, encrypts each file to
 * the subscriber's own E002 key, and — the part worth having a counterparty
 * for — **only drops a file from the queue when a positive receipt arrives**.
 * A client that acknowledges before storing gets to lose a file here instead
 * of in production.
 */

export interface MockBankOptions {
  hostId?: string;
  /** Force a business-level rejection on the next upload, e.g. '091303'. */
  rejectUploadsWith?: string;
  /** Refuse SPR, the way a bank that has not enabled it would. */
  refuseSpr?: boolean;
  /** Refuse at the initialisation phase, before any segment is sent. */
  rejectInitWith?: string;
  /** Answer the initialisation without a TransactionID, which is nonsense. */
  omitTransactionId?: boolean;
  /** Make HPB answer before INI/HIA, to test the client's ordering. */
  allowHpbBeforeInit?: boolean;
  /** Base64 characters per download segment, to exercise reassembly. */
  downloadSegmentLimit?: number;
}

interface Subscriber {
  partnerId: string;
  userId: string;
  esPublicPem?: string;
  esVersion?: string;
  authPublicPem?: string;
  encPublicPem?: string;
}

/** A file waiting to be collected, keyed by the BTF that asks for it. */
interface Queued {
  btfKey: string;
  content: Buffer;
}

/** A download the client has started but not yet acknowledged. */
interface OpenDownload {
  id: string;
  /** Absent for a VEU queue view — there is no stored file to acknowledge. */
  queued?: Queued;
  segments: string[];
}

/** One order sitting in this bank's distributed-signature queue. */
export interface QueuedForSignature {
  orderId: string;
  service: { serviceName: string; scope?: string; option?: string; msgName: string };
  /** The order data whose digest a co-signature is computed over. */
  content: Buffer;
  signaturesRequired: number;
  signaturesDone: number;
  readyToBeSigned: boolean;
  originator: { partnerId: string; userId: string };
  /** Set once HVS has cancelled it. */
  cancelled?: boolean;
  /** Every co-signature the bank accepted, in order. */
  signatures: { partnerId: string; userId: string; valid: boolean }[];
}

interface OpenTransaction {
  id: string;
  segmentsExpected: number;
  segmentsReceived: number;
  transactionKey: Buffer;
  orderDataParts: string[];
  /** The DataDigest the client promised in the initialisation phase. */
  promisedDigest: string;
  esVersion: string;
  signatureValue: Buffer;
  /** Set for an HVE or HVS transaction, so the transfer phase knows what it is. */
  veu?: { orderType: 'HVE' | 'HVS'; orderId: string };
  /** The ES key this transaction's signature must verify against. */
  esPublicPem: string;
  btf: ReceivedOrder['btf'];
  signature: ReceivedOrder['signature'];
}

/** What the bank did with a file, so a test can assert on the bank's view. */
export interface ReceivedOrder {
  transactionId: string;
  /** The plaintext file, reassembled and decrypted by the bank. */
  orderData: Buffer;
  /** The Business Transaction Format the client declared for the file. */
  btf: { serviceName: string; scope: string | null; option: string | null; msgName: string; msgVersion: string | null };
  /** True when the bank-technical signature verified over that file. */
  signatureValid: boolean;
  /**
   * What `BTUOrderParams/SignatureFlag` said the attached ES was for.
   *
   * `present: false` means the client asked for authorisation OUTSIDE EBICS —
   * a real bank would then park the payment for someone to release in online
   * banking, which is the opposite of what this service is for. Recorded
   * rather than merely accepted, so a test can assert on it.
   */
  signature: { flagPresent: boolean; requestEDS: boolean };
}

/** The four order types that only READ the queue. */
const VEU_READS = new Set(['HVU', 'HVZ', 'HVD', 'HVT']);

const BANK_AUTH_CERT = bankCertificate(BANK_AUTH.privatePem, 'AUTH');
const BANK_ENC_CERT = bankCertificate(BANK_ENC.privatePem, 'ENC');

export class MockBank {
  readonly hostId: string;
  readonly authPublicPem = BANK_AUTH.publicPem;
  readonly encPublicPem = BANK_ENC.publicPem;
  /** The bank's own certificates — module-level, so HPB is both reproducible
   *  and free: issuing one means an RSA signature, and a suite that builds a
   *  bank per test was paying for it every time. */
  private readonly authCertificatePem = BANK_AUTH_CERT;
  private readonly encCertificatePem = BANK_ENC_CERT;

  /** Every file the bank accepted, in order — what a test asserts against. */
  readonly received: ReceivedOrder[] = [];
  /** Every request body it was sent, for tests about what went on the wire. */
  readonly requests: string[] = [];

  private readonly subscribers = new Map<string, Subscriber>();
  /** Subscribers this bank has locked after an SPR — a test can assert on it. */
  readonly locked = new Set<string>();
  /** Orders waiting for a second signature. A test seeds this directly. */
  readonly veuQueue: QueuedForSignature[] = [];
  private readonly transactions = new Map<string, OpenTransaction>();
  /** Files waiting to be collected, in order. */
  private readonly queue: Queued[] = [];
  private readonly openDownloads = new Map<string, OpenDownload>();
  private counter = 0;
  private options: MockBankOptions;

  constructor(options: MockBankOptions = {}) {
    this.hostId = options.hostId ?? 'MOCKHOST';
    this.options = options;
  }

  /** Change the bank's behaviour mid-test (to force a rejection, say). */
  configure(options: Partial<MockBankOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * Put a file in the queue for a BTF, as a bank would when a statement is
   * ready. It stays there until a POSITIVE RECEIPT arrives — a client that
   * never acknowledges will be offered it again on the next poll, which is
   * what real banks do and what makes the store-then-acknowledge order
   * testable.
   */
  enqueue(btf: { serviceName: string; msgName: string }, content: Buffer | string): void {
    this.queue.push({
      btfKey: `${btf.serviceName}/${btf.msgName}`,
      content: typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
    });
  }

  /** How many files are still waiting — i.e. never positively acknowledged. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * The seam the service's transport talks to: one request in, one response
   * out, exactly like an HTTPS POST to a bank.
   */
  post(body: string): { status: number; body: string } {
    this.requests.push(body);
    let root: XmlElement;
    try {
      root = parse(body);
    } catch {
      return { status: 400, body: 'not XML' };
    }

    if (root.uri === HEV_NS) return { status: 200, body: this.hev(root) };
    if (root.uri !== EBICS_NS) return { status: 400, body: 'unknown namespace' };

    switch (root.local) {
      case 'ebicsUnsecuredRequest':
        return { status: 200, body: this.unsecured(root) };
      case 'ebicsNoPubKeyDigestsRequest':
        return { status: 200, body: this.hpb(root) };
      case 'ebicsRequest':
        return { status: 200, body: this.request(root) };
      default:
        return { status: 400, body: `unknown request ${root.local}` };
    }
  }

  // ── HEV ─────────────────────────────────────────────────────────────

  private hev(root: XmlElement): string {
    const hostId = textOf(at(root, HEV_NS, 'HostID')).trim();
    if (hostId !== this.hostId) {
      return document(
        el('h:ebicsHEVResponse', {}, [
          el('h:SystemReturnCode', {}, [el('h:ReturnCode', {}, ['091011']), el('h:ReportText', {}, ['unknown host'])]),
        ]),
        { h: HEV_NS },
      );
    }
    return document(
      el('h:ebicsHEVResponse', {}, [
        el('h:SystemReturnCode', {}, [el('h:ReturnCode', {}, ['000000']), el('h:ReportText', {}, ['OK'])]),
        el('h:VersionNumber', { ProtocolVersion: 'H005' }, ['03.00']),
      ]),
      { h: HEV_NS },
    );
  }

  // ── INI and HIA ─────────────────────────────────────────────────────

  private unsecured(root: XmlElement): string {
    const statics = at(root, EBICS_NS, 'header', 'static');
    const orderType = textOf(at(statics!, EBICS_NS, 'OrderDetails', 'AdminOrderType')).trim();
    const partnerId = textOf(at(statics!, EBICS_NS, 'PartnerID')).trim();
    const userId = textOf(at(statics!, EBICS_NS, 'UserID')).trim();

    const packed = textOf(at(root, EBICS_NS, 'body', 'DataTransfer', 'OrderData')).replace(/\s+/g, '');
    const orderData = parse(inflateSync(Buffer.from(packed, 'base64')).toString('utf8'));

    const key = this.subscriberKey(partnerId, userId);
    const subscriber = this.subscribers.get(key) ?? { partnerId, userId };

    if (orderType === 'INI') {
      // The INI payload is in the S002 namespace, not H005 — see envelopes.ts.
      const info = at(orderData, ESIG_NS, 'SignaturePubKeyInfo');
      if (info === null) {
        return this.response({ technical: '091117', reportText: 'INI order data is not in the S002 namespace' });
      }
      subscriber.esPublicPem = this.pemFrom(info);
      subscriber.esVersion = textOf(at(info, ESIG_NS, 'SignatureVersion')).trim();
    } else if (orderType === 'HIA') {
      subscriber.authPublicPem = this.pemFrom(at(orderData, EBICS_NS, 'AuthenticationPubKeyInfo')!);
      subscriber.encPublicPem = this.pemFrom(at(orderData, EBICS_NS, 'EncryptionPubKeyInfo')!);
    } else {
      return this.response({ technical: '091117', reportText: `unsupported order type ${orderType}` });
    }

    this.subscribers.set(key, subscriber);
    return this.response({});
  }

  /**
   * Read a public key out of a PubKeyInfo.
   *
   * EBICS 3.0 carries it as an X.509 certificate — `PubKeyValue` does not
   * exist in the H005 schema — so that is what this expects. It refuses the
   * old modulus/exponent shape ON PURPOSE: a mock that accepted both would go
   * on passing if the client regressed, which is exactly how the wrong shape
   * survived three hundred tests in the first place.
   */
  private pemFrom(info: XmlElement): string {
    const certificate = findAll(info, (n) => n.local === 'X509Certificate')[0];
    if (certificate === undefined) {
      throw new Error('no X509Certificate in this PubKeyInfo — EBICS 3.0 does not carry raw keys');
    }
    return publicPemFromCertificate(certificateFromBase64(textOf(certificate)));
  }

  // ── HPB ─────────────────────────────────────────────────────────────

  private hpb(root: XmlElement): string {
    const statics = at(root, EBICS_NS, 'header', 'static');
    const partnerId = textOf(at(statics!, EBICS_NS, 'PartnerID')).trim();
    const userId = textOf(at(statics!, EBICS_NS, 'UserID')).trim();
    const subscriber = this.subscribers.get(this.subscriberKey(partnerId, userId));

    if (!this.options.allowHpbBeforeInit && (subscriber?.authPublicPem === undefined || subscriber.esPublicPem === undefined)) {
      // A real bank will not hand over its keys to a subscriber it has not
      // been initialised for — and the INI letter has to be processed first.
      return this.response({ technical: '091002', reportText: 'subscriber unknown or not yet activated' });
    }

    const verified = verifyAuthSignature({ root, bankAuthPublicPem: subscriber!.authPublicPem! });
    if (!verified.ok) {
      return this.response({ technical: '061001', reportText: `auth signature: ${verified.reason}` });
    }

    const orderData = document(
      el('e:HPBResponseOrderData', {}, [
        this.keyInfo('AuthenticationPubKeyInfo', 'AuthenticationVersion', 'X002', this.authCertificatePem),
        this.keyInfo('EncryptionPubKeyInfo', 'EncryptionVersion', 'E002', this.encCertificatePem),
      ]),
      NS,
    );

    // HPB order data is not encrypted to us in this mock: the point of the
    // exchange is the KEYS, and the client's own verification step is the
    // digest comparison a human performs afterwards.
    return this.response({ orderData: Buffer.from(orderData, 'utf8').toString('base64') });
  }

  /** The bank's own key, as a certificate — the only form H005 defines. */
  private keyInfo(container: string, versionEl: string, version: string, certificatePem: string): XmlElement {
    return el(`e:${container}`, {}, [
      el('ds:X509Data', {}, [
        el('ds:X509Certificate', {}, [certificateDer(certificatePem).toString('base64')]),
      ]),
      el(`e:${versionEl}`, {}, [version]),
    ]);
  }

  // ── ebicsRequest: upload initialisation and transfer ─────────────────

  private request(root: XmlElement): string {
    const phase = textOf(at(root, EBICS_NS, 'header', 'mutable', 'TransactionPhase')).trim();
    const orderType = textOf(at(root, EBICS_NS, 'header', 'static', 'OrderDetails', 'AdminOrderType')).trim();
    if (phase === 'Initialisation') {
      if (orderType === 'BTD') return this.downloadInit(root);
      if (orderType === 'SPR') return this.subscriberLock(root);
      if (VEU_READS.has(orderType)) return this.veuRead(root, orderType);
      if (orderType === 'HVE' || orderType === 'HVS') return this.veuWriteInit(root, orderType);
      return this.uploadInit(root);
    }
    if (phase === 'Transfer') {
      // A download transfer carries no body; an upload one carries a segment.
      return at(root, EBICS_NS, 'body', 'DataTransfer') === null
        ? this.downloadSegment(root)
        : this.uploadTransfer(root);
    }
    if (phase === 'Receipt') return this.receipt(root);
    return this.response({ technical: '061002', reportText: `unknown phase ${phase}` });
  }

  /**
   * SPR — lock the subscriber.
   *
   * A single-shot upload: the bank verifies the authentication signature, then
   * forgets the subscriber, which is what a locked subscriber looks like from
   * here — every later request answers "unknown or not yet activated". No
   * transaction is opened, so there is no transfer phase to follow.
   */
  private subscriberLock(root: XmlElement): string {
    const statics = at(root, EBICS_NS, 'header', 'static')!;
    const partnerId = textOf(at(statics, EBICS_NS, 'PartnerID')).trim();
    const userId = textOf(at(statics, EBICS_NS, 'UserID')).trim();
    const key = this.subscriberKey(partnerId, userId);
    const subscriber = this.subscribers.get(key);
    if (subscriber?.authPublicPem === undefined) {
      return this.response({ technical: '091002', reportText: 'subscriber unknown or not yet activated' });
    }
    const verified = verifyAuthSignature({ root, bankAuthPublicPem: subscriber.authPublicPem });
    if (!verified.ok) {
      return this.response({ technical: '061001', reportText: `auth signature: ${verified.reason}` });
    }
    if (this.options.refuseSpr === true) {
      return this.response({ technical: '091002', reportText: 'this bank will not accept SPR from you' });
    }
    this.locked.add(key);
    this.subscribers.delete(key);
    return this.response({});
  }

  private uploadInit(root: XmlElement): string {
    const statics = at(root, EBICS_NS, 'header', 'static')!;
    const partnerId = textOf(at(statics, EBICS_NS, 'PartnerID')).trim();
    const userId = textOf(at(statics, EBICS_NS, 'UserID')).trim();
    const subscriber = this.subscribers.get(this.subscriberKey(partnerId, userId));
    if (subscriber?.authPublicPem === undefined || subscriber.esPublicPem === undefined) {
      return this.response({ technical: '091002', reportText: 'subscriber unknown' });
    }

    const verified = verifyAuthSignature({ root, bankAuthPublicPem: subscriber.authPublicPem });
    if (!verified.ok) {
      return this.response({ technical: '061001', reportText: `auth signature: ${verified.reason}` });
    }

    const dataTransfer = at(root, EBICS_NS, 'body', 'DataTransfer')!;
    const wrapped = textOf(at(dataTransfer, EBICS_NS, 'DataEncryptionInfo', 'TransactionKey')).replace(/\s+/g, '');
    let transactionKey: Buffer;
    try {
      transactionKey = decryptTransactionKey(BANK_ENC.privatePem, Buffer.from(wrapped, 'base64'));
    } catch {
      return this.response({ technical: '091104', reportText: 'the transaction key could not be decrypted' });
    }

    // The bank-technical signature travels encrypted under that same key.
    const signaturePacked = textOf(at(dataTransfer, EBICS_NS, 'SignatureData')).replace(/\s+/g, '');
    let signatureValue: Buffer;
    let esVersion: string;
    try {
      const signatureDoc = parse(unpackOrderData(transactionKey, signaturePacked).toString('utf8'));
      // esig:UserSignatureData → esig:OrderSignatureData, in the S002
      // namespace. Looked for in H005 for a long time, on both sides at once.
      const orderSignature = at(signatureDoc, ESIG_NS, 'OrderSignatureData')!;
      esVersion = textOf(at(orderSignature, ESIG_NS, 'SignatureVersion')).trim();
      signatureValue = Buffer.from(textOf(at(orderSignature, ESIG_NS, 'SignatureValue')), 'base64');
    } catch {
      return this.response({ technical: '091104', reportText: 'the signature data could not be decrypted' });
    }

    if (this.options.rejectInitWith !== undefined) {
      return this.response({
        business: this.options.rejectInitWith,
        reportText: 'the bank refused this order at initialisation',
      });
    }

    // A bank reads BTUOrderParams before it reads anything else, and an upload
    // that attaches an ES while asking for authorisation OUTSIDE EBICS — which
    // is what an absent SignatureFlag means — is inconsistent on its face. The
    // schema cannot catch it, because the element is optional there; every
    // upload this service makes carries a class-E signature and means it, so
    // the counterpart is where that gets enforced. (Which code a real bank
    // returns will differ; the range and the ReportText are what PS-12 acts on.)
    //
    // No test drives this branch, and it cannot easily be driven: the flag
    // lives inside the authenticated header, so stripping it from a built
    // request invalidates the auth signature and the bank refuses earlier. It
    // is here to make a regression in the builder loud rather than silent.
    const signature = this.signatureFlagOf(statics);
    if (!signature.flagPresent) {
      return this.response({
        technical: '091112',
        reportText: 'BTUOrderParams carries an ES but no SignatureFlag: authorisation outside EBICS was requested',
      });
    }

    const segments = Number.parseInt(textOf(at(statics, EBICS_NS, 'NumSegments')).trim() || '1', 10);
    const id = `MOCKTX-${++this.counter}`;
    this.transactions.set(id, {
      id,
      segmentsExpected: segments,
      segmentsReceived: 0,
      transactionKey,
      orderDataParts: [],
      promisedDigest: textOf(at(dataTransfer, EBICS_NS, 'DataDigest')).replace(/\s+/g, ''),
      esVersion,
      signatureValue,
      esPublicPem: subscriber.esPublicPem,
      btf: this.btfOf(statics),
      signature,
    });

    if (this.options.omitTransactionId === true) return this.response({ segments });
    return this.response({ transactionId: id, segments });
  }

  /**
   * Read `SignatureFlag` back out, as a bank would to decide what to do with
   * the ES it was handed.
   */
  private signatureFlagOf(statics: XmlElement): ReceivedOrder['signature'] {
    const flag = at(statics, EBICS_NS, 'OrderDetails', 'BTUOrderParams', 'SignatureFlag');
    if (flag === null) return { flagPresent: false, requestEDS: false };
    return { flagPresent: true, requestEDS: attrOf(flag, 'requestEDS') === 'true' };
  }

  /** Read the BTF back out of the request, as a bank would to route the file. */
  private btfOf(statics: XmlElement): ReceivedOrder['btf'] {
    const service = at(statics, EBICS_NS, 'OrderDetails', 'BTUOrderParams', 'Service');
    if (service === null) return { serviceName: '', scope: null, option: null, msgName: '', msgVersion: null };
    const msgName = at(service, EBICS_NS, 'MsgName');
    return {
      serviceName: textOf(at(service, EBICS_NS, 'ServiceName')).trim(),
      scope: nullIfEmpty(textOf(at(service, EBICS_NS, 'Scope')).trim()),
      option: nullIfEmpty(textOf(at(service, EBICS_NS, 'ServiceOption')).trim()),
      msgName: textOf(msgName).trim(),
      msgVersion: msgName === null ? null : nullIfEmpty(attrOf(msgName, 'version') ?? ''),
    };
  }

  private uploadTransfer(root: XmlElement): string {
    const id = textOf(at(root, EBICS_NS, 'header', 'static', 'TransactionID')).trim();
    const open = this.transactions.get(id);
    if (open === undefined) return this.response({ technical: '091111', reportText: 'unknown transaction' });

    const numberEl = at(root, EBICS_NS, 'header', 'mutable', 'SegmentNumber')!;
    const number = Number.parseInt(textOf(numberEl).trim(), 10);
    if (number !== open.segmentsReceived + 1) {
      // Out-of-order segments are a client bug that a lenient mock would hide.
      return this.response({ technical: '091110', reportText: `expected segment ${open.segmentsReceived + 1}` });
    }
    open.segmentsReceived = number;
    open.orderDataParts.push(textOf(at(root, EBICS_NS, 'body', 'DataTransfer', 'OrderData')).replace(/\s+/g, ''));

    if (attrOf(numberEl, 'lastSegment') !== 'true') return this.response({ transactionId: id });

    if (open.segmentsReceived !== open.segmentsExpected) {
      return this.response({
        technical: '091110',
        reportText: `expected ${open.segmentsExpected} segments, got ${open.segmentsReceived}`,
      });
    }

    // Everything is here: reassemble, decrypt, and check what was promised.
    let orderData: Buffer;
    try {
      orderData = unpackOrderData(open.transactionKey, open.orderDataParts.join(''));
    } catch {
      return this.response({ technical: '091104', reportText: 'order data could not be decrypted' });
    }

    if (sha256(orderData).toString('base64') !== open.promisedDigest) {
      return this.response({ technical: '000000', business: '091105', reportText: 'DataDigest does not match the file' });
    }

    if (open.veu !== undefined) return this.veuWriteFinish(id, open, orderData);

    const signatureValid = verifyOrderData(
      open.esPublicPem,
      orderData,
      open.signatureValue,
      open.esVersion === 'A006' ? 'A006' : 'A005',
    );
    if (!signatureValid) {
      return this.response({ technical: '000000', business: '091103', reportText: 'bank-technical signature invalid' });
    }

    this.transactions.delete(id);
    this.received.push({
      transactionId: id,
      orderData,
      btf: open.btf,
      signatureValid,
      signature: open.signature,
    });

    if (this.options.rejectUploadsWith !== undefined) {
      return this.response({
        transactionId: id,
        business: this.options.rejectUploadsWith,
        reportText: 'the bank refused this order',
      });
    }
    return this.response({ transactionId: id });
  }

  // ── BTD: handing a file over ─────────────────────────────────────────

  /**
   * HVU / HVZ / HVD / HVT — answer from the queue.
   *
   * Built as a real download so the client's segment loop, decryption and
   * receipt all run: a VEU read that skipped that machinery would prove only
   * that the request was well formed.
   */
  private veuRead(root: XmlElement, orderType: string): string {
    const statics = at(root, EBICS_NS, 'header', 'static')!;
    const subscriber = this.authenticated(root, statics);
    if (typeof subscriber === 'string') return subscriber;

    const params = at(statics, EBICS_NS, 'OrderDetails', `${orderType}OrderParams`);
    const orderId = params === null ? '' : textOf(at(params, EBICS_NS, 'OrderID')).trim();
    const body = this.veuDocument(orderType, orderId);
    if (body === null) return this.response({ technical: '090005', reportText: 'nothing in the signature queue' });
    return this.serveDownload(subscriber, Buffer.from(body, 'utf8'));
  }

  /**
   * HVE / HVS — accept a co-signature or a cancellation.
   *
   * The bank checks the ES the same way it checks an upload's, which is the
   * point of exercising it: a co-signature computed over the wrong bytes is
   * caught here rather than admired in a golden envelope.
   */
  private veuWriteInit(root: XmlElement, orderType: 'HVE' | 'HVS'): string {
    const statics = at(root, EBICS_NS, 'header', 'static')!;
    const subscriber = this.authenticated(root, statics);
    if (typeof subscriber === 'string') return subscriber;

    const params = at(statics, EBICS_NS, 'OrderDetails', `${orderType}OrderParams`);
    const orderId = params === null ? '' : textOf(at(params, EBICS_NS, 'OrderID')).trim();
    const queued = this.veuQueue.find((q) => q.orderId === orderId);
    if (queued === undefined) {
      return this.response({ technical: '091112', reportText: `no queued order ${orderId}` });
    }

    const dataTransfer = at(root, EBICS_NS, 'body', 'DataTransfer')!;
    const transactionKey = decryptTransactionKey(
      BANK_ENC.privatePem,
      Buffer.from(
        textOf(at(dataTransfer, EBICS_NS, 'DataEncryptionInfo', 'TransactionKey')).replace(/\s+/g, ''),
        'base64',
      ),
    );
    const id = `MOCKVEU-${++this.counter}`;
    this.transactions.set(id, {
      id,
      segmentsExpected: 1,
      segmentsReceived: 0,
      transactionKey,
      orderDataParts: [],
      promisedDigest: textOf(at(dataTransfer, EBICS_NS, 'DataDigest')).replace(/\s+/g, ''),
      esVersion: 'A005',
      signatureValue: Buffer.alloc(0),
      esPublicPem: subscriber.esPublicPem!,
      btf: { serviceName: orderType, scope: null, option: null, msgName: '', msgVersion: null },
      signature: { flagPresent: true, requestEDS: false },
      veu: { orderType, orderId },
    });
    return this.response({ transactionId: id, segments: 1 });
  }

  /**
   * The order data for a queue read, built from `veuQueue`.
   *
   * Written with the same canonical writer the client uses, so these documents
   * are the shapes `schema.test.ts` and `veu-parse.test.ts` validate — a mock
   * that emitted its own dialect would agree with a parser that reads it and
   * with nothing else.
   */
  private veuDocument(orderType: string, orderId: string): string | null {
    const live = this.veuQueue.filter((q) => q.cancelled !== true);
    if (orderType === 'HVU' || orderType === 'HVZ') {
      if (live.length === 0) return null;
      return document(
        el(`e:${orderType}ResponseOrderData`, {}, live.map((q) => this.veuOrderDetails(q, orderType === 'HVZ'))),
        { e: EBICS_NS },
      );
    }

    const order = live.find((q) => q.orderId === orderId);
    if (order === undefined) return null;

    if (orderType === 'HVD') {
      return document(
        el('e:HVDResponseOrderData', {}, [
          el('e:DataDigest', { SignatureVersion: 'A005' }, [sha256(order.content).toString('base64')]),
          el('e:DisplayFile', {}, [Buffer.from(`order ${order.orderId}`, 'utf8').toString('base64')]),
          el('e:OrderDataAvailable', {}, ['true']),
          el('e:OrderDataSize', {}, [String(order.content.byteLength)]),
          el('e:OrderDetailsAvailable', {}, ['true']),
          ...order.signatures.map((sig) =>
            el('e:SignerInfo', {}, [
              el('e:PartnerID', {}, [sig.partnerId]),
              el('e:UserID', {}, [sig.userId]),
              el('e:Timestamp', {}, ['2026-08-21T10:00:00Z']),
              el('e:Permission', { AuthorisationLevel: 'E' }),
            ]),
          ),
        ]),
        { e: EBICS_NS },
      );
    }

    // HVT.
    return document(
      el('e:HVTResponseOrderData', {}, [
        el('e:NumOrderInfos', {}, ['1']),
        el('e:OrderInfo', {}, [
          el('e:AccountInfo', {}, [
            el('e:AccountNumber', { Role: 'Originator', international: 'true' }, ['AT611904300234573201']),
            el('e:AccountHolder', { Role: 'Originator' }, ['0815software GmbH']),
          ]),
          el('e:AccountInfo', {}, [
            el('e:AccountNumber', { Role: 'Recipient', international: 'true' }, ['AT483200000012345864']),
            el('e:AccountHolder', { Role: 'Recipient' }, ['Stadtwerke Wien Energie GmbH']),
          ]),
          el('e:Amount', { isCredit: 'false', Currency: 'EUR' }, ['421.80']),
          el('e:Description', { Type: 'Purpose' }, ['Stromabrechnung']),
        ]),
      ]),
      { e: EBICS_NS },
    );
  }

  private veuOrderDetails(order: QueuedForSignature, withPayment: boolean): XmlElement {
    return el('e:OrderDetails', {}, [
      el('e:Service', {}, [
        el('e:ServiceName', {}, [order.service.serviceName]),
        order.service.scope === undefined ? null : el('e:Scope', {}, [order.service.scope]),
        order.service.option === undefined ? null : el('e:ServiceOption', {}, [order.service.option]),
        el('e:MsgName', {}, [order.service.msgName]),
      ]),
      el('e:OrderID', {}, [order.orderId]),
      // HVZ carries the digest and the payment summary; HVU carries neither,
      // and the element order below is the schema's, not a convenience.
      ...(withPayment
        ? [
            el('e:DataDigest', { SignatureVersion: 'A005' }, [sha256(order.content).toString('base64')]),
            el('e:OrderDataAvailable', {}, ['true']),
            el('e:OrderDataSize', {}, [String(order.content.byteLength)]),
            el('e:OrderDetailsAvailable', {}, ['true']),
            el('e:TotalOrders', {}, ['3']),
            el('e:TotalAmount', { isCredit: 'false' }, ['2214.80']),
            el('e:Currency', {}, ['EUR']),
          ]
        : [el('e:OrderDataSize', {}, [String(order.content.byteLength)])]),
      el('e:SigningInfo', {
        readyToBeSigned: order.readyToBeSigned ? 'true' : 'false',
        NumSigRequired: String(order.signaturesRequired),
        NumSigDone: String(order.signatures.length),
      }),
      ...order.signatures.map((sig) =>
        el('e:SignerInfo', {}, [
          el('e:PartnerID', {}, [sig.partnerId]),
          el('e:UserID', {}, [sig.userId]),
          el('e:Timestamp', {}, ['2026-08-21T10:00:00Z']),
          el('e:Permission', { AuthorisationLevel: 'E' }),
        ]),
      ),
      el('e:OriginatorInfo', {}, [
        el('e:PartnerID', {}, [order.originator.partnerId]),
        el('e:UserID', {}, [order.originator.userId]),
        el('e:Timestamp', {}, ['2026-08-21T09:59:00Z']),
      ]),
    ]);
  }

  private downloadInit(root: XmlElement): string {
    const statics = at(root, EBICS_NS, 'header', 'static')!;
    const partnerId = textOf(at(statics, EBICS_NS, 'PartnerID')).trim();
    const userId = textOf(at(statics, EBICS_NS, 'UserID')).trim();
    const subscriber = this.subscribers.get(this.subscriberKey(partnerId, userId));
    if (subscriber?.authPublicPem === undefined || subscriber.encPublicPem === undefined) {
      return this.response({ technical: '091002', reportText: 'subscriber unknown' });
    }

    const verified = verifyAuthSignature({ root, bankAuthPublicPem: subscriber.authPublicPem });
    if (!verified.ok) {
      return this.response({ technical: '061001', reportText: `auth signature: ${verified.reason}` });
    }

    // A download carries no bank-technical signature: the client is asking,
    // not authorising. A client that sent one would be confusing its keys.
    if (at(root, EBICS_NS, 'body', 'DataTransfer') !== null) {
      return this.response({ technical: '061002', reportText: 'a download request carries no data' });
    }

    const service = at(statics, EBICS_NS, 'OrderDetails', 'BTDOrderParams', 'Service');
    const btfKey = `${textOf(at(service, EBICS_NS, 'ServiceName')).trim()}/${textOf(
      at(service, EBICS_NS, 'MsgName'),
    ).trim()}`;
    const queued = this.queue.find((item) => item.btfKey === btfKey);
    if (queued === undefined) {
      // Nothing waiting — the ordinary answer on most polls, and not an error.
      return this.response({ technical: '090005', reportText: 'no download data available' });
    }

    return this.serveDownload(subscriber, queued.content, queued);
  }

  /**
   * Everything a download has in common: encrypt to the SUBSCRIBER's key,
   * segment, open a transaction, answer with the first segment.
   *
   * Encrypting downwards is the mirror of the upload, and the reason E002 is a
   * key pair rather than a shared secret.
   */
  private serveDownload(subscriber: Subscriber, content: Buffer, queued?: Queued): string {
    const transactionKey = newTransactionKey();
    const packed = packOrderData(transactionKey, content);
    const limit = this.options.downloadSegmentLimit ?? packed.length;
    const segments: string[] = [];
    for (let i = 0; i < packed.length; i += limit) segments.push(packed.slice(i, i + limit));

    const id = `MOCKDL-${++this.counter}`;
    this.openDownloads.set(id, { id, queued, segments });

    return this.response({
      transactionId: id,
      segments: segments.length,
      orderData: segments[0],
      transactionKey: encryptTransactionKey(subscriber.encPublicPem!, transactionKey).toString('base64'),
      segmentNumber: 1,
      lastSegment: segments.length === 1,
    });
  }

  /**
   * The two checks every protected request starts with, or the refusal to
   * send back. A string means "answer with this and stop".
   */
  private authenticated(root: XmlElement, statics: XmlElement): Subscriber | string {
    const partnerId = textOf(at(statics, EBICS_NS, 'PartnerID')).trim();
    const userId = textOf(at(statics, EBICS_NS, 'UserID')).trim();
    const subscriber = this.subscribers.get(this.subscriberKey(partnerId, userId));
    if (subscriber?.authPublicPem === undefined || subscriber.encPublicPem === undefined) {
      return this.response({ technical: '091002', reportText: 'subscriber unknown' });
    }
    const verified = verifyAuthSignature({ root, bankAuthPublicPem: subscriber.authPublicPem });
    if (!verified.ok) {
      return this.response({ technical: '061001', reportText: `auth signature: ${verified.reason}` });
    }
    return subscriber;
  }

  /**
   * The end of an HVE or HVS transfer — where the bank decides whether the
   * co-signature is real.
   *
   * For HVE it verifies the ES against the digest of the ORDER, not of the
   * signature document: the co-signatory signed the queued order's data, which
   * is the whole point and the thing a mock that just said "accepted" would
   * never have checked. That verification is what makes `signDigest` testable
   * against something other than itself.
   */
  private veuWriteFinish(id: string, open: OpenTransaction, orderData: Buffer): string {
    const veu = open.veu!;
    this.transactions.delete(id);
    const order = this.veuQueue.find((q) => q.orderId === veu.orderId);
    if (order === undefined) {
      return this.response({ transactionId: id, technical: '091112', reportText: 'order gone from the queue' });
    }

    if (veu.orderType === 'HVS') {
      const named = textOf(at(parse(orderData.toString('utf8')), EBICS_NS, 'CancelledDataDigest')).replace(/\s+/g, '');
      if (named !== sha256(order.content).toString('base64')) {
        // Cancelling by digest is what stops a client aiming HVS at an order
        // it has never looked at.
        return this.response({
          transactionId: id,
          business: '091105',
          reportText: 'CancelledDataDigest does not match the queued order',
        });
      }
      order.cancelled = true;
      return this.response({ transactionId: id });
    }

    // HVE: the OrderSignatureData inside carries the ES over the ORDER's data.
    const signature = at(parse(orderData.toString('utf8')), ESIG_NS, 'OrderSignatureData');
    if (signature === null) {
      return this.response({ transactionId: id, technical: '091113', reportText: 'no OrderSignatureData' });
    }
    const value = Buffer.from(textOf(at(signature, ESIG_NS, 'SignatureValue')).replace(/\s+/g, ''), 'base64');
    const valid = verifyOrderData(open.esPublicPem, order.content, value, 'A005');
    order.signatures.push({
      partnerId: textOf(at(signature, ESIG_NS, 'PartnerID')).trim(),
      userId: textOf(at(signature, ESIG_NS, 'UserID')).trim(),
      valid,
    });
    if (!valid) {
      return this.response({ transactionId: id, business: '091103', reportText: 'co-signature does not verify' });
    }
    order.signaturesDone = order.signatures.length;
    if (order.signaturesDone >= order.signaturesRequired) order.readyToBeSigned = false;
    return this.response({ transactionId: id });
  }

  private downloadSegment(root: XmlElement): string {
    const id = textOf(at(root, EBICS_NS, 'header', 'static', 'TransactionID')).trim();
    const open = this.openDownloads.get(id);
    if (open === undefined) return this.response({ technical: '091111', reportText: 'unknown transaction' });

    const number = Number.parseInt(textOf(at(root, EBICS_NS, 'header', 'mutable', 'SegmentNumber')).trim(), 10);
    const segment = open.segments[number - 1];
    if (segment === undefined) {
      return this.response({ technical: '091110', reportText: `no segment ${number}` });
    }
    return this.response({
      transactionId: id,
      orderData: segment,
      segmentNumber: number,
      lastSegment: number === open.segments.length,
    });
  }

  /**
   * The receipt. **This is where a file leaves the queue** — and only on a
   * POSITIVE one.
   *
   * A client that acknowledges before storing the bytes loses the file here,
   * exactly as it would at a real bank, which is the whole reason this mock
   * keeps a queue rather than answering from a fixture.
   */
  private receipt(root: XmlElement): string {
    const id = textOf(at(root, EBICS_NS, 'header', 'static', 'TransactionID')).trim();
    const open = this.openDownloads.get(id);
    if (open === undefined) return this.response({});

    const code = textOf(at(root, EBICS_NS, 'body', 'TransferReceipt', 'ReceiptCode')).trim();
    if (code === '0') {
      const index = this.queue.indexOf(open.queued);
      if (index >= 0) this.queue.splice(index, 1);
    }
    this.openDownloads.delete(id);
    return this.response({});
  }

  // ── Response building ───────────────────────────────────────────────

  private response(parts: {
    technical?: string;
    business?: string;
    reportText?: string;
    transactionId?: string;
    segments?: number;
    orderData?: string;
    transactionKey?: string;
    segmentNumber?: number;
    lastSegment?: boolean;
  }): string {
    const root = el('e:ebicsResponse', { Version: 'H005', Revision: '1' }, [
      el('e:header', { authenticate: 'true' }, [
        el('e:static', {}, [
          parts.transactionId !== undefined ? el('e:TransactionID', {}, [parts.transactionId]) : null,
          parts.segments !== undefined ? el('e:NumSegments', {}, [String(parts.segments)]) : null,
        ]),
        el('e:mutable', {}, [
          parts.segmentNumber === undefined
            ? null
            : el(
                'e:SegmentNumber',
                parts.lastSegment === true ? { lastSegment: 'true' } : {},
                [String(parts.segmentNumber)],
              ),
          el('e:ReturnCode', {}, [parts.technical ?? '000000']),
          el('e:ReportText', {}, [parts.reportText ?? 'OK']),
        ]),
      ]),
      el('e:body', {}, [
        parts.orderData !== undefined
          ? el('e:DataTransfer', {}, [
              parts.transactionKey === undefined
                ? null
                : el('e:DataEncryptionInfo', { authenticate: 'true' }, [
                    el('e:TransactionKey', {}, [parts.transactionKey]),
                  ]),
              el('e:OrderData', {}, [parts.orderData]),
            ])
          : null,
        el('e:ReturnCode', {}, [parts.business ?? '000000']),
      ]),
    ]);

    // The bank signs its responses, so the client's verification is exercised
    // on every single call rather than only where a test remembers to check.
    const signature = buildAuthSignature({ root, ns: NS, authPrivatePem: BANK_AUTH.privatePem });
    root.children.splice(1, 0, signature);
    return document(root, NS);
  }

  private subscriberKey(partnerId: string, userId: string): string {
    return `${partnerId}|${userId}`;
  }
}

function nullIfEmpty(value: string): string | null {
  return value === '' ? null : value;
}

/** A fixed certificate for one of the bank's keys — no clock, no randomness. */
function bankCertificate(privatePem: string, purpose: 'AUTH' | 'ENC'): string {
  return selfSignedCertificate({
    privatePem,
    purpose,
    subject: { commonName: `MOCKBANK-${purpose}`, organizationName: 'Mock Bank' },
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: new Date('2036-01-01T00:00:00Z'),
    serial: Buffer.from([0x01, 0x02]),
  });
}
