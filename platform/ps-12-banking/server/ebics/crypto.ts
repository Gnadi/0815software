import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/**
 * The EBICS crypto primitives — all of them, from Node built-ins.
 *
 * EBICS gives every subscriber three RSA key pairs, and confusing them is the
 * classic implementation bug, so they are distinct types here rather than three
 * uses of one "key":
 *
 * | Version | Purpose | What it does |
 * | ------- | ------- | ------------ |
 * | **A005/A006** | *electronic signature* (ES) | Signs the ORDER DATA. At signature class E this is the bank-technical signature: it is what authorises the payment, and it is the reason this service's key store is the most sensitive thing in the repository. |
 * | **X002** | *identification and authentication* | Signs the REQUEST — the `AuthSignature` over the nodes marked `authenticate="true"`. Proves who is talking; authorises nothing. |
 * | **E002** | *encryption* | Wraps the per-transaction AES key. Never signs anything. |
 *
 * A005 is RSASSA-PKCS1-v1_5 over SHA-256; A006 is RSASSA-PSS over SHA-256
 * (H005 requires support for A005 at minimum, and some banks prefer A006).
 * E002 is RSA PKCS#1 v1.5 encryption of a 16-byte AES key. Order data is
 * deflated, then encrypted with **AES-128-CBC under a zero IV** — a fixed IV
 * that would be a serious flaw anywhere else and is safe here only because the
 * key is fresh random bytes for every single transaction. `newTransactionKey`
 * is therefore the one function in this file that must never be "optimised"
 * into reuse.
 *
 * Nothing here touches the database, the clock or the network: these are pure
 * functions over buffers and keys, which is what makes the whole layer testable
 * without a bank.
 */

/** The signature versions this service implements. */
export const ES_VERSIONS = ['A005', 'A006'] as const;
export type EsVersion = (typeof ES_VERSIONS)[number];

export const AUTH_VERSION = 'X002';
export const ENC_VERSION = 'E002';

/** EBICS mandates 2048-bit RSA at minimum for H005. */
export const KEY_BITS = 2048;

/** AES-128 — 16 bytes of key, and the scheme's fixed all-zero IV. */
const AES_KEY_BYTES = 16;
const ZERO_IV = Buffer.alloc(16, 0);

export interface KeyPair {
  /** PKCS#8 PEM. Encrypted before it is ever written down — see keystore.ts. */
  privatePem: string;
  /** SPKI PEM, for reference; the wire format is modulus + exponent. */
  publicPem: string;
}

/** A public key as EBICS puts it on the wire and on the INI letter. */
export interface PublicKeyParts {
  /** Big-endian modulus, leading zero bytes stripped. */
  modulus: Buffer;
  /** Big-endian exponent, leading zero bytes stripped (65537 → 0x010001). */
  exponent: Buffer;
}

export function generateRsaKeyPair(bits = KEY_BITS): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** Drop leading zero bytes — EBICS transmits the minimal big-endian form. */
function trimLeadingZeros(buf: Buffer): Buffer {
  let start = 0;
  while (start < buf.length - 1 && buf[start] === 0) start++;
  return buf.subarray(start);
}

/** The modulus and exponent of a public (or private) key, as EBICS sends them. */
export function publicKeyParts(key: KeyObject | string): PublicKeyParts {
  const keyObject = typeof key === 'string' ? publicKeyFromPem(key) : key;
  const jwk = keyObject.export({ format: 'jwk' });
  if (jwk.n === undefined || jwk.e === undefined) throw new Error('not an RSA key');
  return {
    modulus: trimLeadingZeros(Buffer.from(jwk.n, 'base64url')),
    exponent: trimLeadingZeros(Buffer.from(jwk.e, 'base64url')),
  };
}

/** Accepts a public PEM, or a private one (from which the public part is taken). */
export function publicKeyFromPem(pem: string): KeyObject {
  return pem.includes('PRIVATE KEY')
    ? createPublicKey(createPrivateKey(pem))
    : createPublicKey(pem);
}

export function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}

/**
 * THE HASH ON THE INI LETTER — and the one a human compares against what the
 * bank published, which makes it the anchor of the whole trust model.
 *
 * EBICS defines it precisely, and the format is unusual enough that getting it
 * wrong is easy: lower-case hex of the exponent, a single space, lower-case hex
 * of the modulus, with both leading-zero-trimmed and no trailing newline — then
 * SHA-256 over that ASCII string. Not over the DER, not over the PEM.
 */
export function publicKeyDigest(key: KeyObject | string): Buffer {
  const { modulus, exponent } = publicKeyParts(key);
  const canonical = `${exponent.toString('hex')} ${modulus.toString('hex')}`;
  return createHash('sha256').update(canonical, 'ascii').digest();
}

/** The digest as a bank prints it: upper-case hex in groups of eight. */
export function formatDigest(digest: Buffer): string {
  return (digest.toString('hex').toUpperCase().match(/.{1,8}/g) ?? []).join(' ');
}

export function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest();
}

// ── Signatures ────────────────────────────────────────────────────────

/**
 * The ES over order data (A005 or A006) — the signature that authorises money
 * to move. EBICS signs the SHA-256 digest of the order data, so the digest is
 * computed here and handed to the signer, never the raw file.
 */
export function signOrderData(privatePem: string, orderData: Buffer, version: EsVersion = 'A005'): Buffer {
  const digest = sha256(orderData);
  return signDigest(privatePem, digest, version);
}

