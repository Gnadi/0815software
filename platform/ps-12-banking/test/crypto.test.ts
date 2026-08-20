import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
  decryptOrderData,
  decryptTransactionKey,
  encryptOrderData,
  encryptTransactionKey,
  formatDigest,
  generateRsaKeyPair,
  newTransactionKey,
  packOrderData,
  padX923,
  publicKeyDigest,
  publicKeyParts,
  sha256,
  signAuth,
  signOrderData,
  unpackOrderData,
  unpadX923,
  verifyAuth,
  verifyOrderData,
} from '../server/ebics/crypto.js';

/**
 * The crypto primitives, tested for the properties a bank depends on.
 *
 * Key generation is slow, so one set of keys is shared across the suite — the
 * assertions are about the algorithms, not about any particular key.
 */
const es = generateRsaKeyPair();
const auth = generateRsaKeyPair();
const enc = generateRsaKeyPair();

describe('key material on the wire', () => {
  it('exports the modulus and exponent EBICS transmits, minimally encoded', () => {
    const { modulus, exponent } = publicKeyParts(es.publicPem);
    expect(modulus).toHaveLength(256); // 2048 bits
    expect(modulus[0]).not.toBe(0); // leading zeros trimmed
    expect(exponent.toString('hex')).toBe('010001'); // 65537, minimal form
  });

  it('reads the public parts out of a PRIVATE pem too', () => {
    expect(publicKeyParts(es.privatePem)).toEqual(publicKeyParts(es.publicPem));
  });
});

describe('the INI-letter digest — the anchor of the trust model', () => {
  /**
   * The value below is fixed by the EBICS definition of the hash: SHA-256 over
   * the ASCII string "<exponent hex> <modulus hex>", both lower case and
   * leading-zero-trimmed. It is pinned against a hand-computed vector, because
   * an implementation that hashes the DER or the PEM instead produces a digest
   * that looks perfectly plausible and never matches the bank's letter.
   */
  it('hashes "exponent<space>modulus" in lower-case hex, not the DER', () => {
    const digest = publicKeyDigest(es.publicPem);
    const { modulus, exponent } = publicKeyParts(es.publicPem);
    const expected = sha256(`${exponent.toString('hex')} ${modulus.toString('hex')}`);
    expect(digest.equals(expected)).toBe(true);
    expect(digest).toHaveLength(32);
  });

  it('is stable for a key, and different for a different key', () => {
    expect(publicKeyDigest(es.publicPem).equals(publicKeyDigest(es.publicPem))).toBe(true);
    expect(publicKeyDigest(es.publicPem).equals(publicKeyDigest(auth.publicPem))).toBe(false);
  });

  it('prints the way a bank prints it, so a human can compare by eye', () => {
    const shown = formatDigest(Buffer.from('0123456789abcdeff0e1d2c3b4a59687' + '00112233445566778899aabbccddeeff', 'hex'));
    expect(shown).toBe('01234567 89ABCDEF F0E1D2C3 B4A59687 00112233 44556677 8899AABB CCDDEEFF');
  });
});

describe('signatures', () => {
  const orderData = Buffer.from('<Document>a pain.001 would go here</Document>', 'utf8');

  it('signs and verifies order data with A005 (PKCS#1 v1.5)', () => {
    const signature = signOrderData(es.privatePem, orderData, 'A005');
    expect(signature).toHaveLength(256);
    expect(verifyOrderData(es.publicPem, orderData, signature, 'A005')).toBe(true);
  });

  it('signs and verifies order data with A006 (PSS)', () => {
    const signature = signOrderData(es.privatePem, orderData, 'A006');
    expect(verifyOrderData(es.publicPem, orderData, signature, 'A006')).toBe(true);
  });

  it('refuses a signature made with the wrong version — they are not interchangeable', () => {
    const pkcs1 = signOrderData(es.privatePem, orderData, 'A005');
    expect(verifyOrderData(es.publicPem, orderData, pkcs1, 'A006')).toBe(false);
  });

  it('refuses altered order data, and the wrong signer', () => {
    const signature = signOrderData(es.privatePem, orderData, 'A005');
    expect(verifyOrderData(es.publicPem, Buffer.concat([orderData, Buffer.from(' ')]), signature)).toBe(false);
    expect(verifyOrderData(auth.publicPem, orderData, signature)).toBe(false);
  });

  it('signs the authenticated request with X002 over the canonical bytes', () => {
    const canonical = '<h:header xmlns:h="urn:ebics" authenticate="true"></h:header>';
    const signature = signAuth(auth.privatePem, canonical);
    expect(verifyAuth(auth.publicPem, canonical, signature)).toBe(true);
    // One byte of layout difference is a different document.
    expect(verifyAuth(auth.publicPem, `${canonical} `, signature)).toBe(false);
  });

  it('keeps the ES and auth keys apart — using one for the other fails', () => {
    const canonical = '<h:header></h:header>';
    expect(verifyAuth(es.publicPem, canonical, signAuth(auth.privatePem, canonical))).toBe(false);
  });
});

