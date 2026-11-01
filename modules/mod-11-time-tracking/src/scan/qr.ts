import { ALIGNMENT, EC_BLOCKS, type EcLevel } from './qr-tables';

/**
 * A QR code reader (ISO/IEC 18004:2015, Model 2, versions 1–40), in the
 * browser, without a library — so a till receipt's code is read on the phone,
 * offline, and the picture never leaves it to be read.
 *
 * The steps are the standard's, in order:
 *
 *   1. binarize — a threshold per 8 × 8 block from its neighbourhood, so a
 *      shadow across the receipt does not swallow half the code;
 *   2. find the three finder patterns (dark–light–dark–light–dark in the
 *      ratio 1:1:3:1:1, across and down), and tell which is which;
 *   3. estimate the version from their distance, find the alignment pattern
 *      near where it should be, and map the grid onto the picture by a
 *      perspective transform — a photo taken at an angle reads too;
 *   4. read the format information (level and mask, BCH-protected, two
 *      copies) and, from version 7, the version information;
 *   5. read the codewords in the zigzag order around the function patterns,
 *      unmasked; split them into their blocks;
 *   6. correct each block with Reed–Solomon over GF(256) — up to half its
 *      error-correction codewords may be wrong;
 *   7. read the segments: numeric, alphanumeric, byte (with ECI), kanji.
 *
 * What it does not do: Micro QR, rectangular rMQR, mirrored codes, or more
 * than one code in a picture. A receipt carries one, and it is the Model 2.
 */

export interface QrResult {
  text: string;
  version: number;
  level: EcLevel;
  /** Blocks whose errors Reed–Solomon corrected — how hard it was. */
  corrected: number;
}

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, four bytes a pixel, as a canvas's ImageData holds it. */
  data: Uint8ClampedArray | Uint8Array;
}

/** Read the QR code in a picture, or null when there is none it can read. */
export function decodeQr(image: Pixels): QrResult | null {
  const { width, height } = image;
  if (width < 21 || height < 21) return null;
  const bits = binarize(luminance(image), width, height);
  const finders = selectFinders(findFinders(bits, width, height));
  for (const triple of finders) {
    const result = decodeAt(bits, width, height, triple);
    if (result) return result;
  }
  return null;
}

// ── 1. Binarize ─────────────────────────────────────────────────────────

function luminance({ width, height, data }: Pixels): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    // Rec. 601 weights in integers; alpha over white, as a transparent PNG shows.
    const a = data[p + 3]!;
    const y = (data[p]! * 77 + data[p + 1]! * 150 + data[p + 2]! * 29) >> 8;
    out[i] = a === 255 ? y : (y * a + 255 * (255 - a)) / 255;
  }
  return out;
}

const BLOCK = 8;
const MIN_RANGE = 24;

/**
 * 1 = dark. Each 8 × 8 block gets the mean of its pixels as its black point;
 * a flat block (a range under 24) takes half its minimum, or its neighbours'
 * when they are darker, so the inside of a large dark module stays dark. A
 * pixel is dark when it is at or under the average black point of the 5 × 5
 * blocks around its own.
 */
function binarize(lum: Uint8Array, width: number, height: number): Uint8Array {
  const bw = Math.ceil(width / BLOCK);
  const bh = Math.ceil(height / BLOCK);
  const black = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let min = 255;
      let max = 0;
      let sum = 0;
      let n = 0;
      for (let y = by * BLOCK; y < Math.min(height, (by + 1) * BLOCK); y++) {
        for (let x = bx * BLOCK; x < Math.min(width, (bx + 1) * BLOCK); x++) {
          const v = lum[y * width + x]!;
          sum += v;
          n++;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      let avg = sum / n;
      if (max - min <= MIN_RANGE) {
        avg = min / 2;
        if (by > 0 && bx > 0) {
          const neighbours = (black[(by - 1) * bw + bx]! + 2 * black[by * bw + bx - 1]! + black[(by - 1) * bw + bx - 1]!) / 4;
          if (min < neighbours) avg = neighbours;
        }
      }
      black[by * bw + bx] = avg;
    }
  }
  const bits = new Uint8Array(width * height);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sum = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const yy = Math.min(bh - 1, Math.max(0, by + dy));
          const xx = Math.min(bw - 1, Math.max(0, bx + dx));
          sum += black[yy * bw + xx]!;
          n++;
        }
      }
      const threshold = sum / n;
      for (let y = by * BLOCK; y < Math.min(height, (by + 1) * BLOCK); y++) {
        for (let x = bx * BLOCK; x < Math.min(width, (bx + 1) * BLOCK); x++) {
          bits[y * width + x] = lum[y * width + x]! <= threshold ? 1 : 0;
        }
      }
    }
  }
  return bits;
}

