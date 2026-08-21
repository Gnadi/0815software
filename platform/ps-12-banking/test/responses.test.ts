import { describe, expect, it } from 'vitest';
import { document, el, parse, type XmlElement } from '../server/ebics/xml.js';
import { buildAuthSignature } from '../server/ebics/dsig.js';
import { EBICS_NS, HEV_NS, NS } from '../server/ebics/envelopes.js';
import { allReturnCodes, parseHev, parseHpbOrderData, parseResponse, ResponseError, spkiPemFromParts } from '../server/ebics/parse.js';
import { codeInfo, EBICS_OK, verdictOf } from '../server/ebics/codes.js';
import { publicKeyDigest, publicKeyParts } from '../server/ebics/crypto.js';
import { BANK_AUTH, BANK_ENC } from './fixtures/keys.js';

/**
 * The response side: what the bank said, and whether to believe it.
 *
 * The responses here are built and signed with the bank's fixture key, so the
 * verification path is exercised against genuinely signed documents rather than
 * against a stub that always says yes.
 */

interface ResponseParts {
  technical?: string;
  business?: string;
  reportText?: string;
  transactionId?: string;
  numSegments?: number;
  segmentNumber?: { n: number; last: boolean };
  orderData?: string;
  transactionKey?: string;
  sign?: boolean;
}

/** A response as the bank would send it — signed with the bank's X002 key. */
function bankResponse(parts: ResponseParts = {}): string {
  const {
    technical = EBICS_OK,
    business = EBICS_OK,
    reportText = '[EBICS_OK] OK',
    sign = true,
  } = parts;

  const root = el('e:ebicsResponse', { Version: 'H005', Revision: '1' }, [
    el('e:header', { authenticate: 'true' }, [
      el('e:static', {}, [
        parts.transactionId !== undefined ? el('e:TransactionID', {}, [parts.transactionId]) : null,
        parts.numSegments !== undefined ? el('e:NumSegments', {}, [String(parts.numSegments)]) : null,
      ]),
      el('e:mutable', {}, [
        parts.segmentNumber !== undefined
          ? el(
              'e:SegmentNumber',
              parts.segmentNumber.last ? { lastSegment: 'true' } : {},
              [String(parts.segmentNumber.n)],
            )
          : null,
        el('e:ReturnCode', {}, [technical]),
        el('e:ReportText', {}, [reportText]),
      ]),
    ]),
    el('e:body', {}, [
      parts.orderData !== undefined || parts.transactionKey !== undefined
        ? el('e:DataTransfer', {}, [
            parts.transactionKey !== undefined
              ? el('e:DataEncryptionInfo', {}, [el('e:TransactionKey', {}, [parts.transactionKey])])
              : null,
            parts.orderData !== undefined ? el('e:OrderData', {}, [parts.orderData]) : null,
          ])
        : null,
      el('e:ReturnCode', {}, [business]),
    ]),
  ]);

  if (sign) {
    const signature = buildAuthSignature({ root, ns: NS, authPrivatePem: BANK_AUTH.privatePem });
    root.children.splice(1, 0, signature);
  }
  return document(root, NS);
}

describe('return codes — a response carries two, and both decide', () => {
  it('is OK only when both codes are', () => {
    expect(verdictOf(EBICS_OK, EBICS_OK).ok).toBe(true);
    expect(verdictOf(EBICS_OK, EBICS_OK).message).toBe('OK');
  });

  it('reports a BUSINESS rejection even though the transport succeeded', () => {
    // The mistake this guards: reading only the header, seeing 000000, and
    // recording a refused payment as sent.
    const verdict = verdictOf(EBICS_OK, '091303', 'order refused');
    expect(verdict.ok).toBe(false);
    expect(verdict.severity).toBe('rejected');
    expect(verdict.message).toContain('091303');
    expect(verdict.message).toContain('order refused');
  });

  it('reports a technical fault ahead of whatever the body says', () => {
    const verdict = verdictOf('061002', '091303');
    expect(verdict.ok).toBe(false);
    expect(verdict.technical.code).toBe('061002');
    expect(verdict.message).toContain('technical');
  });

  it('classifies unknown codes by their range rather than inventing a meaning', () => {
    expect(codeInfo('061999').severity).toBe('retryable'); // technical: may recur or not
    expect(codeInfo('091999').severity).toBe('rejected'); // business: the bank said no
    expect(codeInfo('011000').severity).toBe('pending');
    expect(codeInfo('999999').severity).toBe('rejected'); // nothing known: refuse
    expect(codeInfo('091999').known).toBe(false);
  });

  it('passes the bank’s own words through for a code it does not name', () => {
    expect(codeInfo('091999', 'Konto nicht gedeckt').meaning).toContain('Konto nicht gedeckt');
  });

  it('treats a retryable technical fault as retryable, and says so', () => {
    expect(verdictOf('061101', EBICS_OK).severity).toBe('retryable');
  });
});

