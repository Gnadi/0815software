import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for credentials at rest. The stored blob is
 * `<iv hex>:<auth tag hex>:<ciphertext hex>`. The plaintext is never
 * written to disk and never returned over the API.
 */

/** Parse and validate the 32-byte key; throws (fail-fast) on a bad key. */
export function loadKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('INTEGRATION_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decrypt(key: Buffer, blob: string): string {
  const [ivHex, tagHex, dataHex] = blob.split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}