// ── 2. Finder patterns ──────────────────────────────────────────────────

interface Point {
  x: number;
  y: number;
}

interface Finder extends Point {
  size: number;
  count: number;
}

/** 1:1:3:1:1, each run within half a module (the centre within one and a half). */
function isFinderRatio(c: readonly number[]): boolean {
  const total = c[0]! + c[1]! + c[2]! + c[3]! + c[4]!;
  if (total < 7 || c.some((v) => v === 0)) return false;
  const m = total / 7;
  const v = m / 2;
  return Math.abs(m - c[0]!) < v && Math.abs(m - c[1]!) < v && Math.abs(3 * m - c[2]!) < 3 * v && Math.abs(m - c[3]!) < v && Math.abs(m - c[4]!) < v;
}

const centerFromEnd = (c: readonly number[], end: number): number => end - c[4]! - c[3]! - c[2]! / 2;

function crossCheck(bits: Uint8Array, width: number, height: number, cx: number, cy: number, vertical: boolean, maxCount: number, originalTotal: number): number {
  const at = (i: number) => (vertical ? bits[i * width + cx]! : bits[cy * width + i]!);
  const limit = vertical ? height : width;
  const start = vertical ? cy : cx;
  const c = [0, 0, 0, 0, 0];
  let i = start;
  while (i >= 0 && at(i)) {
    c[2]!++;
    i--;
  }
  if (i < 0) return NaN;
  while (i >= 0 && !at(i) && c[1]! <= maxCount) {
    c[1]!++;
    i--;
  }
  if (i < 0 || c[1]! > maxCount) return NaN;
  while (i >= 0 && at(i) && c[0]! <= maxCount) {
    c[0]!++;
    i--;
  }
  if (c[0]! > maxCount) return NaN;
  i = start + 1;
  while (i < limit && at(i)) {
    c[2]!++;
    i++;
  }
  if (i === limit) return NaN;
  while (i < limit && !at(i) && c[3]! < maxCount) {
    c[3]!++;
    i++;
  }
  if (i === limit || c[3]! >= maxCount) return NaN;
  while (i < limit && at(i) && c[4]! < maxCount) {
    c[4]!++;
    i++;
  }
  if (c[4]! >= maxCount) return NaN;
  const total = c[0]! + c[1]! + c[2]! + c[3]! + c[4]!;
  // Far off the run that triggered the check is a different shape.
  if (5 * Math.abs(total - originalTotal) >= 2 * originalTotal) return NaN;
  return isFinderRatio(c) ? centerFromEnd(c, i) : NaN;
}

