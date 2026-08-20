import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import {
  btfToString,
  buildHev,
  buildHia,
  buildHpb,
  buildIni,
  buildReceipt,
  buildTransfer,
  buildUploadInit,
  EBICS_NS,
  NS,
  type BankKeys,
  type Btf,
  type Subscriber,
  type SubscriberKeys,
} from '../server/ebics/envelopes.js';
import { at, attrOf, findAll, parse, textOf } from '../server/ebics/xml.js';
import { authenticatedBytes, verifyAuthSignature, AUTHENTICATE_URI } from '../server/ebics/dsig.js';
import {
  decryptTransactionKey,
  publicKeyDigest,
  sha256,
  unpackOrderData,
  verifyOrderData,
} from '../server/ebics/crypto.js';
import { AUTH, BANK_AUTH, BANK_ENC, ENC, ES } from './fixtures/keys.js';

/**
 * The H005 envelopes.
 *
 * Two kinds of assertion here, and both matter for different reasons:
 *
 *  - **Shape**: the elements a bank's schema validator will look for, in the
 *    order a sequence-typed schema demands. Order is not decorative in XSD.
 *  - **Round-trip**: that what we put in the envelope can be taken back out by
 *    someone holding the other half of the keys — which is the only way to know
 *    the crypto pipeline was assembled the right way round without a bank.
 */

const subscriber: Subscriber = { hostId: 'EBIXHOST', partnerId: 'PARTNER1', userId: 'USER1' };

const keys: SubscriberKeys = {
  esPrivatePem: ES.privatePem,
  esVersion: 'A005',
  authPrivatePem: AUTH.privatePem,
  encPrivatePem: ENC.privatePem,
};

const bank: BankKeys = { authPublicPem: BANK_AUTH.publicPem, encPublicPem: BANK_ENC.publicPem };

const btf: Btf = { serviceName: 'SCT', scope: 'DE', msgName: 'pain.001', msgVersion: '09', container: 'XML' };

/** A fixed transaction key: the tests are about structure, not about entropy. */
const transactionKey = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const TIMESTAMP = '2026-08-19T09:30:00Z';

/** Local names of an element's children, in document order. */
function shapeOf(node: ReturnType<typeof parse> | null): string[] {
  return node === null ? [] : node.children.filter((c) => c.kind === 'element').map((c) => (c as { local: string }).local);
}

describe('BTF — the parameters that decide whether a perfect upload is accepted', () => {
  it('prints the way a bank documents it', () => {
    expect(btfToString(btf)).toBe('SCT/DE//pain.001/XML');
    // Optional parts collapse to empty slots rather than vanishing — the
    // position of each field is what makes the notation readable.
    expect(btfToString({ serviceName: 'SCT', msgName: 'pain.001' })).toBe('SCT///pain.001');
  });
});

describe('HEV — asked before anything is set up', () => {
  it('uses its own namespace, because the H005 one is not agreed yet', () => {
    const root = parse(buildHev('EBIXHOST'));
    expect(root.uri).toBe('http://www.ebics.org/H000');
    expect(root.local).toBe('ebicsHEVRequest');
    expect(textOf(at(root, 'http://www.ebics.org/H000', 'HostID'))).toBe('EBIXHOST');
  });
});

