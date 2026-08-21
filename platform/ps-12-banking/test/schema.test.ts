import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import {
  buildHev,
  buildIni,
  buildHia,
  buildHpb,
  buildUploadInit,
  buildSpr,
  buildVeuOverview,
  buildVeuDetail,
  buildVeuTransactions,
  buildVeuSignature,
  buildVeuCancel,
  buildTransfer,
  buildReceipt,
  buildDownloadInit,
  buildDownloadSegment,
  EBICS_NS,
  type Subscriber,
} from '../server/ebics/envelopes.js';
import { unpackOrderData } from '../server/ebics/crypto.js';
import { at, parse, textOf } from '../server/ebics/xml.js';
import { AUTH, BANK_AUTH, BANK_ENC, ENC, ES } from './fixtures/keys.js';
import { selfSignedCertificate } from '../server/ebics/x509.js';

/**
 * Validation against the OFFICIAL EBICS 3.0 schemas.
 *
 * This is the only test in the package whose expected answer does not come
 * from this repository. Everything else — including the mock bank — encodes
 * one reading of the specification, so it can confirm that the client and the
 * counterparty agree and cannot tell whether they are both wrong. They were:
 * a double-hashed payment signature, an `AuthSignature` in the xmldsig
 * namespace instead of the EBICS one, a `UserSignatureData` whose shape was
 * invented, and a key representation H005 does not define. All of it green.
 *
 * Two things this suite does that validating the request alone would not:
 *
 * 1. **It validates the PAYLOADS.** Order data travels deflated and base64'd
 *    inside `OrderData`, so a schema check on the envelope says nothing about
 *    what is in it. Three of the four errors above were in there.
 * 2. **It covers every builder**, so a new message cannot be added without
 *    the schema seeing it.
 */

const SCHEMA_DIR = new URL('./schema/', import.meta.url).pathname;
const HAVE_SCHEMAS = existsSync(join(SCHEMA_DIR, 'ebics_request_H005.xsd'));
let HAVE_XMLLINT = false;
try {
  execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
  HAVE_XMLLINT = true;
} catch {
  HAVE_XMLLINT = false;
}

const workdir = mkdtempSync(join(tmpdir(), 'ebics-schema-'));

/**
 * Validate one document, returning xmllint's complaint or null.
 *
 * Shelling out rather than parsing XSD ourselves is the point: a validator we
 * wrote would share our misreadings, which is the whole failure mode this
 * suite exists to break.
 */
function validate(xml: string, schema: string): string | null {
  const file = join(workdir, `${Math.random().toString(36).slice(2)}.xml`);
  writeFileSync(file, xml);
  try {
    execFileSync('xmllint', ['--noout', '--schema', join(SCHEMA_DIR, schema), file], { stdio: 'pipe' });
    return null;
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? String(err);
    return stderr
      .split('\n')
      .filter((line) => line.includes('Schemas validity'))
      .map((line) => line.replace(/^.*Schemas validity error : /, ''))
      .join('; ');
  }
}

const subscriber = { hostId: 'EBIXHOST', partnerId: 'PARTNER1', userId: 'USER1' };

/**
 * The same subscriber, naming its client software.
 *
 * `Product` is optional in H005 and sits in exactly one legal place — after
 * `UserID`/`SystemID`, before `OrderDetails` — in both request families. A
 * mock bank that reads elements by name would accept it anywhere, so the
 * schema is the only thing that can catch a misplacement. Hence: every message
 * is validated twice, once with the element and once without.
 */
const withProduct = {
  ...subscriber,
  product: { name: '0815software PS-12', language: 'de', instituteId: 'INST0815' },
};
const keys = {
  esPrivatePem: ES.privatePem,
  esVersion: 'A005' as const,
  authPrivatePem: AUTH.privatePem,
  encPrivatePem: ENC.privatePem,
};
const bank = { authPublicPem: BANK_AUTH.publicPem, encPublicPem: BANK_ENC.publicPem };
const btf = {
  serviceName: 'SCT',
  msgName: 'pain.001',
  msgVersion: '03',
  msgVariant: '001',
};
const TIMESTAMP = '2026-08-21T10:00:00Z';

/** Certificates over the fixture keys — fixed dates, so output is stable. */
const certify = (privatePem: string, purpose: 'ES' | 'AUTH' | 'ENC'): string =>
  selfSignedCertificate({
    privatePem,
    purpose,
    subject: { commonName: 'USER1', organizationName: 'PARTNER1' },
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: new Date('2036-01-01T00:00:00Z'),
    serial: Buffer.from([0x01]),
  });