function findFinders(bits: Uint8Array, width: number, height: number): Finder[] {
  const found: Finder[] = [];
  const consider = (c: number[], row: number, end: number) => {
    const total = c.reduce((a, b) => a + b, 0);
    let x = centerFromEnd(c, end);
    const y = crossCheck(bits, width, height, Math.floor(x), row, true, c[2]!, total);
    if (Number.isNaN(y)) return false;
    x = crossCheck(bits, width, height, Math.floor(x), Math.floor(y), false, c[2]!, total);
    if (Number.isNaN(x)) return false;
    const size = total / 7;
    for (const f of found) {
      if (Math.abs(f.x - x) <= size && Math.abs(f.y - y) <= size && (Math.abs(f.size - size) <= 1 || Math.abs(f.size - size) <= f.size)) {
        // The same pattern seen from another row: average it in.
        const n = f.count + 1;
        f.x = (f.x * f.count + x) / n;
        f.y = (f.y * f.count + y) / n;
        f.size = (f.size * f.count + size) / n;
        f.count = n;
        return true;
      }
    }
    found.push({ x, y, size, count: 1 });
    return true;
  };
  for (let y = 0; y < height; y++) {
    const c = [0, 0, 0, 0, 0];
    let state = 0;
    for (let x = 0; x < width; x++) {
      if (bits[y * width + x]) {
        if (state & 1) state++;
        c[state]!++;
      } else if (!(state & 1)) {
        if (state === 4) {
          if (isFinderRatio(c) && consider(c, y, x)) {
            c.fill(0);
            state = 0;
            continue;
          }
          c[0] = c[2]!;
          c[1] = c[3]!;
          c[2] = c[4]!;
          c[3] = 1;
          c[4] = 0;
          state = 3;
        } else c[++state]!++;
      } else c[state]!++;
    }
    if (state === 4 && isFinderRatio(c)) consider(c, y, width);
  }
  return found;
}

interface Triple {
  tl: Finder;
  tr: Finder;
  bl: Finder;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** The likeliest three, as top-left, top-right and bottom-left — best first. */
function selectFinders(all: Finder[]): Triple[] {
  const top = [...all].sort((a, b) => b.count - a.count).slice(0, 12);
  const out: { t: Triple; score: number }[] = [];
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      for (let k = j + 1; k < top.length; k++) {
        const p = [top[i]!, top[j]!, top[k]!];
        const sizes = p.map((f) => f.size);
        if (Math.max(...sizes) > 1.6 * Math.min(...sizes)) continue;
        // The corner opposite the longest side is the top-left.
        const d = [dist(p[1]!, p[2]!), dist(p[0]!, p[2]!), dist(p[0]!, p[1]!)];
        const corner = d.indexOf(Math.max(...d));
        const tl = p[corner]!;
        let [a, b] = p.filter((_, n) => n !== corner) as [Finder, Finder];
        const legA = dist(tl, a);
        const legB = dist(tl, b);
        if (Math.max(legA, legB) > 2 * Math.min(legA, legB)) continue;
        const cos = ((a.x - tl.x) * (b.x - tl.x) + (a.y - tl.y) * (b.y - tl.y)) / (legA * legB);
        if (Math.abs(cos) > 0.5) continue;
        const module = (sizes[0]! + sizes[1]! + sizes[2]!) / 3;
        if (Math.min(legA, legB) / module < 10) continue;
        // With y downwards, top-right × bottom-left turns clockwise.
        if ((a.x - tl.x) * (b.y - tl.y) - (a.y - tl.y) * (b.x - tl.x) < 0) [a, b] = [b, a];
        const score = p.reduce((s, f) => s + Math.min(f.count, 5), 0) - 3 * Math.abs(cos) - Math.abs(legA - legB) / Math.max(legA, legB);
        out.push({ t: { tl, tr: a, bl: b }, score });
      }
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, 4).map((o) => o.t);
}

// ── 3. Geometry ─────────────────────────────────────────────────────────

/** A 3 × 3 projective transform, row-major. */
type Transform = readonly [number, number, number, number, number, number, number, number, number];

/** The unit square onto a quadrilateral (Heckbert). */
function squareToQuad(p0: Point, p1: Point, p2: Point, p3: Point): Transform {
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy3 = p0.y - p1.y + p2.y - p3.y;
  if (dx3 === 0 && dy3 === 0) return [p1.x - p0.x, p2.x - p1.x, p0.x, p1.y - p0.y, p2.y - p1.y, p0.y, 0, 0, 1];
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y, g, h, 1];
}

