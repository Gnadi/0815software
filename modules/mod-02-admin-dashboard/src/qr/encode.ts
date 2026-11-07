import { ALIGNMENT, EC_BLOCKS, type EcLevel } from './tables';

/**
 * A QR code encoder (ISO/IEC 18004, Model 2) for the browser — the half that
 * shows a code: the authenticator QR at sign-in and in the account page.
 * Copy-in; the tables beside it are byte-identical to MOD-11's decoder tables.
 *
 * Why not a library: the encoder is a few hundred lines of arithmetic over a
 * table, and the obvious alternative — an image from a QR web service — would
 * send the two-factor SECRET to a stranger. It runs here, and it is checked
 * module for module against an independent encoder (segno) in MOD-11's
 * `test/qr-encode.test.ts`, and read back by MOD-11's decoder.
 *
 * One segment per symbol, in the densest mode the text allows: numeric,
 * alphanumeric, or bytes (UTF-8). No ECI, no Kanji, no structured append.
 */

export interface QrSymbol {
  size: number;
  version: number;
  level: EcLevel;
  mask: number;
  /** `modules[y][x]`, true = dark. */
  modules: boolean[][];
}

const LEVEL_INDEX: Record<EcLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };
const FORMAT_BITS: Record<EcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

type Mode = 'numeric' | 'alphanumeric' | 'byte';
type Charset = 'auto' | 'utf-8';
const MODE_BITS: Record<Mode, number> = { numeric: 1, alphanumeric: 2, byte: 4 };

function countBits(mode: Mode, version: number): number {
  const band = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  return { numeric: [10, 12, 14], alphanumeric: [9, 11, 13], byte: [8, 16, 16] }[mode][band]!;
}

class BitBuffer {
  bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

function segmentOf(text: string, charset: Charset): { mode: Mode; count: number; write: (b: BitBuffer) => void } {
  if (/^\d*$/.test(text)) {
    return {
      mode: 'numeric',
      count: text.length,
      write: (b) => {
        for (let i = 0; i < text.length; i += 3) {
          const chunk = text.slice(i, i + 3);
          b.put(Number(chunk), chunk.length * 3 + 1);
        }
      },
    };
  }
  if ([...text].every((c) => ALNUM.includes(c))) {
    return {
      mode: 'alphanumeric',
      count: text.length,
      write: (b) => {
        for (let i = 0; i + 1 < text.length; i += 2) b.put(ALNUM.indexOf(text[i]!) * 45 + ALNUM.indexOf(text[i + 1]!), 11);
        if (text.length % 2 === 1) b.put(ALNUM.indexOf(text[text.length - 1]!), 6);
      },
    };
  }
  // ISO-8859-1 is the standard's default for bytes, so text that fits it is
  // written as such and read right by every reader, ECI or not; anything
  // else is UTF-8, which is what readers assume without an ECI in practice.
  const latin1 = charset !== 'utf-8' && [...text].every((c) => c.charCodeAt(0) < 256);
  const bytes = latin1 ? Uint8Array.from([...text].map((c) => c.charCodeAt(0))) : new TextEncoder().encode(text);
  return { mode: 'byte', count: bytes.length, write: (b) => bytes.forEach((byte) => b.put(byte, 8)) };
}

function dataCodewords(version: number, level: EcLevel): number {
  const [, n1, d1, n2, d2] = EC_BLOCKS[version - 1]![LEVEL_INDEX[level]]!;
  return n1 * d1 + n2 * d2;
}

// ── Reed–Solomon over GF(2^8), polynomial 0x11D ────────────────────────

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < result.length) result[j] ^= result[j + 1]!;
    }
    root = gfMul(root, 2);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= gfMul(coef, factor)));
  }
  return result;
}

function withErrorCorrection(data: number[], version: number, level: EcLevel): number[] {
  const [ecLen, n1, d1, n2, d2] = EC_BLOCKS[version - 1]![LEVEL_INDEX[level]]!;
  const divisor = rsDivisor(ecLen);
  const blocks: { data: number[]; ec: number[] }[] = [];
  let k = 0;
  for (const [count, len] of [
    [n1, d1],
    [n2, d2],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const part = data.slice(k, k + len);
      k += len;
      blocks.push({ data: part, ec: rsRemainder(part, divisor) });
    }
  }
  const out: number[] = [];
  const longest = Math.max(d1, d2);
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]!);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]!);
  return out;
}

// ── Placement ──────────────────────────────────────────────────────────

class Grid {
  readonly modules: boolean[][];
  readonly fixed: boolean[][];
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  set(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.fixed[y]![x] = true;
  }
}

