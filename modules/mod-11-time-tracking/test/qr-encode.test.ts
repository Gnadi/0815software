import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeQr } from '../src/qr/encode.js';
import { decodeQr, type Pixels } from '../src/scan/qr.js';

/**
 * The QR encoder (src/qr/encode.ts, a copy-in that draws the two-factor QR
 * code at sign-in) against the symbols an INDEPENDENT encoder made — segno,
 * test/fixtures/qr/generate.py. Same text, version, level and mask must give
 * the same matrix, module for module; and our own decoder must read back
 * what the encoder writes with the mask it chose itself.
 */

const { symbols } = JSON.parse(readFileSync(new URL('./fixtures/qr/symbols.json', import.meta.url), 'utf8')) as {
  symbols: { text: string; version: number; level: 'L' | 'M' | 'Q' | 'H'; rows: string[] }[];
};

const unhex = (rows: string[], n: number): boolean[][] =>
  rows.map((row) => [...row].flatMap((h) => parseInt(h, 16).toString(2).padStart(4, '0').split('').map((b) => b === '1')).slice(0, n));

/** The mask a symbol was drawn with, read from its first format-information copy. */
function maskOf(m: boolean[][]): number {
  const bit = (b: boolean) => (b ? 1 : 0);
  let bits = 0;
  const at: [number, number][] = [];
  for (let i = 0; i <= 5; i++) at.push([8, i]);
  at.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) at.push([14 - i, 8]);
  at.forEach(([x, y], i) => (bits |= bit(m[y]![x]!) << i));
  return ((bits ^ 0x5412) >>> 10) & 7;
}

function draw(modules: boolean[][], scale = 4): Pixels {
  const n = modules.length;
  const size = (n + 8) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (!modules[y]![x]) continue;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const p = (((y + 4) * scale + dy) * size + (x + 4) * scale + dx) * 4;
          data[p] = data[p + 1] = data[p + 2] = 0;
        }
    }
  return { width: size, height: size, data };
}

/**
 * Where the data plus the 4-bit terminator ends exactly on a byte boundary,
 * segno writes a further zero byte before the pad codewords; ISO/IEC 18004
 * §7.4.10 goes straight to the pad codewords (11101100 00010001). Readers stop
 * at the terminator, so both say the same — those symbols are compared by
 * what they read as. Every other symbol must match module for module, which
 * pins placement, masks, format and version information, Reed–Solomon and
 * block interleaving at every version and level.
 */
function alignedAfterTerminator(text: string, version: number): boolean {
  const band = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  let bits: number;
  if (/^\d*$/.test(text)) bits = 4 + [10, 12, 14][band]! + 10 * Math.floor(text.length / 3) + [0, 4, 7][text.length % 3]!;
  else if (/^[0-9A-Z $%*+\-./:]*$/.test(text)) bits = 4 + [9, 11, 13][band]! + 11 * Math.floor(text.length / 2) + 6 * (text.length % 2);
  else {
    const latin1 = [...text].every((c) => c.charCodeAt(0) < 256);
    bits = 4 + [8, 16, 16][band]! + 8 * (latin1 ? text.length : new TextEncoder().encode(text).length);
  }
  return (bits + 4) % 8 === 0;
}

describe('QR encoder against segno', () => {
  const exact = symbols.filter((s) => !alignedAfterTerminator(s.text, s.version));
  const quirk = symbols.filter((s) => alignedAfterTerminator(s.text, s.version));

  it('covers most fixtures module for module', () => {
    expect(exact.length).toBeGreaterThanOrEqual(25);
  });

  it.each(exact.map((s) => [`${s.version}-${s.level}`, s] as const))('%s matches module for module', (_name, s) => {
    const n = s.version * 4 + 17;
    const expected = unhex(s.rows, n);
    const ours = encodeQr(s.text, { level: s.level, version: s.version, mask: maskOf(expected) });
    expect(ours.size).toBe(n);
    expect(ours.modules).toEqual(expected);
  });

  it.each(quirk.map((s) => [`${s.version}-${s.level}`, s] as const))('%s reads the same as segno’s', (_name, s) => {
    const ours = encodeQr(s.text, { level: s.level, version: s.version });
    expect(decodeQr(draw(ours.modules))?.text).toBe(s.text);
    expect(decodeQr(draw(unhex(s.rows, s.version * 4 + 17)))?.text).toBe(s.text);
  });
});

describe('QR encoder, read back', () => {
  it.each([
    'otpauth://totp/Acme%20GmbH:ada%40acme.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Acme+GmbH&algorithm=SHA1&digits=6&period=30',
    'HELLO WORLD',
    '0815',
    'Grüße — ✓',
  ])('%s', (text) => {
    const symbol = encodeQr(text);
    const read = decodeQr(draw(symbol.modules));
    expect(read?.text).toBe(text);
    expect(read?.level).toBe('M');
  });
});
