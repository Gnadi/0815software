import { deflateRawSync, deflateSync } from 'node:zlib';

/**
 * Files built in the test, for the cases no office suite writes on request:
 * a PDF with a standard font and octal escapes, an object stream, a form
 * XObject, an encrypted trailer, a page that is only a picture; a ZIP that
 * inflates to far more than it weighs.
 */

export type PdfObject = string | { dict: string; stream: Buffer | string; deflate?: boolean };

/** A PDF of the given objects (1 is the catalog), with a correct xref table. */
export function buildPdf(objects: PdfObject[], trailerExtra = ''): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((obj, i) => {
    offsets.push(length);
    let chunk: Buffer;
    if (typeof obj === 'string') {
      chunk = Buffer.from(`${i + 1} 0 obj\n${obj}\nendobj\n`, 'latin1');
    } else {
      const raw = typeof obj.stream === 'string' ? Buffer.from(obj.stream, 'latin1') : obj.stream;
      const data = obj.deflate ? deflateSync(raw) : raw;
      chunk = Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n<< ${obj.dict}${obj.deflate ? ' /Filter /FlateDecode' : ''} /Length ${data.length} >>\nstream\n`, 'latin1'),
        data,
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
      ]);
    }
    parts.push(chunk);
    length += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${length}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

/** A stored-or-deflated ZIP of the given entries. */
export function buildZip(files: { name: string; data: Buffer | string; store?: boolean }[]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : f.data;
    const body = f.store ? data : deflateRawSync(data);
    const name = Buffer.from(f.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(f.store ? 0 : 8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(f.store ? 0 : 8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
