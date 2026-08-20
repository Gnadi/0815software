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
import { EBICS_NS, HEV_NS, NS } from '../server/ebics/envelopes.js';
import {
  decryptTransactionKey,
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
 */

export interface MockBankOptions {
  hostId?: string;
  /** Force a business-level rejection on the next upload, e.g. '091303'. */
  rejectUploadsWith?: string;
  /** Make HPB answer before INI/HIA, to test the client's ordering. */
  allowHpbBeforeInit?: boolean;
}

interface Subscriber {
  partnerId: string;
  userId: string;
  esPublicPem?: string;
  esVersion?: string;
  authPublicPem?: string;
  encPublicPem?: string;
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
}

/** What the bank did with a file, so a test can assert on the bank's view. */
export interface ReceivedOrder {
  transactionId: string;
  /** The plaintext file, reassembled and decrypted by the bank. */
  orderData: Buffer;
  btf: { serviceName: string; msgName: string };
  /** True when the bank-technical signature verified over that file. */
  signatureValid: boolean;
}

export class MockBank {
  readonly hostId: string;
  readonly authPublicPem = BANK_AUTH.publicPem;
  readonly encPublicPem = BANK_ENC.publicPem;

  /** Every file the bank accepted, in order — what a test asserts against. */
  readonly received: ReceivedOrder[] = [];
  /** Every request body it was sent, for tests about what went on the wire. */
  readonly requests: string[] = [];

  private readonly subscribers = new Map<string, Subscriber>();
  private readonly transactions = new Map<string, OpenTransaction>();
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
      const info = at(orderData, EBICS_NS, 'SignaturePubKeyInfo');
      subscriber.esPublicPem = this.pemFrom(info!);
      subscriber.esVersion = textOf(at(info!, EBICS_NS, 'SignatureVersion')).trim();
    } else if (orderType === 'HIA') {
      subscriber.authPublicPem = this.pemFrom(at(orderData, EBICS_NS, 'AuthenticationPubKeyInfo')!);
      subscriber.encPublicPem = this.pemFrom(at(orderData, EBICS_NS, 'EncryptionPubKeyInfo')!);
    } else {
      return this.response({ technical: '091117', reportText: `unsupported order type ${orderType}` });
    }

    this.subscribers.set(key, subscriber);
    return this.response({});
  }

  /** Rebuild a PEM from the modulus and exponent inside a PubKeyInfo. */
  private pemFrom(info: XmlElement): string {
    const modulus = Buffer.from(textOf(findAll(info, (n) => n.local === 'Modulus')[0]!).replace(/\s+/g, ''), 'base64');
    const exponent = Buffer.from(
      textOf(findAll(info, (n) => n.local === 'Exponent')[0]!).replace(/\s+/g, ''),
      'base64',
    );
    return spkiPemFromParts(modulus, exponent);
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
        this.keyInfo('AuthenticationPubKeyInfo', 'AuthenticationVersion', 'X002', this.authPublicPem),
        this.keyInfo('EncryptionPubKeyInfo', 'EncryptionVersion', 'E002', this.encPublicPem),
      ]),
      NS,
    );

    // HPB order data is not encrypted to us in this mock: the point of the
    // exchange is the KEYS, and the client's own verification step is the
    // digest comparison a human performs afterwards.
    return this.response({ orderData: Buffer.from(orderData, 'utf8').toString('base64') });
  }

  private keyInfo(container: string, versionEl: string, version: string, pem: string): XmlElement {
    const { modulus, exponent } = publicKeyParts(pem);
    return el(`e:${container}`, {}, [
      el('e:PubKeyValue', {}, [
        el('ds:RSAKeyValue', {}, [
          el('ds:Modulus', {}, [modulus.toString('base64')]),
          el('ds:Exponent', {}, [exponent.toString('base64')]),
        ]),
      ]),
      el(`e:${versionEl}`, {}, [version]),
    ]);
  }

  // ── ebicsRequest: upload initialisation and transfer ─────────────────

  private request(root: XmlElement): string {
    const phase = textOf(at(root, EBICS_NS, 'header', 'mutable', 'TransactionPhase')).trim();
    if (phase === 'Initialisation') return this.uploadInit(root);
    if (phase === 'Transfer') return this.uploadTransfer(root);
    if (phase === 'Receipt') return this.response({});
    return this.response({ technical: '061002', reportText: `unknown phase ${phase}` });
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
      const orderSignature = at(signatureDoc, EBICS_NS, 'OrderSignature')!;
      esVersion = textOf(at(orderSignature, EBICS_NS, 'SignatureVersion')).trim();
      signatureValue = Buffer.from(textOf(at(orderSignature, EBICS_NS, 'SignatureValue')), 'base64');
    } catch {
      return this.response({ technical: '091104', reportText: 'the signature data could not be decrypted' });
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
    });

    return this.response({ transactionId: id, segments });
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

    const subscriber = [...this.subscribers.values()].find((s) => s.esPublicPem !== undefined);
    const signatureValid = verifyOrderData(
      subscriber!.esPublicPem!,
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
      btf: { serviceName: '', msgName: '' },
      signatureValid,
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

  // ── Response building ───────────────────────────────────────────────

  private response(parts: {
    technical?: string;
    business?: string;
    reportText?: string;
    transactionId?: string;
    segments?: number;
    orderData?: string;
  }): string {
    const root = el('e:ebicsResponse', { Version: 'H005', Revision: '1' }, [
      el('e:header', { authenticate: 'true' }, [
        el('e:static', {}, [
          parts.transactionId !== undefined ? el('e:TransactionID', {}, [parts.transactionId]) : null,
          parts.segments !== undefined ? el('e:NumSegments', {}, [String(parts.segments)]) : null,
        ]),
        el('e:mutable', {}, [
          el('e:ReturnCode', {}, [parts.technical ?? '000000']),
          el('e:ReportText', {}, [parts.reportText ?? 'OK']),
        ]),
      ]),
      el('e:body', {}, [
        parts.orderData !== undefined
          ? el('e:DataTransfer', {}, [el('e:OrderData', {}, [parts.orderData])])
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
