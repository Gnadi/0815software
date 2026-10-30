import { inflateRawSync } from 'node:zlib';

/**
 * Read back what server/zip.ts writes — for the tests only. Driven by the
 * central directory, deflate and stored entries; enough to open an .xlsx.
 */
export function unzip(archive: Buffer): Map<string, Buffer> {
  let eocd = archive.length - 22;
  while (eocd >= 0 && archive.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a ZIP archive');
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory');
    const method = archive.readUInt16LE(offset + 10);
    const size = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extra = archive.readUInt16LE(offset + 30);
    const comment = archive.readUInt16LE(offset + 32);
    const local = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = archive.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + extra + comment;
  }
  return files;
}