function invert(m: Transform): Transform {
  const [a, b, c, d, e, f, g, h, i] = m;
  return [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d];
}

function multiply(m: Transform, n: Transform): Transform {
  const r = new Array<number>(9);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) r[row * 3 + col] = m[row * 3]! * n[col]! + m[row * 3 + 1]! * n[3 + col]! + m[row * 3 + 2]! * n[6 + col]!;
  return r as unknown as Transform;
}

const apply = (m: Transform, x: number, y: number): Point => {
  const w = m[6] * x + m[7] * y + m[8];
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w };
};

/** Grid coordinates (module units) to picture coordinates, from four matched points. */
function gridToImage(src: readonly [Point, Point, Point, Point], dst: readonly [Point, Point, Point, Point]): Transform {
  const toDst = squareToQuad(dst[0], dst[1], dst[2], dst[3]);
  const toSrc = squareToQuad(src[0], src[1], src[2], src[3]);
  // The column-vector form: picture = toDst · inverse(toSrc) · grid.
  return multiply(toDst, invert(toSrc));
}

/** Look for the alignment pattern (a dark module ringed light, ringed dark) near where it should be. */
function findAlignment(bits: Uint8Array, width: number, height: number, at: Point, module: number, radius: number): Point | null {
  const r = Math.max(3, Math.ceil(radius * module));
  const x0 = Math.max(0, Math.floor(at.x - r));
  const x1 = Math.min(width - 1, Math.ceil(at.x + r));
  const y0 = Math.max(0, Math.floor(at.y - r));
  const y1 = Math.min(height - 1, Math.ceil(at.y + r));
  const near = (c: readonly number[]) => c.every((v) => Math.abs(v - module) < module / 2);
  let best: Point | null = null;
  let bestDistance = Infinity;
  for (let y = y0; y <= y1; y++) {
    // light, dark, light runs of about a module each.
    const c = [0, 0, 0];
    let state = 0;
    let x = x0;
    while (x <= x1 && bits[y * width + x]) x++;
    for (; x <= x1; x++) {
      const dark = bits[y * width + x] === 1;
      if (dark === (state === 1)) c[state]!++;
      else if (state === 2) {
        if (near(c)) {
          const cx = x - c[2]! - c[1]! / 2;
          const cy = crossCheckAlignment(bits, width, height, Math.floor(cx), y, module);
          if (!Number.isNaN(cy)) {
            const d = Math.hypot(cx - at.x, cy - at.y);
            if (d < bestDistance) {
              bestDistance = d;
              best = { x: cx, y: cy };
            }
          }
        }
        c[0] = c[2]!;
        c[1] = 1;
        c[2] = 0;
        state = 1;
      } else {
        state++;
        c[state]!++;
      }
    }
  }
  return best;
}

function crossCheckAlignment(bits: Uint8Array, width: number, height: number, cx: number, cy: number, module: number): number {
  const at = (y: number) => bits[y * width + cx] === 1;
  if (!at(cy)) return NaN;
  const max = 2 * module;
  let up = cy;
  while (up > 0 && at(up - 1) && cy - up < max) up--;
  let down = cy;
  while (down < height - 1 && at(down + 1) && down - cy < max) down++;
  const centre = down - up + 1;
  let lightUp = 0;
  for (let y = up - 1; y >= 0 && !at(y) && lightUp <= max; y--) lightUp++;
  let lightDown = 0;
  for (let y = down + 1; y < height && !at(y) && lightDown <= max; y++) lightDown++;
  const ok = (v: number) => Math.abs(v - module) < module / 2;
  return ok(centre) && ok(lightUp) && ok(lightDown) ? (up + down) / 2 : NaN;
}

// ── 4–7. Read the grid ─────────────────────────────────────────────────