export function verifyOrderData(
  publicPem: string,
  orderData: Buffer,
  signature: Buffer,
  version: EsVersion = 'A005',
): boolean {
  return verifyDigest(publicPem, sha256(orderData), signature, version);
}

/**
 * Sign a digest that has already been computed. A005 is PKCS#1 v1.5, A006 is
 * PSS with a salt the length of the hash — the only difference between the two
 * versions, and the reason they are one function with a switch rather than two.
 */
export function signDigest(privatePem: string, digest: Buffer, version: EsVersion = 'A005'): Buffer {
  const key = privateKeyFromPem(privatePem);
  return version === 'A006'
    ? sign('sha256', digest, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 })
    : sign('sha256', digest, { key, padding: constants.RSA_PKCS1_PADDING });
}

export function verifyDigest(
  publicPem: string,
  digest: Buffer,
  signature: Buffer,
  version: EsVersion = 'A005',
): boolean {
  const key = publicKeyFromPem(publicPem);
  return version === 'A006'
    ? verify('sha256', digest, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature)
    : verify('sha256', digest, { key, padding: constants.RSA_PKCS1_PADDING }, signature);
}

/**
 * The X002 identification-and-authentication signature over the canonical form
 * of the authenticated request nodes. Always PKCS#1 v1.5 over SHA-256 — X002
 * has no PSS variant, which is why this is a separate function from the ES
 * rather than a third `version` value that could be passed by mistake.
 */
export function signAuth(privatePem: string, canonical: string): Buffer {
  return sign('sha256', Buffer.from(canonical, 'utf8'), {
    key: privateKeyFromPem(privatePem),
    padding: constants.RSA_PKCS1_PADDING,
  });
}

export function verifyAuth(publicPem: string, canonical: string, signature: Buffer): boolean {
  return verify(
    'sha256',
    Buffer.from(canonical, 'utf8'),
    { key: publicKeyFromPem(publicPem), padding: constants.RSA_PKCS1_PADDING },
    signature,
  );
}

// ── Transaction key and order-data encryption ─────────────────────────

/**
 * A fresh 16-byte AES key for ONE transaction.
 *
 * The zero IV below is only safe because of this function: with a random key
 * per transaction, a fixed IV leaks nothing. Reusing a transaction key across
 * two orders would turn that fixed IV into a real weakness, so this must stay
 * a generator and never become a cached value.
 */
export function newTransactionKey(): Buffer {
  return randomBytes(AES_KEY_BYTES);
}

/** E002: wrap the transaction key for the bank with RSA PKCS#1 v1.5. */
export function encryptTransactionKey(bankPublicPem: string, transactionKey: Buffer): Buffer {
  return publicEncrypt(
    { key: publicKeyFromPem(bankPublicPem), padding: constants.RSA_PKCS1_PADDING },
    transactionKey,
  );
}

/** E002 in the other direction: unwrap a key the bank encrypted to us. */
export function decryptTransactionKey(ourPrivatePem: string, wrapped: Buffer): Buffer {
  return privateDecrypt({ key: privateKeyFromPem(ourPrivatePem), padding: constants.RSA_PKCS1_PADDING }, wrapped);
}

/**
 * EBICS pads order data with **ANSI X9.23**: fill to the block size with zero
 * bytes and make the LAST byte the number of padding bytes added. A full block
 * of padding is appended when the data already fits, so decryption never has to
 * guess. This is not PKCS#7 (whose padding bytes all carry the count), and
 * Node's automatic padding implements PKCS#7 — hence `setAutoPadding(false)`
 * and doing it by hand. Silently using the wrong padding produces a file the
 * bank decrypts into garbage.
 */
export function padX923(data: Buffer, blockSize = 16): Buffer {
  const count = blockSize - (data.length % blockSize);
  const padding = Buffer.alloc(count, 0);
  padding[count - 1] = count;
  return Buffer.concat([data, padding]);
}

export function unpadX923(data: Buffer, blockSize = 16): Buffer {
  if (data.length === 0 || data.length % blockSize !== 0) {
    throw new Error('padded data must be a whole number of blocks');
  }
  const count = data[data.length - 1]!;
  if (count === 0 || count > blockSize) throw new Error(`invalid X9.23 padding length ${count}`);
  return data.subarray(0, data.length - count);
}

/** AES-128-CBC under the scheme's zero IV, with X9.23 padding applied here. */
export function encryptOrderData(transactionKey: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', transactionKey, ZERO_IV);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padX923(plaintext)), cipher.final()]);
}

export function decryptOrderData(transactionKey: Buffer, ciphertext: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-cbc', transactionKey, ZERO_IV);
  decipher.setAutoPadding(false);
  return unpadX923(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

/**
 * The full outbound pipeline for an order: **deflate, then encrypt, then
 * base64**. The order matters — compressing after encryption would achieve
 * nothing, and a bank that receives the steps in the wrong order reports a
 * decryption failure with no hint as to why.
 */
export function packOrderData(transactionKey: Buffer, orderData: Buffer): string {
  return encryptOrderData(transactionKey, deflateSync(orderData)).toString('base64');
}

/** The same pipeline in reverse, for anything the bank sends back. */
export function unpackOrderData(transactionKey: Buffer, packed: string): Buffer {
  return inflateSync(decryptOrderData(transactionKey, Buffer.from(packed, 'base64')));
}
