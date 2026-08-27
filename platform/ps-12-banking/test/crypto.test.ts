import { describe, expect, it } from 'vitest';
import { createSign } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { ES } from './fixtures/keys.js';
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
  signDigest,
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

  /**
   * THE GOLDEN VECTOR, and the reason it exists.
   *
   * `signOrderData` used to hash the order data and pass the DIGEST to a
   * signer that hashes what it is given — so the signature that authorises a
   * payment was over SHA-256(SHA-256(orderData)). Every test passed. The mock
   * bank verified through the mirror-image function and agreed with it, so the
   * suite could not have caught this no matter how many cases it had.
   *
   * The fix is not the assertion below; the fix is WHERE the expected value
   * comes from. This is `openssl dgst -sha256 -sign` — an implementation that
   * has never read this repository — so agreeing with it means agreeing with
   * the world rather than with ourselves.
   *
   *   openssl dgst -sha256 -sign es-priv.pem -out sig.bin orderdata.bin
   */
  it('produces the byte-exact signature openssl does', () => {
    // The COMMITTED fixture key, not the per-run one above: a golden vector
    // needs a key that does not change between runs.
    const payload = Buffer.from('<?xml version="1.0"?><Document>the payment file</Document>', 'utf8');
    const openssl =
      '8871df9e185b72ef36dfe38e25435e9c0442d8f423a3876ed7c67f899ce0ef3f082402b14978' +
      '54040f2fb660a95612f0ea16908472f0fb5469f59f93a99d5d09bdc5f74f0ca6d907134f282f' +
      '984fee06c52c17a562254dffc76efa11a70e0aed698ee79a47447a3fb2c6a5d4fe7a9295232e' +
      'b4da365d1936ff276235479783fb3419ced926c75019022cb9639a6079e59b8cbfa16fc4290f' +
      'bfb96548c48817636f09caca2535546025167a57f1451bdb2d07c25eaf1009a0a7edbfc06837' +
      'b7b7d4bb9770fd29d863b6e0afa317b8581bd5f36ecd50625fb4bc4c60497088cba08309a2b6' +
      '35e2852d031a22cae19536c555354c67ce4e084cf3c29a08db707dee';
    expect(signOrderData(ES.privatePem, payload, 'A005').toString('hex')).toBe(openssl);
    // And the other direction: we accept what openssl produced.
    expect(verifyOrderData(ES.publicPem, payload, Buffer.from(openssl, 'hex'), 'A005')).toBe(true);
  });

  /**
   * The second golden vector, for the one place a digest arrives from outside.
   *
   * A co-signatory approving an order in the bank's VEU queue signs the
   * `DataDigest` that `HVD` returned — they may not have the order data at
   * all. That is the exact shape of the double-hash bug above, so it gets the
   * same treatment: a value produced by an implementation that has never read
   * this repository.
   *
   *   openssl pkeyutl -sign -inkey es-priv.pem -in digest.bin -pkeyopt digest:sha256
   */
  it('signs a digest the way openssl does, and the way signOrderData does', () => {
    const preimage = Buffer.from('the collective order awaiting a second signature', 'utf8');
    const digest = sha256(preimage);
    const openssl =
      '1fd859d9fc3a3b5748555e9e83b39db500ab14722f3f762d6188b55c83b1adf4b6123a2d66fd' +
      '0d04b98f3c0150f092eceaa173a492958efd9f4eaf9ee34d94e131a255dac9ca573d546543d4' +
      'a226c5ebe7a5209c8814707b732e200148681b7749a443f78546a8fe59ed930eaa724599f248' +
      'b3b3b6800e1100fed9b42ec601da7af3276752d9dd98ab5665a658454c135695cc7254af5d20' +
      '3f5b1c67cd4c0ba3515d7def45a286b550d9ab2bf46de405ed232de0f7d41d187a8e7f235d47' +
      '6dab21889c12c3d9907ac40c364aeb92c196f1bf6685459af72b60550be31ea602337fb64204' +
      '98e044ba09b97fdce66d5bafc6aaec82e0d5ad143f72b6ef5a659c2c';
    expect(signDigest(ES.privatePem, digest, 'A005').toString('hex')).toBe(openssl);

    // And the invariant that makes the whole thing safe to reason about:
    // signing a digest produces the SAME bytes as signing its preimage. If
    // these two ever disagree, one of them is hashing an extra time.
    expect(signDigest(ES.privatePem, digest, 'A005').equals(signOrderData(ES.privatePem, preimage, 'A005'))).toBe(true);
    expect(verifyOrderData(ES.publicPem, preimage, signDigest(ES.privatePem, digest, 'A005'), 'A005')).toBe(true);
  });

  it('refuses to co-sign with A006 rather than approximating PSS', () => {
    // PSS encoding needs the hash function, not merely its output, and
    // node:crypto offers no way to supply one. Saying so beats emitting a
    // signature that is quietly not one.
    expect(() => signDigest(ES.privatePem, sha256(Buffer.from('x')), 'A006')).toThrow(/A006/);
  });

  it('refuses anything that is not a 32-byte SHA-256 digest', () => {
    // A caller passing base64 text, or a truncated hash, would otherwise get a
    // valid-looking signature over the wrong DigestInfo.
    expect(() => signDigest(ES.privatePem, Buffer.alloc(20), 'A005')).toThrow(/32-byte/);
  });

  it('signs the order data ONCE — not the digest of the digest', () => {
    // The regression, stated directly. `sign('sha256', x)` hashes x, so
    // handing it a digest signs SHA-256 of that digest. A bank refuses it and
    // the only symptom is every upload failing at a real connection.
    const doubleHashed = createSign('sha256').update(sha256(orderData)).sign(es.privatePem);
    expect(signOrderData(es.privatePem, orderData, 'A005').equals(doubleHashed)).toBe(false);
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
