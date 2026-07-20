import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface StoredBlob {
  sha256: string;
  size: number;
  /** Content-addressed file name under the storage directory. */
  storagePath: string;
}

/**
 * Content-addressed blob store. Bytes are written to a file named by their
 * SHA-256 hash, so identical content across documents/versions is stored
 * once and never mutated. Returns the hash, size and stored name.
 */
export function writeBlob(storageDir: string, bytes: Buffer): StoredBlob {
  mkdirSync(storageDir, { recursive: true });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const storagePath = sha256;
  const full = resolve(storageDir, storagePath);
  if (!existsSync(full)) {
    writeFileSync(full, bytes);
  }
  return { sha256, size: bytes.length, storagePath };
}

/** Absolute path of a stored blob. `storagePath` always comes from the DB. */
export function blobPath(storageDir: string, storagePath: string): string {
  return resolve(storageDir, storagePath);
}