describe('INI and HIA — unsecured, and necessarily so', () => {
  const ini = parse(buildIni({ subscriber, esPublicPem: ES.publicPem, esVersion: 'A005', timestamp: TIMESTAMP }));
  const hia = parse(
    buildHia({ subscriber, authPublicPem: AUTH.publicPem, encPublicPem: ENC.publicPem, timestamp: TIMESTAMP }),
  );

  it('carries NO signature — there is no key the bank could check it with', () => {
    expect(findAll(ini, (n) => n.local === 'AuthSignature')).toHaveLength(0);
    expect(findAll(hia, (n) => n.local === 'AuthSignature')).toHaveLength(0);
  });

  it('declares the right admin order type', () => {
    expect(textOf(at(ini, EBICS_NS, 'header', 'static', 'OrderDetails', 'AdminOrderType'))).toBe('INI');
    expect(textOf(at(hia, EBICS_NS, 'header', 'static', 'OrderDetails', 'AdminOrderType'))).toBe('HIA');
  });

  it('packs the order data as deflate+base64, and it inflates back to our key', () => {
    const packed = textOf(at(ini, EBICS_NS, 'body', 'DataTransfer', 'OrderData'));
    const orderData = parse(inflateSync(Buffer.from(packed, 'base64')).toString('utf8'));
    expect(orderData.local).toBe('SignaturePubKeyOrderData');
    expect(textOf(at(orderData, EBICS_NS, 'SignaturePubKeyInfo', 'SignatureVersion'))).toBe('A005');
    expect(textOf(at(orderData, EBICS_NS, 'PartnerID'))).toBe('PARTNER1');
  });

  it('sends HIA’s two keys with the versions that identify their purpose', () => {
    const packed = textOf(at(hia, EBICS_NS, 'body', 'DataTransfer', 'OrderData'));
    const orderData = parse(inflateSync(Buffer.from(packed, 'base64')).toString('utf8'));
    expect(textOf(at(orderData, EBICS_NS, 'AuthenticationPubKeyInfo', 'AuthenticationVersion'))).toBe('X002');
    expect(textOf(at(orderData, EBICS_NS, 'EncryptionPubKeyInfo', 'EncryptionVersion'))).toBe('E002');
  });

  it('is reproducible: the same inputs give the same bytes', () => {
    expect(buildIni({ subscriber, esPublicPem: ES.publicPem, esVersion: 'A005', timestamp: TIMESTAMP })).toBe(
      buildIni({ subscriber, esPublicPem: ES.publicPem, esVersion: 'A005', timestamp: TIMESTAMP }),
    );
  });
});

describe('HPB — authenticated, but with no key digests to give', () => {
  const xml = buildHpb({ subscriber, keys, timestamp: TIMESTAMP });
  const root = parse(xml);

  it('is signed with X002 and verifies against our own auth key', () => {
    expect(verifyAuthSignature({ root, bankAuthPublicPem: AUTH.publicPem })).toEqual({ ok: true });
  });

  it('carries no BankPubKeyDigests — that is the point of this message', () => {
    expect(findAll(root, (n) => n.local === 'BankPubKeyDigests')).toHaveLength(0);
  });

  it('puts the signature between the header and the body, as the schema requires', () => {
    expect(shapeOf(root)).toEqual(['header', 'AuthSignature', 'body']);
  });

  it('uses a nonce that changes with the timestamp but stays reproducible', () => {
    const other = parse(buildHpb({ subscriber, keys, timestamp: '2026-08-19T09:30:01Z' }));
    const nonceOf = (r: typeof root): string => textOf(at(r, EBICS_NS, 'header', 'static', 'Nonce'));
    expect(nonceOf(root)).toMatch(/^[0-9A-F]{32}$/);
    expect(nonceOf(other)).not.toBe(nonceOf(root));
    expect(nonceOf(parse(buildHpb({ subscriber, keys, timestamp: TIMESTAMP })))).toBe(nonceOf(root));
  });
});

