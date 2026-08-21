import { describe, expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { certificateDer, certificateFromBase64, publicPemFromCertificate, selfSignedCertificate } from '../server/ebics/x509.js';
import { derOid, derTime, derInteger } from '../server/ebics/der.js';
import { ES, AUTH, ENC } from './fixtures/keys.js';

/**
 * The certificate builder, checked against a parser we did not write.
 *
 * DER fails silently — a length byte wrong by one produces a structure that
 * parses as something else rather than an error — so almost every assertion
 * here runs the output back through `node:crypto`'s own X.509 parser. If this
 * module and that parser disagree, the parser is right.
 *
 * These certificates exist because EBICS 3.0 has no other way to carry a
 * public key: `PubKeyValue` does not appear anywhere in the H005 schema set.
 */

const issue = (privatePem: string, purpose: 'ES' | 'AUTH' | 'ENC') =>
  selfSignedCertificate({
    privatePem,
    purpose,
    subject: { commonName: 'USER1', organizationName: '0815software GmbH', countryName: 'AT' },
    notBefore: new Date('2026-08-21T00:00:00Z'),
    notAfter: new Date('2036-08-18T00:00:00Z'),
    serial: Buffer.from([0x01, 0x02, 0x03, 0x04]),
  });

describe('a self-signed subscriber certificate', () => {
  const pem = issue(ES.privatePem, 'ES');
  const cert = new X509Certificate(pem);

  it('parses, and carries the subject it was given', () => {
    expect(cert.subject).toContain('CN=USER1');
    expect(cert.subject).toContain('O=0815software GmbH');
    expect(cert.subject).toContain('C=AT');
    // Self-signed: issuer and subject are the same name.
    expect(cert.issuer).toBe(cert.subject);
  });

  it('verifies against its own key', () => {
    expect(cert.verify(cert.publicKey)).toBe(true);
  });

  it('holds exactly the key it was asked to certify', () => {
    // The seam the rest of the service depends on: everything downstream still
    // works on a public key PEM, as it did when keys arrived as two integers.
    expect(publicPemFromCertificate(pem).trim()).toBe(ES.publicPem.trim());
  });

  it('carries the validity it was given, to the second', () => {
    expect(new Date(cert.validFrom).toISOString()).toBe('2026-08-21T00:00:00.000Z');
    expect(new Date(cert.validTo).toISOString()).toBe('2036-08-18T00:00:00.000Z');
  });

  it('is not a CA — a subscriber must not be able to sign other certificates', () => {
    expect(cert.ca).toBe(false);
  });

  it('is reproducible: same inputs, same bytes', () => {
    expect(issue(ES.privatePem, 'ES')).toBe(pem);
  });

  it('round-trips through base64, as it does on the wire', () => {
    const base64 = certificateDer(pem).toString('base64');
    expect(publicPemFromCertificate(certificateFromBase64(base64)).trim()).toBe(ES.publicPem.trim());
  });
});

describe('key usage says what the key is for', () => {
  /**
   * The three keys are not interchangeable, and the certificate has to say so.
   *
   * Asserted on the DER bytes because `node:crypto` does not expose keyUsage:
   * `04 04 03 02 <unused> <bits>` is the OCTET STRING wrapping a BIT STRING,
   * and the unused-bit count differs per purpose because DER drops trailing
   * zero bits.
   */
  it.each([
    ['ES — digitalSignature + nonRepudiation, because it authorises payments', ES.privatePem, 'ES', '040403020" 6c0'],
    ['AUTH — digitalSignature only; it proves who is talking, nothing more', AUTH.privatePem, 'AUTH', '0404030207 80'],
    ['ENC — keyEncipherment only; it never signs', ENC.privatePem, 'ENC', '0404030205 20'],
  ] as const)('%s', (_name, key, purpose, expectedHex) => {
    const der = certificateDer(issue(key, purpose)).toString('hex');
    // The keyUsage extension: OID 2.5.29.15, critical, then the bits.
    expect(der).toContain('0603551d0f0101ff');
    expect(der).toContain(expectedHex.replace(/[" ]/g, ''));
  });

  it('marks both extensions critical', () => {
    // basicConstraints CA:FALSE and keyUsage both matter enough that a parser
    // which cannot read them should refuse the certificate.
    const der = certificateDer(issue(ES.privatePem, 'ES')).toString('hex');
    expect(der).toContain('0603551d130101ff'); // basicConstraints, critical
    expect(der).toContain('0603551d0f0101ff'); // keyUsage, critical
  });
});

describe('the DER primitives', () => {
  it('encodes object identifiers the way the standard does', () => {
    // rsaEncryption, the one every RSA key carries — a known-good vector.
    expect(derOid('1.2.840.113549.1.1.1').toString('hex')).toBe('06092a864886f70d010101');
    // sha256WithRSAEncryption.
    expect(derOid('1.2.840.113549.1.1.11').toString('hex')).toBe('06092a864886f70d01010b');
    // commonName, which uses the short two-arc form.
    expect(derOid('2.5.4.3').toString('hex')).toBe('0603550403');
  });

  it('uses UTCTime below 2050 and GeneralizedTime from 2050', () => {
    // RFC 5280 requires exactly this split; the wrong one is rejected with a
    // message about the date rather than about the encoding.
    expect(derTime(new Date('2026-08-21T10:00:00Z')).toString('hex').slice(0, 2)).toBe('17');
    expect(derTime(new Date('2051-08-21T10:00:00Z')).toString('hex').slice(0, 2)).toBe('18');
    expect(derTime(new Date('2026-08-21T10:00:00Z')).subarray(2).toString('ascii')).toBe('260821100000Z');
    expect(derTime(new Date('2051-08-21T10:00:00Z')).subarray(2).toString('ascii')).toBe('20510821100000Z');
  });

  it('pads an integer whose top bit is set, so it is not read as negative', () => {
    expect(derInteger(Buffer.from([0x80])).toString('hex')).toBe('02020080');
    expect(derInteger(Buffer.from([0x7f])).toString('hex')).toBe('02017f');
  });

  it('strips redundant leading zeros — DER integers must be minimal', () => {
    // This one failed about one run in three before it was fixed, and only
    // sometimes: the certificate serial is 16 random bytes, and roughly 1 in
    // 256 of those starts with 0x00. OpenSSL rejects the result outright
    // ("illegal padding"), so the certificate could not be re-parsed — an
    // encoder that is wrong intermittently is the worst kind.
    expect(derInteger(Buffer.from([0x00, 0x01])).toString('hex')).toBe('020101');
    expect(derInteger(Buffer.from([0x00, 0x00, 0x00, 0x2a])).toString('hex')).toBe('02012a');
    // But the zero that keeps a value positive stays.
    expect(derInteger(Buffer.from([0x00, 0x80])).toString('hex')).toBe('02020080');
    expect(derInteger(Buffer.from([0x00])).toString('hex')).toBe('020100');
    expect(derInteger(Buffer.alloc(0)).toString('hex')).toBe('020100');
  });

  it('issues a parseable certificate for EVERY serial, including awkward ones', () => {
    for (const serial of [
      Buffer.from([0x00, 0x11, 0x22]), // leading zero — the regression
      Buffer.from([0xff, 0xee]), // top bit set, needs padding
      Buffer.from([0x00]), // zero
      Buffer.alloc(16, 0x00), // all zeros
    ]) {
      const pem = selfSignedCertificate({
        privatePem: ES.privatePem,
        purpose: 'ES',
        subject: { commonName: 'USER1' },
        notBefore: new Date('2026-01-01T00:00:00Z'),
        notAfter: new Date('2036-01-01T00:00:00Z'),
        serial,
      });
      expect(() => new X509Certificate(pem)).not.toThrow();
    }
  });
});
