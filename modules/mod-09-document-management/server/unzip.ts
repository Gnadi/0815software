import { constants, inflateRawSync } from 'node:zlib';

/**
 * Reading entries out of a ZIP container — what DOCX, XLSX, PPTX and the
 * OpenDocument formats are — with Node's own zlib, so text can be read out
 * of office files without a library.
 *
 * An upload is untrusted: the central directory is read with bounds checks,
 * entries are only inflated when asked for, and every inflate is capped
 * (`maxOutputLength`), so a "zip bomb" — a few kilobytes that inflate to
 * gigabytes — fails one entry instead of the process. ZIP64 and encrypted
 * entries are not read: office software writes neither for documents of the
 * size this module accepts.
 */

export interface ZipArchive {
  names: string[];
  /** The entry's bytes, or null when it is missing, encrypted or too large. */
  read(name: string): Buffer | null;
}

interface Entry {
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const MAX_ENTRIES = 5000;

export function openZip(buf: Buffer, maxEntryBytes = 32 * 1024 * 1024): ZipArchive | null {
  // The end-of-central-directory record sits in the last 22 bytes, or up to
  // 64 KiB earlier when the archive carries a comment.
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES || dirOffset >= buf.length) return null;

  const entries = new Map<string, Entry>();
  let p = dirOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    if (p + 46 + nameLength > buf.length) return null;
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    entries.set(name, {
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }

  return {
    names: [...entries.keys()],
    read(name: string): Buffer | null {
      const e = entries.get(name);
      if (!e || e.flags & 0x1 || e.size > maxEntryBytes) return null;
      const lh = e.localOffset;
      if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) return null;
      const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
      const end = start + e.compressedSize;
      if (end > buf.length) return null;
      const data = buf.subarray(start, end);
      if (e.method === 0) return data;
      if (e.method !== 8) return null;
      try {
        return inflateRawSync(data, { maxOutputLength: maxEntryBytes, finishFlush: constants.Z_SYNC_FLUSH });
      } catch {
        return null;
      }
    },
  };
}
