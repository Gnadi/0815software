/**
 * Encryption for backup archives that leave the host.
 *
 * An archive holds every invoice, customer and bank detail of a stack, plus
 * the stack's `.env`. It goes to a NAS, a second server or a cloud bucket, so
 * it is encrypted before it leaves the host: whoever holds the target holds
 * nothing readable without the passphrase.
 *
 * Format (all integers unsigned, one byte each):
 *
 *   "0815BAK" 0x01 | logN | r | p | salt[16] | iv[12] | ciphertext | tag[16]
 *
 * AES-256-GCM with a key from scrypt(passphrase, salt). The whole header is
 * the GCM additional data, so the KDF parameters cannot be swapped without the
 * tag failing. Node's crypto only — no dependency, and nothing a restore on a
 * fresh host needs beyond the repository and Node.
 *
 * Decryption never hands out unauthenticated plaintext: it writes to a
 * temporary file and renames it into place only after the tag verified. A
 * truncated or tampered archive therefore produces an error and no output,
 * never a half-restored database.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { createReadStream, createWriteStream, openSync, readSync, closeSync, fstatSync, renameSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

const MAGIC = Buffer.from('0815BAK\x01', 'latin1');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + 3 + SALT_LEN + IV_LEN;

// 2^15 × 8 × 128 B = 32 MiB per derivation: slow enough to make guessing a
// stolen archive's passphrase expensive, small enough for a modest VM.
const DEFAULT_KDF = { logN: 15, r: 8, p: 1 };

export class BackupCryptoError extends Error {}

async function deriveKey(passphrase, salt, { logN, r, p }) {
  if (logN < 14 || logN > 22 || r < 1 || r > 32 || p < 1 || p > 16) {
    // Bounded so a crafted header cannot ask for gigabytes of memory.
    throw new BackupCryptoError('archive header carries implausible key-derivation parameters');
  }
  const N = 2 ** logN;
  return scrypt(passphrase, salt, 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
}

/** Encrypt `inPath` into `outPath`. */
export async function encryptFile(inPath, outPath, passphrase, kdf = DEFAULT_KDF) {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const header = Buffer.concat([MAGIC, Buffer.from([kdf.logN, kdf.r, kdf.p]), salt, iv]);
  const key = await deriveKey(passphrase, salt, kdf);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);

  const out = createWriteStream(outPath, { mode: 0o600 });
  out.write(header);
  await pipeline(createReadStream(inPath), cipher, out, { end: false });
  await new Promise((resolve, reject) => {
    out.end(cipher.getAuthTag(), (err) => (err ? reject(err) : resolve()));
  });
}

/** Read and validate the fixed-size header of an archive. */
function readHeader(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size < HEADER_LEN + TAG_LEN) throw new BackupCryptoError(`${path} is too short to be a backup archive`);
    const header = Buffer.alloc(HEADER_LEN);
    readSync(fd, header, 0, HEADER_LEN, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new BackupCryptoError(`${path} is not a 0815 backup archive (or a newer format than this tool reads)`);
    }
    const tag = Buffer.alloc(TAG_LEN);
    readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
    let o = MAGIC.length;
    const kdf = { logN: header[o++], r: header[o++], p: header[o++] };
    const salt = header.subarray(o, (o += SALT_LEN));
    const iv = header.subarray(o, (o += IV_LEN));
    return { header, kdf, salt, iv, tag, size };
  } finally {
    closeSync(fd);
  }
}

/**
 * Decrypt `inPath` into `outPath`. Throws, leaving no `outPath`, when the
 * passphrase is wrong or the archive was truncated or altered.
 */
export async function decryptFile(inPath, outPath, passphrase) {
  const { header, kdf, salt, iv, tag, size } = readHeader(inPath);
  const key = await deriveKey(passphrase, salt, kdf);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);

  const partial = `${outPath}.partial`;
  try {
    await pipeline(
      createReadStream(inPath, { start: HEADER_LEN, end: size - TAG_LEN - 1 }),
      decipher,
      createWriteStream(partial, { mode: 0o600 }),
    );
  } catch (err) {
    rmSync(partial, { force: true });
    if (err instanceof Error && /unable to authenticate|auth/i.test(err.message)) {
      throw new BackupCryptoError(
        'the archive does not decrypt: wrong BACKUP_PASSPHRASE, or the file was truncated or altered',
      );
    }
    throw err;
  }
  renameSync(partial, outPath);
}