function decodeAt(bits: Uint8Array, width: number, height: number, { tl, tr, bl }: Triple): QrResult | null {
  const module = (tl.size + tr.size + bl.size) / 3;
  const across = (dist(tl, tr) + dist(tl, bl)) / 2 / module + 7;
  const estimate = Math.min(40, Math.max(1, Math.round((across - 17) / 4)));
  const tried = new Set<number>();
  for (const version of [estimate, estimate + 1, estimate - 1, estimate + 2, estimate - 2]) {
    if (version < 1 || version > 40 || tried.has(version)) continue;
    tried.add(version);
    for (const transform of transforms(bits, width, height, tl, tr, bl, version, module)) {
      const result = readGrid(bits, width, height, transform, version);
      if (result) return result;
    }
  }
  return null;
}

function* transforms(bits: Uint8Array, width: number, height: number, tl: Point, tr: Point, bl: Point, version: number, module: number): Generator<Transform> {
  const size = 17 + 4 * version;
  const br: Point = { x: tr.x - tl.x + bl.x, y: tr.y - tl.y + bl.y };
  const grid3 = (p: number) => p + 0.5;
  if (version >= 2) {
    // The bottom-right alignment pattern sits three modules in from that corner's finder position.
    const k = 1 - 3 / (size - 7);
    const guess = { x: tl.x + k * (br.x - tl.x), y: tl.y + k * (br.y - tl.y) };
    for (const radius of [4, 8, 16]) {
      const found = findAlignment(bits, width, height, guess, module, radius);
      if (found) {
        yield gridToImage(
          [
            { x: grid3(3), y: grid3(3) },
            { x: grid3(size - 4), y: grid3(3) },
            { x: grid3(size - 7), y: grid3(size - 7) },
            { x: grid3(3), y: grid3(size - 4) },
          ],
          [tl, tr, found, bl],
        );
        break;
      }
    }
  }
  // Without an alignment pattern: the parallelogram the three finders span.
  yield gridToImage(
    [
      { x: grid3(3), y: grid3(3) },
      { x: grid3(size - 4), y: grid3(3) },
      { x: grid3(size - 4), y: grid3(size - 4) },
      { x: grid3(3), y: grid3(size - 4) },
    ],
    [tl, tr, br, bl],
  );
}

function sample(bits: Uint8Array, width: number, height: number, t: Transform, size: number): Uint8Array | null {
  const grid = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = apply(t, x + 0.5, y + 0.5);
      const px = Math.floor(p.x);
      const py = Math.floor(p.y);
      if (px < 0 || py < 0 || px >= width || py >= height) return null;
      grid[y * size + x] = bits[py * width + px]!;
    }
  }
  return grid;
}

const LEVEL_BY_BITS: readonly EcLevel[] = ['M', 'L', 'H', 'Q'];
const LEVEL_INDEX: Record<EcLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };

function bch(data: number, poly: number, polyDegree: number): number {
  let rem = data;
  for (let i = 0; i < polyDegree; i++) rem = (rem << 1) ^ ((rem >>> (polyDegree - 1)) * poly);
  return (data << polyDegree) | (rem & ((1 << polyDegree) - 1));
}

const FORMAT_CODES = Array.from({ length: 32 }, (_, d) => bch(d, 0x537, 10) ^ 0x5412);
const VERSION_CODES = Array.from({ length: 41 }, (_, v) => (v >= 7 ? bch(v, 0x1f25, 12) : -1));

function popcount(n: number): number {
  let c = 0;
  for (let v = n; v; v &= v - 1) c++;
  return c;
}