describe('BTU upload — the message that moves money', () => {
  const xml = buildUploadInit({
    subscriber,
    keys,
    bank,
    btf,
    orderData: Buffer.from('<Document>pain.001 here</Document>', 'utf8'),
    transactionKey,
    timestamp: TIMESTAMP,
    segments: 1,
  });
  const root = parse(xml);

  it('is a BTU order carrying the BTF the bank documented', () => {
    const details = at(root, EBICS_NS, 'header', 'static', 'OrderDetails');
    expect(textOf(at(details!, EBICS_NS, 'AdminOrderType'))).toBe('BTU');
    const service = at(details!, EBICS_NS, 'BTUOrderParams', 'Service');
    expect(textOf(at(service!, EBICS_NS, 'ServiceName'))).toBe('SCT');
    expect(textOf(at(service!, EBICS_NS, 'Scope'))).toBe('DE');
    const msgName = at(service!, EBICS_NS, 'MsgName');
    expect(textOf(msgName)).toBe('pain.001');
    expect(attrOf(msgName!, 'version')).toBe('09');
  });

  it('proves to the bank that we hold the right bank keys, by digest', () => {
    const digests = at(root, EBICS_NS, 'header', 'static', 'BankPubKeyDigests');
    expect(textOf(at(digests!, EBICS_NS, 'Authentication'))).toBe(
      publicKeyDigest(BANK_AUTH.publicPem).toString('base64'),
    );
    expect(textOf(at(digests!, EBICS_NS, 'Encryption'))).toBe(
      publicKeyDigest(BANK_ENC.publicPem).toString('base64'),
    );
  });

  it('wraps the transaction key so only the bank can open it', () => {
    const wrapped = textOf(at(root, EBICS_NS, 'body', 'DataTransfer', 'DataEncryptionInfo', 'TransactionKey'));
    const recovered = decryptTransactionKey(BANK_ENC.privatePem, Buffer.from(wrapped, 'base64'));
    expect(recovered.equals(transactionKey)).toBe(true);
  });

  /**
   * The assertion this whole service exists to get right: the bank-technical
   * signature travels inside the encrypted SignatureData, and it verifies
   * against our ES public key over the ORDER DATA — not over the envelope, not
   * over a digest of a digest.
   */
  it('carries a bank-technical signature that verifies over the order data', () => {
    const packed = textOf(at(root, EBICS_NS, 'body', 'DataTransfer', 'SignatureData'));
    // The bank decrypts with the transaction key it just unwrapped.
    const signatureXml = unpackOrderData(transactionKey, packed).toString('utf8');
    const signatureDoc = parse(signatureXml);
    expect(signatureDoc.local).toBe('UserSignatureData');

    const orderSignature = at(signatureDoc, EBICS_NS, 'OrderSignature');
    expect(attrOf(orderSignature!, 'PartnerID')).toBe('PARTNER1');
    expect(textOf(at(orderSignature!, EBICS_NS, 'SignatureVersion'))).toBe('A005');

    const value = Buffer.from(textOf(at(orderSignature!, EBICS_NS, 'SignatureValue')), 'base64');
    const payload = Buffer.from('<Document>pain.001 here</Document>', 'utf8');
    expect(verifyOrderData(ES.publicPem, payload, value, 'A005')).toBe(true);
    // And it is a signature over THIS file, not any file.
    expect(verifyOrderData(ES.publicPem, Buffer.from('<Document>other</Document>'), value, 'A005')).toBe(false);
  });

  it('states the digest of the order data the bank should expect', () => {
    const digest = at(root, EBICS_NS, 'body', 'DataTransfer', 'DataDigest');
    expect(textOf(digest)).toBe(sha256(Buffer.from('<Document>pain.001 here</Document>')).toString('base64'));
    expect(attrOf(digest!, 'SignatureVersion')).toBe('A005');
  });

  it('signs the authenticated nodes — header AND the encryption blocks', () => {
    const authenticated = findAll(root, (n) => attrOf(n, 'authenticate') === 'true').map((n) => n.local);
    expect(authenticated).toEqual(['header', 'DataEncryptionInfo', 'SignatureData']);
    expect(verifyAuthSignature({ root, bankAuthPublicPem: AUTH.publicPem })).toEqual({ ok: true });
  });

  it('is reproducible byte for byte, which is what makes a resumed transfer safe', () => {
    const again = buildUploadInit({
      subscriber,
      keys,
      bank,
      btf,
      orderData: Buffer.from('<Document>pain.001 here</Document>', 'utf8'),
      transactionKey,
      timestamp: TIMESTAMP,
      segments: 1,
    });
    // A005 is deterministic (PKCS#1 v1.5), so identical inputs give identical
    // bytes. The E002 key wrap is randomised, so the ENVELOPES differ there —
    // which is why this compares the signed order data rather than the whole file.
    const a = textOf(at(parse(again), EBICS_NS, 'body', 'DataTransfer', 'SignatureData'));
    const b = textOf(at(root, EBICS_NS, 'body', 'DataTransfer', 'SignatureData'));
    expect(a).toBe(b);
  });
});

