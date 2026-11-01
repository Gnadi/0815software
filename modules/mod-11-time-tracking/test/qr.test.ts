import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeQr, type Pixels } from '../src/scan/qr.js';
import { parseRksv } from '../shared/rksv.js';
import { readPng } from './helpers/png.js';

/**
 * The QR reader (src/scan/qr.ts) against codes made by an independent
 * encoder — segno, see test/fixtures/qr/generate.py — so it is tested
 * against someone else's reading of ISO/IEC 18004, not against itself.
 */

const fixture = (name: string) => new URL(`./fixtures/qr/${name}`, import.meta.url);
const { generator, symbols } = JSON.parse(readFileSync(fixture('symbols.json'), 'utf8')) as {
  generator: string;
  symbols: { text: string; version: number; level: 'L' | 'M' | 'Q' | 'H'; rows: string[] }[];
};

/** A module matrix drawn as a picture: `scale` pixels a module, a four-module quiet zone. */
function draw(modules: number[][], scale = 4): Pixels {
  const n = modules.length;
  const size = (n + 8) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!modules[y]![x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const p = (((y + 4) * scale + dy) * size + (x + 4) * scale + dx) * 4;
          data[p] = data[p + 1] = data[p + 2] = 0;
        }
      }
    }
  }
  return { width: size, height: size, data };
}

const unhex = (rows: string[], n: number): number[][] =>
  rows.map((row) => [...row].flatMap((h) => parseInt(h, 16).toString(2).padStart(4, '0').split('').map(Number)).slice(0, n));

/** A small, seeded generator, so a noisy picture is the same noisy picture every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe(`every version, every level (${generator})`, () => {
  it.each(symbols.map((s) => [`version ${s.version}-${s.level}`, s] as const))('%s', (_, s) => {
    const n = 17 + 4 * s.version;
    const result = decodeQr(draw(unhex(s.rows, n), s.version > 20 ? 3 : 4));
    expect(result).toEqual({ text: s.text, version: s.version, level: s.level, corrected: 0 });
  });
});

describe('error correction', () => {
  it('reads through damage up to what the level carries, and refuses past it', () => {
    const s = symbols.find((x) => x.version === 5 && x.level === 'H')!;
    const n = 37;
    const modules = unhex(s.rows, n);
    // Ink across the middle of the symbol: a coffee stain over a third of the rows.
    const stained = modules.map((row, y) => row.map((v, x) => (y >= 14 && y < 20 && x >= 10 && x < 27 ? 1 - v : v)));
    const read = decodeQr(draw(stained));
    expect(read?.text).toBe(s.text);
    expect(read!.corrected).toBeGreaterThan(0);
    // The same symbol flipped over most of its data area is not "corrected" into something else.
    const ruined = modules.map((row, y) => row.map((v, x) => (y >= 10 && y < 30 && x >= 10 && x < 30 ? 1 - v : v)));
    expect(decodeQr(draw(ruined))).toBeNull();
  });

  it('and noise on every pixel', () => {
    const s = symbols.find((x) => x.version === 7 && x.level === 'M')!;
    const picture = draw(unhex(s.rows, 45));
    const random = rng(42);
    for (let i = 0; i < picture.data.length; i += 4) {
      const v = Math.max(0, Math.min(255, picture.data[i]! * 0.7 + 40 + (random() - 0.5) * 120));
      picture.data[i] = picture.data[i + 1] = picture.data[i + 2] = v;
    }
    expect(decodeQr(picture)?.text).toBe(s.text);
  });
});

describe('a till receipt, photographed', () => {
  it.each(['clean', 'rotated', 'perspective', 'shadow', 'small'])('%s', (name) => {
    const picture = readPng(readFileSync(fixture(`receipt-${name}.png`)));
    const read = decodeQr(picture);
    expect(read).not.toBeNull();
    expect(read).toMatchObject({ version: 10, level: 'M' });
    const receipt = parseRksv(read!.text);
    expect(receipt).toMatchObject({ cashbox_id: 'GASTHAUS-1', receipt_id: '4711', total_cents: 2820, kind: 'sale' });
  });
});

describe('what is not a code', () => {
  it('a blank page and a page of noise read as nothing', () => {
    const blank = { width: 200, height: 200, data: new Uint8ClampedArray(200 * 200 * 4).fill(255) };
    expect(decodeQr(blank)).toBeNull();
    const random = rng(7);
    const noise = { width: 200, height: 200, data: new Uint8ClampedArray(200 * 200 * 4) };
    for (let i = 0; i < noise.data.length; i += 4) noise.data[i] = noise.data[i + 1] = noise.data[i + 2] = random() < 0.5 ? 0 : 255;
    for (let i = 3; i < noise.data.length; i += 4) noise.data[i] = 255;
    expect(decodeQr(noise)).toBeNull();
  });
});
