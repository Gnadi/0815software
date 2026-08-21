import { inflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP reader — enough to open what a bank sends, and no more.
 *
 * EBICS delivers `camt.053` and `pain.002` inside a ZIP container (the BTF's
 * `Container` element says so), because one download can carry several days or
 * several accounts. Node ships `zlib`, which does the *compression* a ZIP
 * entry uses, but nothing that reads the archive format around it — so this is
 * ~100 lines rather than a dependency, keeping the `express` +
 * `better-sqlite3` invariant that all twelve services hold.
 *
 * ## What it reads, and what it refuses
 *
 * Reading is driven by the **central directory**, never by the local headers'
 * size fields. That is not a stylistic choice: when the general-purpose bit 3
 * is set, an entry's local header carries zeroes and the real sizes follow the
 * data in a descriptor. Trusting the local header there yields an empty file
 * with no error. The central directory always has the true values.
 *
 * Refused rather than guessed at: ZIP64, encryption, and any compression
 * method other than stored (0) or deflate (8). Each of those would need real
 * work to support, and a reader that quietly returned wrong bytes for one
 * would be worse than one that says it cannot.
 */

export class ZipError extends Error {}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** The two bytes every ZIP starts with, for sniffing content of unknown type. */
export function looksLikeZip(data: Buffer): boolean {
  return data.length >= 4 && data.readUInt32LE(0) === LOCAL_SIGNATURE;
}

export interface ZipEntry {
  name: string;
  content: Buffer;
}

/**
 * Every file in the archive, in central-directory order.
 *
 * Directory entries are skipped — they carry no data and a caller asking for
 * "the documents in this archive" does not want them.
 */
export function unzip(archive: Buffer): ZipEntry[] {
  const eocd = findEocd(archive);
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ZipError(`central directory entry ${n + 1} is missing or malformed`);
    }

    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    // Bit 0 is the traditional encryption flag. An encrypted entry decodes to
    // garbage rather than failing, so it is refused by name.
    if ((flags & 0x0001) !== 0) throw new ZipError(`"${name}" is encrypted, which this reader does not support`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError(`"${name}" uses ZIP64, which this reader does not support`);
    }

    if (!name.endsWith('/')) {
      entries.push({ name, content: readEntry(archive, localOffset, method, compressedSize, uncompressedSize, name) });
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Find the End of Central Directory record.
 *
 * It sits at the very end unless the archive has a comment, so the search runs
 * backwards over the largest a comment may be (65535) plus the record itself.
 */
function findEocd(archive: Buffer): number {
  const earliest = Math.max(0, archive.length - 22 - 0xffff);
  for (let i = archive.length - 22; i >= earliest; i -= 1) {
    if (archive.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new ZipError('not a ZIP archive: no end-of-central-directory record');
}

/** Read one entry's bytes, using the sizes the CENTRAL directory gave us. */
function readEntry(
  archive: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
  name: string,
): Buffer {
  if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
    throw new ZipError(`"${name}" points at no local file header`);
  }
  // The local header's own name and extra lengths may differ from the central
  // directory's, so the data offset has to come from the local header.
  const nameLength = archive.readUInt16LE(localOffset + 26);
  const extraLength = archive.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const raw = archive.subarray(start, start + compressedSize);

  if (method === 0) {
    if (raw.length !== uncompressedSize) throw new ZipError(`"${name}" is truncated`);
    return Buffer.from(raw);
  }
  if (method !== 8) throw new ZipError(`"${name}" uses compression method ${method}, which this reader cannot open`);

  let inflated: Buffer;
  try {
    inflated = inflateRawSync(raw);
  } catch (err) {
    throw new ZipError(`"${name}" could not be inflated: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (inflated.byteLength !== uncompressedSize) {
    throw new ZipError(`"${name}" inflated to ${inflated.byteLength} bytes, but the directory says ${uncompressedSize}`);
  }
  return inflated;
}

/**
 * The documents inside whatever the bank sent.
 *
 * Sniffs rather than trusting the BTF, because the two disagree in practice:
 * a bank that publishes `Container=ZIP` may still send a bare XML file when
 * there is only one document, and a caller that believed the BTF would hand
 * an XML file to the ZIP reader and get nothing. The magic bytes are the
 * honest answer to "what is this?".
 */
export function documentsIn(content: Buffer): Buffer[] {
  if (!looksLikeZip(content)) return [content];
  return unzip(content).map((entry) => entry.content);
}