describe('transfer and receipt', () => {
  it('numbers segments and marks the last one', () => {
    const middle = parse(
      buildTransfer({ subscriber, keys, transactionId: 'TX1', segmentNumber: 1, lastSegment: false, segment: 'AAA' }),
    );
    const last = parse(
      buildTransfer({ subscriber, keys, transactionId: 'TX1', segmentNumber: 2, lastSegment: true, segment: 'BBB' }),
    );
    const numberOf = (r: typeof middle) => at(r, EBICS_NS, 'header', 'mutable', 'SegmentNumber')!;

    expect(textOf(numberOf(middle))).toBe('1');
    expect(attrOf(numberOf(middle), 'lastSegment')).toBeNull();
    expect(textOf(numberOf(last))).toBe('2');
    expect(attrOf(numberOf(last), 'lastSegment')).toBe('true');
    expect(textOf(at(middle, EBICS_NS, 'header', 'mutable', 'TransactionPhase'))).toBe('Transfer');
  });

  it('carries the transaction id the bank assigned', () => {
    const root = parse(
      buildTransfer({ subscriber, keys, transactionId: 'TX-42', segmentNumber: 1, lastSegment: true, segment: 'x' }),
    );
    expect(textOf(at(root, EBICS_NS, 'header', 'static', 'TransactionID'))).toBe('TX-42');
    expect(verifyAuthSignature({ root, bankAuthPublicPem: AUTH.publicPem })).toEqual({ ok: true });
  });

  it('distinguishes a positive receipt from a negative one', () => {
    const good = parse(buildReceipt({ subscriber, keys, transactionId: 'TX1', positive: true }));
    const bad = parse(buildReceipt({ subscriber, keys, transactionId: 'TX1', positive: false }));
    expect(textOf(at(good, EBICS_NS, 'body', 'TransferReceipt', 'ReceiptCode'))).toBe('0');
    expect(textOf(at(bad, EBICS_NS, 'body', 'TransferReceipt', 'ReceiptCode'))).toBe('1');
  });
});

describe('the AuthSignature, as an attacker would test it', () => {
  const root = parse(buildHpb({ subscriber, keys, timestamp: TIMESTAMP }));

  it('covers exactly the nodes marked authenticate="true"', () => {
    const reference = findAll(root, (n) => n.local === 'Reference')[0]!;
    expect(attrOf(reference, 'URI')).toBe(AUTHENTICATE_URI);
    expect(authenticatedBytes(root)).toContain('authenticate="true"');
  });

  it('fails when an authenticated node is altered', () => {
    const tampered = parse(buildHpb({ subscriber, keys, timestamp: TIMESTAMP }));
    const host = at(tampered, EBICS_NS, 'header', 'static', 'HostID')!;
    host.children = [{ kind: 'text', value: 'OTHERHOST' }];
    const result = verifyAuthSignature({ root: tampered, bankAuthPublicPem: AUTH.publicPem });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/digest does not match/);
  });

  it('fails against the wrong public key', () => {
    expect(verifyAuthSignature({ root, bankAuthPublicPem: BANK_AUTH.publicPem }).ok).toBe(false);
  });

  it('refuses a signature whose Reference points somewhere else', () => {
    // The signature-wrapping shape: a perfectly valid signature over a
    // different, harmless fragment. Checking the URI is what catches it.
    const wrapped = parse(buildHpb({ subscriber, keys, timestamp: TIMESTAMP }));
    const reference = findAll(wrapped, (n) => n.local === 'Reference')[0]!;
    reference.attrs = reference.attrs.map((a) => (a.local === 'URI' ? { ...a, value: '#something-else' } : a));
    const result = verifyAuthSignature({ root: wrapped, bankAuthPublicPem: AUTH.publicPem });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not cover the authenticated nodes/);
  });

  it('refuses a downgraded algorithm', () => {
    const downgraded = parse(buildHpb({ subscriber, keys, timestamp: TIMESTAMP }));
    const method = findAll(downgraded, (n) => n.local === 'SignatureMethod')[0]!;
    method.attrs = method.attrs.map((a) =>
      a.local === 'Algorithm' ? { ...a, value: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1' } : a,
    );
    expect(verifyAuthSignature({ root: downgraded, bankAuthPublicPem: AUTH.publicPem }).reason).toMatch(
      /not rsa-sha256/,
    );
  });

  it('refuses a document with no signature at all', () => {
    const bare = parse('<e:ebicsRequest xmlns:e="urn:org:ebics:H005"><e:header authenticate="true"/></e:ebicsRequest>');
    expect(verifyAuthSignature({ root: bare, bankAuthPublicPem: AUTH.publicPem }).reason).toMatch(
      /no AuthSignature/,
    );
  });
});

describe('namespaces', () => {
  it('writes EBICS and XML-DSig in their own namespaces', () => {
    expect(NS.e).toBe('urn:org:ebics:H005');
    const root = parse(buildHpb({ subscriber, keys, timestamp: TIMESTAMP }));
    expect(root.uri).toBe(EBICS_NS);
    expect(findAll(root, (n) => n.local === 'SignedInfo')[0]!.uri).toBe('http://www.w3.org/2000/09/xmldsig#');
  });
});