function nearest(codes: readonly number[], read: number, maxDistance: number): number {
  let best = -1;
  let bestD = maxDistance + 1;
  codes.forEach((code, i) => {
    if (code < 0) return;
    const d = popcount(code ^ read);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

function readFormat(grid: Uint8Array, size: number): { level: EcLevel; mask: number } | null {
  const at = (x: number, y: number) => grid[y * size + x]!;
  let a = 0;
  let b = 0;
  // Bit i of the 15, in the two places the standard puts it.
  for (let i = 0; i < 15; i++) {
    const [x1, y1] = i <= 5 ? [8, i] : i === 6 ? [8, 7] : i === 7 ? [8, 8] : i === 8 ? [7, 8] : [14 - i, 8];
    const [x2, y2] = i < 8 ? [size - 1 - i, 8] : [8, size - 15 + i];
    a |= at(x1, y1) << i;
    b |= at(x2, y2) << i;
  }
  const da = nearest(FORMAT_CODES, a, 3);
  const db = nearest(FORMAT_CODES, b, 3);
  const pick = da >= 0 && (db < 0 || popcount(FORMAT_CODES[da]! ^ a) <= popcount(FORMAT_CODES[db]! ^ b)) ? da : db;
  if (pick < 0) return null;
  return { level: LEVEL_BY_BITS[pick >> 3]!, mask: pick & 7 };
}

function readVersion(grid: Uint8Array, size: number): number {
  let a = 0;
  let b = 0;
  for (let i = 0; i < 18; i++) {
    const p = size - 11 + (i % 3);
    const q = Math.floor(i / 3);
    a |= grid[q * size + p]! << i;
    b |= grid[p * size + q]! << i;
  }
  const va = nearest(VERSION_CODES, a, 3);
  return va >= 0 ? va : nearest(VERSION_CODES, b, 3);
}

function functionModules(version: number): Uint8Array {
  const size = 17 + 4 * version;
  const f = new Uint8Array(size * size);
  const mark = (x: number, y: number, w: number, h: number) => {
    for (let yy = Math.max(0, y); yy < Math.min(size, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(size, x + w); xx++) f[yy * size + xx] = 1;
  };
  mark(0, 0, 9, 9);
  mark(size - 8, 0, 8, 9);
  mark(0, size - 8, 9, 8);
  mark(6, 0, 1, size);
  mark(0, 6, size, 1);
  const pos = ALIGNMENT[version - 1]!;
  for (const ay of pos) {
    for (const ax of pos) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === size - 7) || (ax === size - 7 && ay === 6)) continue;
      mark(ax - 2, ay - 2, 5, 5);
    }
  }
  if (version >= 7) {
    mark(size - 11, 0, 3, 6);
    mark(0, size - 11, 6, 3);
  }
  return f;
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function readGrid(bits: Uint8Array, width: number, height: number, transform: Transform, version: number): QrResult | null {
  const size = 17 + 4 * version;
  const grid = sample(bits, width, height, transform, size);
  if (!grid) return null;
  // From version 7 the symbol says its version; a wrong guess is refused here and the next one tried.
  if (version >= 7 && readVersion(grid, size) !== version) return null;
  const format = readFormat(grid, size);
  if (!format) return null;
  const fn = functionModules(version);
  const mask = MASKS[format.mask]!;
  const [ec, b1, d1, b2, d2] = EC_BLOCKS[version - 1]![LEVEL_INDEX[format.level]]!;
  const total = b1 * (d1 + ec) + b2 * (d2 + ec);
  const codewords = new Uint8Array(total);
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fn[y * size + x] || bit >= total * 8) continue;
        const v = grid[y * size + x]! ^ (mask(x, y) ? 1 : 0);
        if (v) codewords[bit >> 3]! |= 0x80 >> (bit & 7);
        bit++;
      }
    }
  }
  // Undo the interleaving: data codewords column by column, then the EC ones.
  const blocks: { data: number; cw: Uint8Array }[] = [];
  for (let i = 0; i < b1; i++) blocks.push({ data: d1, cw: new Uint8Array(d1 + ec) });
  for (let i = 0; i < b2; i++) blocks.push({ data: d2, cw: new Uint8Array(d2 + ec) });
  let p = 0;
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data) b.cw[i] = codewords[p++]!;
  for (let i = 0; i < ec; i++) for (const b of blocks) b.cw[b.data + i] = codewords[p++]!;
  const data: number[] = [];
  let corrected = 0;
  for (const b of blocks) {
    const fixed = rsCorrect(b.cw, ec);
    if (fixed < 0) return null;
    if (fixed > 0) corrected++;
    for (let i = 0; i < b.data; i++) data.push(b.cw[i]!);
  }
  const text = readSegments(Uint8Array.from(data), version);
  if (text === null) return null;
  return { text, version, level: format.level, corrected };
}