const CERT = { es: certify(ES.privatePem, 'ES'), auth: certify(AUTH.privatePem, 'AUTH'), enc: certify(ENC.privatePem, 'ENC') };
const TX_ID = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
const transactionKey = Buffer.alloc(16, 7);
const DATA_DIGEST = 'yeee4C+0xZjU0Ex6aQt+Zm7FCo61GQtftMTqmYcSffc=';
const VEU_ORDER = { partnerId: 'PARTNER1', btf: { serviceName: 'SCT', scope: 'AT', msgName: 'pain.001' }, orderId: 'A1B2' };
const orderData = Buffer.from('<?xml version="1.0"?><Document xmlns="urn:x"/>', 'utf8');

/** Every message this service can put on the wire, and its schema. */
function everyMessage(subscriber: Subscriber): { name: string; xml: string; schema: string }[] {
  return [
    { name: 'HEV', xml: buildHev(subscriber.hostId), schema: 'ebics_hev.xsd' },
    {
      name: 'INI',
      xml: buildIni({ subscriber, esCertificatePem: CERT.es, esVersion: 'A005', timestamp: TIMESTAMP }),
      schema: 'ebics_keymgmt_request_H005.xsd',
    },
    {
      name: 'HIA',
      xml: buildHia({ subscriber, authCertificatePem: CERT.auth, encCertificatePem: CERT.enc, timestamp: TIMESTAMP }),
      schema: 'ebics_keymgmt_request_H005.xsd',
    },
    { name: 'HPB', xml: buildHpb({ subscriber, keys, timestamp: TIMESTAMP }), schema: 'ebics_keymgmt_request_H005.xsd' },
    {
      name: 'BTU initialisation',
      xml: buildUploadInit({ subscriber, keys, bank, btf, orderData, transactionKey, timestamp: TIMESTAMP, segments: 1 }),
      schema: 'ebics_request_H005.xsd',
    },
    {
      name: 'BTU initialisation asking for distributed signature',
      xml: buildUploadInit({
        subscriber,
        keys,
        bank,
        btf,
        orderData,
        transactionKey,
        timestamp: TIMESTAMP,
        segments: 1,
        requestEDS: true,
      }),
      schema: 'ebics_request_H005.xsd',
    },
    {
      name: 'SPR subscriber lock',
      xml: buildSpr({ subscriber, keys, bank, transactionKey, timestamp: TIMESTAMP }),
      schema: 'ebics_request_H005.xsd',
    },
    {
      name: 'BTU transfer',
      xml: buildTransfer({ subscriber, keys, transactionId: TX_ID, segmentNumber: 1, lastSegment: true, segment: 'AAAA' }),
      schema: 'ebics_request_H005.xsd',
    },
    {
      name: 'BTD initialisation',
      xml: buildDownloadInit({
        subscriber,
        keys,
        bank,
        btf: { serviceName: 'EOP', scope: 'DE', msgName: 'camt.053', container: 'ZIP' },
        timestamp: TIMESTAMP,
      }),
      schema: 'ebics_request_H005.xsd',
    },
    {
      name: 'BTD initialisation with a date range',
      xml: buildDownloadInit({
        subscriber,
        keys,
        bank,
        btf: { serviceName: 'EOP', scope: 'DE', msgName: 'camt.053', container: 'ZIP' },
        timestamp: TIMESTAMP,
        dateRange: { from: '2026-08-01', to: '2026-08-21' },
      }),
      schema: 'ebics_request_H005.xsd',
    },
    {
      name: 'HVU overview',
      xml: buildVeuOverview({ subscriber, keys, bank, timestamp: TIMESTAMP, orderType: 'HVU' }),
      schema: 'ebics_request_H005.xsd',
    },
    {
      name: 'HVZ overview filtered by service',
      xml: buildVeuOverview({
        subscriber,
        keys,
        bank,
        timestamp: TIMESTAMP,
        orderType: 'HVZ',
        serviceFilter: [btf, { serviceName: 'SDD', scope: 'AT', option: 'COR', msgName: 'pain.008' }],
      }),
      schema: 'ebics_request_H005.xsd',
    },
    {
      name: 'HVD order detail',
      xml: buildVeuDetail({ subscriber, keys, bank, timestamp: TIMESTAMP, order: VEU_ORDER }),
      schema: 'ebics_request_H005.xsd',
    },
    {
      name: 'HVT transaction detail',
      xml: buildVeuTransactions({
        subscriber,
        keys,
        bank,
        timestamp: TIMESTAMP,
        order: VEU_ORDER,
        completeOrderData: false,
        fetchLimit: 50,
        fetchOffset: 10,
      }),
      schema: 'ebics_request_H005.xsd',
    },
    {
      name: 'HVE co-signature',
      xml: buildVeuSignature({
        subscriber,
        keys,
        bank,
        timestamp: TIMESTAMP,
        transactionKey,
        order: VEU_ORDER,
        dataDigest: DATA_DIGEST,
      }).init,
      schema: 'ebics_request_H005.xsd',
    },
    {
      name: 'HVS cancellation',
      xml: buildVeuCancel({
        subscriber,
        keys,
        bank,
        timestamp: TIMESTAMP,
        transactionKey,
        order: VEU_ORDER,
        dataDigest: DATA_DIGEST,
      }).init,
      schema: 'ebics_request_H005.xsd',
    },
    {
      name: 'BTD segment request',
      xml: buildDownloadSegment({ subscriber, keys, transactionId: TX_ID, segmentNumber: 2 }),
      schema: 'ebics_request_H005.xsd',
    },
    {
      name: 'receipt',
      xml: buildReceipt({ subscriber, keys, transactionId: TX_ID, positive: true }),
      schema: 'ebics_request_H005.xsd',
    },
  ];
}