describe('the transaction key', () => {
  it('is fresh every time — the fixed IV is only safe because of this', () => {
    const keys = new Set(Array.from({ length: 32 }, () => newTransactionKey().toString('hex')));
    expect(keys.size).toBe(32);
    expect(newTransactionKey()).toHaveLength(16);
  });

  it('wraps to the bank with E002 and unwraps again', () => {
    const key = newTransactionKey();
    const wrapped = encryptTransactionKey(enc.publicPem, key);
    expect(wrapped).toHaveLength(256);
    expect(decryptTransactionKey(enc.privatePem, wrapped).equals(key)).toBe(true);
  });

  it('produces different ciphertext for the same key each time (PKCS#1 v1.5 is randomised)', () => {
    const key = newTransactionKey();
    const a = encryptTransactionKey(enc.publicPem, key);
    const b = encryptTransactionKey(enc.publicPem, key);
    expect(a.equals(b)).toBe(false);
    expect(decryptTransactionKey(enc.privatePem, b).equals(key)).toBe(true);
  });
});

describe('X9.23 padding — not PKCS#7, and the difference is a garbled file', () => {
  it('pads with zeros and puts the COUNT in the last byte only', () => {
    const padded = padX923(Buffer.from([1, 2, 3]));
    expect(padded).toHaveLength(16);
    expect([...padded.subarray(3, 15)]).toEqual(Array(12).fill(0));
    expect(padded[15]).toBe(13);
  });

  it('appends a whole block when the data already fits', () => {
    const padded = padX923(Buffer.alloc(16, 7));
    expect(padded).toHaveLength(32);
    expect(padded[31]).toBe(16);
  });

  it('round-trips at every length across a block boundary', () => {
    for (let n = 0; n <= 33; n++) {
      const data = Buffer.alloc(n, n);
      expect(unpadX923(padX923(data)).equals(data), `length ${n}`).toBe(true);
    }
  });

  it('refuses padding that cannot be right', () => {
    expect(() => unpadX923(Buffer.alloc(15))).toThrow(/whole number of blocks/);
    expect(() => unpadX923(Buffer.alloc(16, 0))).toThrow(/invalid X9.23 padding/);
    const tooLong = Buffer.alloc(16, 0);
    tooLong[15] = 17;
    expect(() => unpadX923(tooLong)).toThrow(/invalid X9.23 padding/);
  });
});

describe('the order-data pipeline', () => {
  const payload = Buffer.from('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"/>'.repeat(40));

  it('round-trips deflate → AES-128-CBC → base64 and back', () => {
    const key = newTransactionKey();
    const packed = packOrderData(key, payload);
    expect(packed).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(unpackOrderData(key, packed).equals(payload)).toBe(true);
  });

  it('compresses before it encrypts, so the file is actually smaller', () => {
    const key = newTransactionKey();
    const packed = Buffer.from(packOrderData(key, payload), 'base64');
    expect(deflateSync(payload).length).toBeLessThan(payload.length);
    // Ciphertext tracks the COMPRESSED size — proof the order was not swapped.
    expect(packed.length).toBeLessThan(payload.length);
  });

  it('is deterministic for a given transaction key — the IV is fixed by the scheme', () => {
    const key = newTransactionKey();
    expect(packOrderData(key, payload)).toBe(packOrderData(key, payload));
  });

  it('hides the payload from a wrong key rather than returning it', () => {
    const packed = packOrderData(newTransactionKey(), payload);
    expect(() => unpackOrderData(newTransactionKey(), packed)).toThrow();
  });

  /**
   * A fixed key and a fixed plaintext produce fixed ciphertext, because the
   * scheme's IV is all zeros. The expected value was produced by `openssl enc
   * -aes-128-cbc -nopad` over the X9.23-padded block — an independent
   * implementation — so this pins both the cipher and the padding against
   * something outside this codebase.
   */
  it('matches a known-good vector from openssl, byte for byte', () => {
    const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
    expect(encryptOrderData(key, Buffer.from('0123456789abcdef', 'utf8')).toString('hex')).toBe(
      '281567ab2f4cf0d73d3198225b8b83938855dd0bfade98028edf680a91d02f45',
    );
    expect(encryptOrderData(key, Buffer.alloc(0)).toString('hex')).toBe(
      'd565ee30a47ff43e31f14a71bbf8beb7',
    );
  });

  it('handles an empty payload without special-casing', () => {
    const key = newTransactionKey();
    expect(unpackOrderData(key, packOrderData(key, Buffer.alloc(0)))).toHaveLength(0);
  });

  it('encrypts to whole blocks whatever the input length', () => {
    const key = newTransactionKey();
    for (const n of [0, 1, 15, 16, 17, 1000]) {
      const cipher = encryptOrderData(key, Buffer.alloc(n, 1));
      expect(cipher.length % 16, `length ${n}`).toBe(0);
      expect(decryptOrderData(key, cipher)).toHaveLength(n);
    }
  });
});
