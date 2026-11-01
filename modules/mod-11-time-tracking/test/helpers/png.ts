import { inflateSync } from 'node:zlib';

/**
 * Just enough PNG to read the QR fixtures into RGBA, as a canvas would hand
 * them to the decoder: 8-bit greyscale, grey + alpha, RGB or RGBA, not
 * interlaced, all five row filters (PNG specification, sections 7–9).
 */
export function readPng(file: Buffer): { width: number; height: number; data: Uint8ClampedArray } {
  if (!file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (pos < file.length) {
    const length = file.readUInt32BE(pos);
    const type = file.subarray(pos + 4, pos + 8).toString('latin1');
    const body = file.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      colour = body[9]!;
      interlace = body[12]!;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colour];
  if (depth !== 8 || channels === undefined || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, colour ${colour}, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0;
      let v = line[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + x] = v & 0xff;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    const [r, g, b, alpha] =
      channels === 1 ? [pixels[p]!, pixels[p]!, pixels[p]!, 255] : channels === 2 ? [pixels[p]!, pixels[p]!, pixels[p]!, pixels[p + 1]!] : channels === 3 ? [pixels[p]!, pixels[p + 1]!, pixels[p + 2]!, 255] : [pixels[p]!, pixels[p + 1]!, pixels[p + 2]!, pixels[p + 3]!];
    data.set([r, g, b, alpha], i * 4);
  }
  return { width, height, data };
}