/**
 * The deflated, base64'd documents inside `OrderData` and `SignatureData`.
 *
 * Invisible to a check on the envelope, and where the worst errors hid.
 */
function everyPayload(): { name: string; xml: string; schema: string }[] {
  const orderDataOf = (envelope: string): string => {
    const packed = textOf(at(parse(envelope), EBICS_NS, 'body', 'DataTransfer', 'OrderData')).replace(/\s+/g, '');
    return inflateSync(Buffer.from(packed, 'base64')).toString('utf8');
  };

  const upload = buildUploadInit({
    subscriber,
    keys,
    bank,
    btf,
    orderData,
    transactionKey,
    timestamp: TIMESTAMP,
    segments: 1,
  });
  const signatureData = textOf(at(parse(upload), EBICS_NS, 'body', 'DataTransfer', 'SignatureData')).replace(/\s+/g, '');

  return [
    {
      name: 'INI order data (SignaturePubKeyOrderData)',
      xml: orderDataOf(buildIni({ subscriber, esCertificatePem: CERT.es, esVersion: 'A005', timestamp: TIMESTAMP })),
      schema: 'ebics_signature_S002.xsd',
    },
    {
      name: 'HIA order data (HIARequestOrderData)',
      xml: orderDataOf(
        buildHia({ subscriber, authCertificatePem: CERT.auth, encCertificatePem: CERT.enc, timestamp: TIMESTAMP }),
      ),
      schema: 'ebics_orders_H005.xsd',
    },
    {
      name: 'the bank-technical signature (UserSignatureData)',
      xml: unpackOrderData(transactionKey, signatureData).toString('utf8'),
      schema: 'ebics_signature_S002.xsd',
    },
  ];
}

const describeIf = HAVE_SCHEMAS && HAVE_XMLLINT ? describe : describe.skip;

if (!HAVE_SCHEMAS) {
  // Deliberately loud rather than a silent skip: a validation suite that
  // quietly stops running is worse than one that was never written.
  console.warn(
    '[ps-12] schema.test.ts SKIPPED — no XSDs in test/schema/. ' +
      'Put the official EBICS 3.0 H005 schema set there to enable it (see test/schema/README.md).',
  );
} else if (!HAVE_XMLLINT) {
  console.warn('[ps-12] schema.test.ts SKIPPED — xmllint is not installed (apt-get install libxml2-utils).');
}

describeIf('every message validates against the published EBICS 3.0 schema', () => {
  it.each(everyMessage(subscriber).map((m) => [m.name, m] as const))('%s', (_name, message) => {
    expect(validate(message.xml, message.schema)).toBeNull();
  });
});