function drawFunctionPatterns(g: Grid, version: number): void {
  const size = g.size;
  for (let i = 0; i < size; i++) {
    g.set(6, i, i % 2 === 0);
    g.set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        g.set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const pos = ALIGNMENT[version - 1]!;
  const last = pos.length - 1;
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) g.set(pos[i]! + dx, pos[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormat(g, 'M', 0); // reserve; drawn for real once the mask is chosen
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.set(a, b, dark);
      g.set(b, a, dark);
    }
  }
}

function drawFormat(g: Grid, level: EcLevel, mask: number): void {
  const data = (FORMAT_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const size = g.size;
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(i));
  g.set(8, 7, bit(6));
  g.set(8, 8, bit(7));
  g.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.set(8, size - 15 + i, bit(i));
  g.set(8, size - 8, true);
}

function drawCodewords(g: Grid, codewords: number[]): void {
  const size = g.size;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!g.fixed[y]![x] && i < codewords.length * 8) {
          g.modules[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(g: Grid, mask: number): void {
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) if (!g.fixed[y]![x] && MASKS[mask]!(x, y)) g.modules[y]![x] = !g.modules[y]![x];
  }
}

/** ISO/IEC 18004 §7.8.3: the evaluation that picks the mask a reader finds easiest. */
function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < n; i++) {
    lines.push(m[i]!);
    lines.push(m.map((row) => row[i]!));
  }
  const finderLike = (line: boolean[], i: number) => {
    const p = [true, false, true, true, true, false, true];
    for (let k = 0; k < 7; k++) if (line[i + k] !== p[k]) return false;
    const light = (a: number, b: number) => {
      for (let k = a; k < b; k++) if (k >= 0 && k < n && line[k]) return false;
      return true;
    };
    return light(i - 4, i) || light(i + 7, i + 11);
  };
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    for (let i = 0; i + 7 <= n; i++) if (finderLike(line, i)) score += 40;
  }
  for (let y = 0; y + 1 < n; y++) {
    for (let x = 0; x + 1 < n; x++) {
      const c = m[y]![x];
      if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
    }
  }
  const dark = m.reduce((acc, row) => acc + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs((dark * 20) / (n * n) - 10)) * 10;
  return score;
}

export function encodeQr(
  text: string,
  opts: { level?: EcLevel; version?: number; mask?: number; charset?: Charset; eci?: number } = {},
): QrSymbol {
  const level = opts.level ?? 'M';
  const seg = segmentOf(text, opts.charset ?? 'auto');
  let version = opts.version ?? 0;
  const bitsFor = (v: number) => {
    const b = new BitBuffer();
    // An ECI designator (0–127 here) ahead of the segment says how its bytes are meant.
    if (opts.eci !== undefined) {
      b.put(7, 4);
      b.put(opts.eci, 8);
    }
    b.put(MODE_BITS[seg.mode], 4);
    b.put(seg.count, countBits(seg.mode, v));
    seg.write(b);
    return b;
  };
  if (!version) {
    for (let v = 1; v <= 40; v++) {
      if (bitsFor(v).bits.length <= dataCodewords(v, level) * 8) {
        version = v;
        break;
      }
    }
    if (!version) throw new Error('text too long for a QR code');
  }
  const capacity = dataCodewords(version, level) * 8;
  const buf = bitsFor(version);
  if (buf.bits.length > capacity) throw new Error(`text does not fit version ${version}-${level}`);
  buf.put(0, Math.min(4, capacity - buf.bits.length));
  buf.put(0, (8 - (buf.bits.length % 8)) % 8);
  for (let pad = 0xec; buf.bits.length < capacity; pad ^= 0xec ^ 0x11) buf.put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < buf.bits.length; i += 8) data.push(buf.bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));

  const size = version * 4 + 17;
  const build = (mask: number): Grid => {
    const g = new Grid(size);
    drawFunctionPatterns(g, version);
    drawCodewords(g, withErrorCorrection(data, version, level));
    applyMask(g, mask);
    drawFormat(g, level, mask);
    return g;
  };
  let mask = opts.mask ?? -1;
  let grid: Grid;
  if (mask >= 0) grid = build(mask);
  else {
    let best = Infinity;
    grid = build(0);
    for (let m = 0; m < 8; m++) {
      const g = build(m);
      const p = penalty(g.modules);
      if (p < best) {
        best = p;
        grid = g;
        mask = m;
      }
    }
  }
  return { size, version, level, mask, modules: grid.modules };
}

/** One SVG path for the dark modules, with a four-module quiet zone. */
export function qrSvgPath(symbol: QrSymbol): { viewBox: string; d: string } {
  const parts: string[] = [];
  symbol.modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + 4} ${y + 4}h1v1h-1z`);
    }),
  );
  return { viewBox: `0 0 ${symbol.size + 8} ${symbol.size + 8}`, d: parts.join('') };
}