// ── Reed–Solomon over GF(256), x^8 + x^4 + x^3 + x^2 + 1 ───────────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}
const gmul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);
const ginv = (a: number) => EXP[255 - LOG[a]!]!;

/** Polynomials as coefficient arrays, highest degree first, without leading zeros. */
type Poly = number[];
const trim = (p: Poly): Poly => {
  let i = 0;
  while (i < p.length - 1 && p[i] === 0) i++;
  return p.slice(i);
};
const degree = (p: Poly) => p.length - 1;
const isZero = (p: Poly) => p.length === 1 && p[0] === 0;
const coef = (p: Poly, d: number) => p[p.length - 1 - d]!;
function padd(a: Poly, b: Poly): Poly {
  const out = new Array<number>(Math.max(a.length, b.length)).fill(0);
  for (let i = 0; i < a.length; i++) out[out.length - a.length + i] ^= a[i]!;
  for (let i = 0; i < b.length; i++) out[out.length - b.length + i] ^= b[i]!;
  return trim(out);
}
function pmul(a: Poly, b: Poly): Poly {
  if (isZero(a) || isZero(b)) return [0];
  const out = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] ^= gmul(a[i]!, b[j]!);
  return trim(out);
}
const pscale = (a: Poly, s: number): Poly => trim(a.map((c) => gmul(c, s)));
const monomial = (d: number, c: number): Poly => (c === 0 ? [0] : [c, ...new Array<number>(d).fill(0)]);
function peval(p: Poly, x: number): number {
  if (x === 0) return coef(p, 0);
  let r = 0;
  for (const c of p) r = gmul(r, x) ^ c;
  return r;
}

/**
 * Correct a block in place; returns how many symbols it changed, or -1 when
 * there are more errors than the block can carry (half its EC codewords).
 * Syndromes at α^0 … α^(ec−1) — QR's generator starts at α^0 — then the
 * Euclidean algorithm for locator and evaluator, Chien search, Forney.
 */
function rsCorrect(block: Uint8Array, ec: number): number {
  const received = Array.from(block);
  const syndrome = new Array<number>(ec);
  let clean = true;
  for (let i = 0; i < ec; i++) {
    const s = peval(received, EXP[i]!);
    syndrome[ec - 1 - i] = s;
    if (s !== 0) clean = false;
  }
  if (clean) return 0;
  let rLast: Poly = monomial(ec, 1);
  let r: Poly = trim(syndrome);
  if (degree(rLast) < degree(r)) [rLast, r] = [r, rLast];
  let tLast: Poly = [0];
  let t: Poly = [1];
  // The integer half, as the algorithm states it: odd EC counts exist (7, 13, 15, 17).
  while (degree(r) >= Math.floor(ec / 2)) {
    const rLastLast = rLast;
    const tLastLast = tLast;
    rLast = r;
    tLast = t;
    if (isZero(rLast)) return -1;
    r = rLastLast;
    let q: Poly = [0];
    const lead = ginv(coef(rLast, degree(rLast)));
    while (degree(r) >= degree(rLast) && !isZero(r)) {
      const diff = degree(r) - degree(rLast);
      const scale = gmul(coef(r, degree(r)), lead);
      q = padd(q, monomial(diff, scale));
      r = padd(r, [...pscale(rLast, scale), ...new Array<number>(diff).fill(0)]);
    }
    t = padd(pmul(q, tLast), tLastLast);
    if (degree(r) >= degree(rLast)) return -1;
  }
  const at0 = coef(t, 0);
  if (at0 === 0) return -1;
  const sigma = pscale(t, ginv(at0));
  const omega = pscale(r, ginv(at0));
  const errors = degree(sigma);
  const locations: number[] = [];
  if (errors === 1) locations.push(coef(sigma, 1));
  else for (let i = 1; i < 256 && locations.length < errors; i++) if (peval(sigma, i) === 0) locations.push(ginv(i));
  if (locations.length !== errors) return -1;
  for (let i = 0; i < errors; i++) {
    const xiInverse = ginv(locations[i]!);
    let denominator = 1;
    for (let j = 0; j < errors; j++) if (j !== i) denominator = gmul(denominator, gmul(locations[j]!, xiInverse) ^ 1);
    const magnitude = gmul(peval(omega, xiInverse), ginv(denominator));
    const position = block.length - 1 - LOG[locations[i]!]!;
    if (position < 0) return -1;
    block[position]! ^= magnitude;
  }
  // A block past its capacity can "correct" into another codeword; the
  // syndromes of a true one are zero.
  const fixed = Array.from(block);
  for (let i = 0; i < ec; i++) if (peval(fixed, EXP[i]!) !== 0) return -1;
  return errors;
}