describe('parsing a response', () => {
  it('reads both codes, the transaction id and the segment counts', () => {
    const response = parseResponse(
      bankResponse({ transactionId: 'TX-7', numSegments: 3, segmentNumber: { n: 2, last: false } }),
      BANK_AUTH.publicPem,
    );
    expect(response.verdict.ok).toBe(true);
    expect(response.transactionId).toBe('TX-7');
    expect(response.segments).toBe(3);
    expect(response.segmentNumber).toBe(2);
    expect(response.lastSegment).toBe(false);
  });

  it('sees the last-segment marker', () => {
    const response = parseResponse(bankResponse({ segmentNumber: { n: 3, last: true } }), BANK_AUTH.publicPem);
    expect(response.lastSegment).toBe(true);
  });

  it('verifies the signature against the bank key, and rejects the wrong key', () => {
    const xml = bankResponse();
    expect(parseResponse(xml, BANK_AUTH.publicPem).verified).toBe(true);
    const wrong = parseResponse(xml, BANK_ENC.publicPem);
    expect(wrong.verified).toBe(false);
    expect(wrong.verificationError).toBeDefined();
  });

  it('reports an unsigned response as unverified rather than failing open', () => {
    const response = parseResponse(bankResponse({ sign: false }), BANK_AUTH.publicPem);
    expect(response.verified).toBe(false);
    expect(response.verificationError).toMatch(/no AuthSignature/);
  });

  it('leaves `verified` false when no key was supplied — as during HPB', () => {
    const response = parseResponse(bankResponse());
    expect(response.verified).toBe(false);
    expect(response.verificationError).toBeUndefined();
    expect(response.verdict.ok).toBe(true);
  });

  it('carries the download payload through untouched', () => {
    const response = parseResponse(
      bankResponse({ orderData: 'QUJD\nREVG', transactionKey: 'S0VZ' }),
      BANK_AUTH.publicPem,
    );
    // Whitespace a bank inserts for line wrapping is not part of the base64.
    expect(response.orderData).toBe('QUJDREVG');
    expect(response.transactionKey).toBe('S0VZ');
  });

  it('refuses anything that is not an EBICS response', () => {
    expect(() => parseResponse('<html><body>502 Bad Gateway</body></html>')).toThrow(ResponseError);
    expect(() => parseResponse('not xml at all')).toThrow(/not usable XML/);
    expect(() => parseResponse('<Other xmlns="urn:elsewhere"/>')).toThrow(/unexpected response namespace/);
  });

  it('refuses a response with no technical return code at all', () => {
    const headerless = document(
      el('e:ebicsResponse', {}, [el('e:header', {}, [el('e:mutable', {})]), el('e:body', {})]),
      NS,
    );
    expect(() => parseResponse(headerless)).toThrow(/no technical return code/);
  });

  it('lists every ReturnCode in the body, for logging a rejection in full', () => {
    const root: XmlElement = parse(bankResponse({ business: '091303' }));
    expect(allReturnCodes(root)).toEqual(['091303']);
  });
});

describe('HEV — the version probe', () => {
  it('reads the versions a bank advertises', () => {
    const xml = document(
      el('h:HEVResponse', {}, [
        el('h:HostID', {}, ['EBIXHOST']),
        el('h:VersionNumber', { ProtocolVersion: 'H004' }, ['02.50']),
        el('h:VersionNumber', { ProtocolVersion: 'H005' }, ['03.00']),
      ]),
      { h: HEV_NS },
    );
    expect(parseHev(xml)).toEqual({
      hostId: 'EBIXHOST',
      versions: [
        { protocol: 'H004', revision: '02.50' },
        { protocol: 'H005', revision: '03.00' },
      ],
    });
  });
});

describe('HPB — the bank’s keys, and the digests a human must confirm', () => {
  /** The order data an HPB response delivers, once decrypted. */
  function hpbOrderData(): string {
    const keyInfo = (container: string, versionEl: string, version: string, pem: string): XmlElement => {
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
    };
    return document(
      el('e:HPBResponseOrderData', {}, [
        keyInfo('AuthenticationPubKeyInfo', 'AuthenticationVersion', 'X002', BANK_AUTH.publicPem),
        keyInfo('EncryptionPubKeyInfo', 'EncryptionVersion', 'E002', BANK_ENC.publicPem),
      ]),
      NS,
    );
  }

  it('rebuilds usable PEMs from the modulus and exponent the bank sent', () => {
    const result = parseHpbOrderData(hpbOrderData());
    expect(result.authentication.version).toBe('X002');
    expect(result.encryption.version).toBe('E002');
    // Rebuilt by hand from DER, and identical to what node:crypto exports.
    expect(result.authentication.pem.replace(/\s/g, '')).toBe(BANK_AUTH.publicPem.replace(/\s/g, ''));
    expect(result.encryption.pem.replace(/\s/g, '')).toBe(BANK_ENC.publicPem.replace(/\s/g, ''));
  });

  it('computes the digests an operator compares against the bank’s letter', () => {
    const result = parseHpbOrderData(hpbOrderData());
    expect(result.authentication.digest.equals(publicKeyDigest(BANK_AUTH.publicPem))).toBe(true);
    expect(result.encryption.digest.equals(publicKeyDigest(BANK_ENC.publicPem))).toBe(true);
    // A substituted key changes the digest — which is the entire point of the
    // out-of-band comparison this value exists for.
    expect(result.authentication.digest.equals(publicKeyDigest(BANK_ENC.publicPem))).toBe(false);
  });

  it('refuses order data that is missing a key', () => {
    const incomplete = document(el('e:HPBResponseOrderData', {}, [el('e:EncryptionPubKeyInfo', {})]), NS);
    expect(() => parseHpbOrderData(incomplete)).toThrow(/no AuthenticationPubKeyInfo/);
  });

  it('rebuilds a key whose modulus starts with a high byte (the DER sign trap)', () => {
    // A modulus with a leading byte >= 0x80 needs a zero pad in DER, or it is
    // read as a negative integer and the key silently becomes a different one.
    const { modulus, exponent } = publicKeyParts(BANK_AUTH.publicPem);
    expect(modulus[0]).toBeGreaterThanOrEqual(0x80);
    expect(spkiPemFromParts(modulus, exponent).replace(/\s/g, '')).toBe(BANK_AUTH.publicPem.replace(/\s/g, ''));
  });
});
