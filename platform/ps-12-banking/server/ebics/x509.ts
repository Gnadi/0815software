import { X509Certificate, createPublicKey, createPrivateKey, sign } from 'node:crypto';
import {
  derBitString,
  derBoolean,
  derExplicit,
  derInteger,
  derNull,
  derOctetString,
  derOid,
  derPrintableString,
  derSequence,
  derSet,
  derUtf8String,
  derTime,
  pem,
} from './der.js';

/**
 * Self-signed X.509 certificates for the subscriber's three keys.
 *
 * ## Why this exists at all
 *
 * EBICS 3.0 does not carry raw public keys. `PubKeyValue` — the
 * exponent-and-modulus form that H004 used — **does not appear anywhere in the
 * H005 schema set**; `PubKeyInfoType` in both `ebics_types_H005.xsd` and
 * `ebics_signature_S002.xsd` requires `<ds:X509Data>`, and `H3KRequestOrderData`
 * is built from three `*CertificateInfo` elements. The German annotation still
 * says "exponent-modulus combination or X509 certificate", which is a leftover
 * from H004 that the schema no longer permits.
 *
 * `node:crypto` parses certificates and cannot issue them, so this module
 * issues them: ~200 lines of ASN.1 rather than a dependency, keeping the
 * `express` + `better-sqlite3` invariant every service in the catalogue holds.
 *
 * ## Self-signed, and why that is not a weakness here
 *
 * These certificates authenticate nothing by themselves — no CA vouches for
 * them and none needs to. What binds a key to a customer in EBICS is the same
 * thing it always was: the **INI letter**, printed with the key's digest,
 * signed by hand and posted. The certificate is a container the protocol
 * requires, not the trust anchor. A bank that insists on a CA-issued
 * certificate needs an operator-supplied one, which stays out of scope.
 *
 * ## Checked against a parser we did not write
 *
 * DER fails silently: a length byte wrong by one yields a structure that
 * parses as something else rather than an error. So every certificate this
 * builds is read back with `new X509Certificate(...)` in the tests, and its
 * subject, validity and public key must match what went in.
 */

const OID = {
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
  organizationName: '2.5.4.10',
  countryName: '2.5.4.6',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
} as const;

/** What the certificate is for, which decides its KeyUsage bits. */
export type CertificatePurpose = 'ES' | 'AUTH' | 'ENC';

/**
 * KeyUsage, as a DER BIT STRING with named bits.
 *
 * Bit 0 digitalSignature, 1 nonRepudiation, 2 keyEncipherment. DER requires
 * trailing zero bits to be dropped, which is why the unused-bit count differs
 * per purpose rather than being a constant.
 */
function keyUsageBits(purpose: CertificatePurpose): { byte: number; unused: number } {
  switch (purpose) {
    // The bank-technical signature is a non-repudiation signature: it is the
    // thing that authorises a payment.
    case 'ES':
      return { byte: 0b1100_0000, unused: 6 };
    case 'AUTH':
      return { byte: 0b1000_0000, unused: 7 };
    case 'ENC':
      return { byte: 0b0010_0000, unused: 5 };
  }
}

export interface SubjectName {
  /** Common name — conventionally the subscriber's user id. */
  commonName: string;
  organizationName?: string;
  /** Two-letter ISO country code. */
  countryName?: string;
}

function nameOf(subject: SubjectName): Buffer {
  const rdn = (oid: string, value: Buffer): Buffer => derSet([derSequence([derOid(oid), value])]);
  const parts = [rdn(OID.commonName, derUtf8String(subject.commonName))];
  if (subject.organizationName !== undefined) {
    parts.push(rdn(OID.organizationName, derUtf8String(subject.organizationName)));
  }
  // A country code is a PrintableString by convention, and some parsers are
  // strict about it.
  if (subject.countryName !== undefined) {
    parts.push(rdn(OID.countryName, derPrintableString(subject.countryName)));
  }
  return derSequence(parts);
}

export interface CertificateInput {
  /** The key to certify, and to sign with — self-signed means one key. */
  privatePem: string;
  purpose: CertificatePurpose;
  subject: SubjectName;
  /** Passed in, never read from the clock, so a certificate is reproducible. */
  notBefore: Date;
  notAfter: Date;
  /**
   * Serial number. Must be positive and unique per issuer; passed in for the
   * same reason as the dates.
   */
  serial: Buffer;
}

/** Issue a self-signed certificate. Returns PEM. */
export function selfSignedCertificate(input: CertificateInput): string {
  const publicKeyDer = createPublicKey(input.privatePem).export({ format: 'der', type: 'spki' });
  const algorithm = derSequence([derOid(OID.sha256WithRsa), derNull()]);
  const name = nameOf(input.subject);
  const usage = keyUsageBits(input.purpose);

  const extensions = derExplicit(
    3,
    derSequence([
      // CA:FALSE, marked critical — a subscriber certificate must not be
      // usable to sign other certificates.
      derSequence([
        derOid(OID.basicConstraints),
        derBoolean(true),
        derOctetString(derSequence([derBoolean(false)])),
      ]),
      derSequence([
        derOid(OID.keyUsage),
        derBoolean(true),
        derOctetString(derBitString(Buffer.from([usage.byte]), usage.unused)),
      ]),
    ]),
  );

  const tbs = derSequence([
    derExplicit(0, derInteger(Buffer.from([2]))), // v3
    derInteger(input.serial),
    algorithm,
    name, // issuer — the same as the subject, this being self-signed
    derSequence([derTime(input.notBefore), derTime(input.notAfter)]),
    name,
    publicKeyDer,
    extensions,
  ]);

  const signature = sign('sha256', tbs, createPrivateKey(input.privatePem));
  return pem('CERTIFICATE', derSequence([tbs, algorithm, derBitString(signature)]));
}

/** The DER bytes of a certificate, which is what `<ds:X509Certificate>` carries. */
export function certificateDer(certificatePem: string): Buffer {
  return new X509Certificate(certificatePem).raw;
}

/** Rebuild a certificate PEM from the base64 a bank sent. */
export function certificateFromBase64(base64: string): string {
  return pem('CERTIFICATE', Buffer.from(base64.replace(/\s+/g, ''), 'base64'));
}

/**
 * The public key inside a certificate, as a PEM.
 *
 * This is the seam that keeps the rest of the service unchanged: everything
 * downstream — digests, encryption, signature verification — still works on a
 * public key PEM, exactly as it did when keys arrived as modulus and exponent.
 */
export function publicPemFromCertificate(certificatePem: string): string {
  return new X509Certificate(certificatePem).publicKey.export({ format: 'pem', type: 'spki' }).toString();
}