// ── Segments ────────────────────────────────────────────────────────────

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function readSegments(data: Uint8Array, version: number): string | null {
  let pos = 0;
  const left = () => data.length * 8 - pos;
  const read = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) v = (v << 1) | ((data[pos >> 3]! >> (7 - (pos & 7))) & 1);
    return v;
  };
  const range = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  let out = '';
  let eci: number | null = null;
  while (left() >= 4) {
    const mode = read(4);
    if (mode === 0) break;
    if (mode === 0b0111) {
      // ECI: 1, 2 or 3 bytes, by the leading bits.
      const first = read(8);
      eci = (first & 0x80) === 0 ? first : (first & 0xc0) === 0x80 ? ((first & 0x3f) << 8) | read(8) : ((first & 0x1f) << 16) | read(16);
      continue;
    }
    if (mode === 0b0011) {
      // Structured append: this symbol's place in a series. The text is still this symbol's.
      read(16);
      continue;
    }
    if (mode === 0b0101 || mode === 0b1001) {
      if (mode === 0b1001) read(8);
      continue;
    }
    if (mode === 0b0001) {
      let n = read([10, 12, 14][range]!);
      while (n >= 3) {
        if (left() < 10) return null;
        out += String(read(10)).padStart(3, '0');
        n -= 3;
      }
      if (n === 2) out += String(read(7)).padStart(2, '0');
      else if (n === 1) out += String(read(4));
    } else if (mode === 0b0010) {
      let n = read([9, 11, 13][range]!);
      while (n >= 2) {
        const v = read(11);
        out += ALNUM[Math.floor(v / 45)]! + ALNUM[v % 45]!;
        n -= 2;
      }
      if (n === 1) out += ALNUM[read(6)]!;
    } else if (mode === 0b0100) {
      const n = read([8, 16, 16][range]!);
      if (left() < n * 8) return null;
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = read(8);
      out += decodeBytes(bytes, eci);
    } else if (mode === 0b1000) {
      const n = read([8, 10, 12][range]!);
      const bytes = new Uint8Array(n * 2);
      for (let i = 0; i < n; i++) {
        const v = read(13);
        const c = Math.floor(v / 0xc0) * 0x100 + (v % 0xc0);
        const sjis = c + (c < 0x1f00 ? 0x8140 : 0xc140);
        bytes[2 * i] = sjis >> 8;
        bytes[2 * i + 1] = sjis & 0xff;
      }
      try {
        out += new TextDecoder('shift_jis').decode(bytes);
      } catch {
        return null;
      }
    } else return null;
  }
  return out;
}

/**
 * Byte segments: as the ECI says (26 = UTF-8, 3 = ISO-8859-1); without one,
 * UTF-8 when the bytes are valid UTF-8 — what nearly every encoder writes —
 * and ISO-8859-1, the standard's default, otherwise.
 */
function decodeBytes(bytes: Uint8Array, eci: number | null): string {
  if (eci === 3 || eci === 1) return latin1(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return latin1(bytes);
  }
}

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');