describeIf('every message still validates when it names the client product', () => {
  it.each(everyMessage(withProduct).map((m) => [m.name, m] as const))('%s', (_name, message) => {
    expect(validate(message.xml, message.schema)).toBeNull();
  });

  it('actually put the element in — everywhere the schema allows one', () => {
    // Otherwise the suite above would pass by validating the same messages
    // twice, which is the failure mode a parameterised test invites. Asserted
    // as a rule rather than a list of names: the list grew four entries the
    // day VEU arrived, and a list that has to be edited to stay true is a test
    // that will eventually be edited into agreeing with a bug.
    const carriers = everyMessage(withProduct).filter((m) => m.xml.includes('<e:Product '));
    const initialisations = everyMessage(withProduct).filter(
      (m) => m.xml.includes('<e:TransactionPhase>Initialisation</e:TransactionPhase>') || m.schema.includes('keymgmt'),
    );
    expect(carriers.map((m) => m.name).sort()).toEqual(initialisations.map((m) => m.name).sort());
    expect(carriers.length).toBeGreaterThan(6);
    expect(carriers[0]!.xml).toContain('<e:Product InstituteID="INST0815" Language="de">0815software PS-12</e:Product>');
  });

  it('leaves it out of the transfer and receipt phases, where the schema has no room for it', () => {
    // Not an oversight: those phases carry only HostID and TransactionID, so
    // emitting a Product there would be a message no bank would parse.
    const later = everyMessage(withProduct).filter((m) => /transfer|segment request|receipt/.test(m.name));
    expect(later).toHaveLength(3);
    for (const message of later) expect(message.xml).not.toContain('<e:Product');
  });
});

describeIf('every payload inside OrderData validates too', () => {
  it.each(everyPayload().map((p) => [p.name, p] as const))('%s', (_name, payload) => {
    expect(validate(payload.xml, payload.schema)).toBeNull();
  });
});

describe('the SignatureFlag says what the attached ES is for', () => {
  // The schema makes the element optional and its own documentation says what
  // leaving it out means: "the order doesn't contain any ES and shall be
  // authorised outside EBICS". Every upload here attaches a class-E signature
  // and means it, so the element is not optional in practice — and no schema
  // check can catch its absence, which is why these assert on the bytes.
  const initOf = (requestEDS?: boolean): string =>
    buildUploadInit({
      subscriber,
      keys,
      bank,
      btf,
      orderData,
      transactionKey,
      timestamp: TIMESTAMP,
      segments: 1,
      ...(requestEDS === undefined ? {} : { requestEDS }),
    });

  it('is present and bare by default — every signature must be in the order', () => {
    expect(initOf()).toContain('<e:SignatureFlag></e:SignatureFlag>');
    expect(initOf()).not.toContain('requestEDS');
  });

  it('carries requestEDS="true" when the account needs a second signatory', () => {
    expect(initOf(true)).toContain('<e:SignatureFlag requestEDS="true"></e:SignatureFlag>');
  });

  it('sits after the Service element, where the schema puts it', () => {
    // BTUParamsType is a sequence: Service, SignatureFlag, Parameter. Emitting
    // it first would be schema-invalid, which the suite above would catch —
    // this pins the reason so a future edit does not have to rediscover it.
    const xml = initOf();
    expect(xml.indexOf('<e:SignatureFlag')).toBeGreaterThan(xml.indexOf('<e:Service>'));
    expect(xml.indexOf('<e:SignatureFlag')).toBeGreaterThan(xml.indexOf('</e:MsgName>'));
  });

  it('appears on uploads only, never on a download', () => {
    // BTDParamsType has no SignatureFlag at all: there is nothing to authorise
    // in asking for a statement.
    const download = buildDownloadInit({
      subscriber,
      keys,
      bank,
      btf: { serviceName: 'EOP', scope: 'AT', msgName: 'camt.053', container: 'ZIP' },
      timestamp: TIMESTAMP,
    });
    expect(download).not.toContain('SignatureFlag');
  });
});

describeIf('the validator is actually validating', () => {
  it('rejects a document the schema forbids', () => {
    // Guards against the check silently passing everything — a validator that
    // never fails proves nothing, and this suite exists precisely because a
    // green suite proved nothing once already.
    const broken = buildReceipt({ subscriber, keys, transactionId: TX_ID, positive: true }).replace(
      '<e:TransactionPhase>Receipt</e:TransactionPhase>',
      '<e:TransactionPhase>Nonsense</e:TransactionPhase>',
    );
    expect(validate(broken, 'ebics_request_H005.xsd')).not.toBeNull();
  });
});
