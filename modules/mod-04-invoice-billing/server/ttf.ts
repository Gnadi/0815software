/**
 * Just enough TrueType to embed a font in a PDF/A — read the metrics a font
 * descriptor needs, map characters to glyphs, and cut the font down to the
 * glyphs a document actually uses.
 *
 * PDF/A forbids relying on a viewer's fonts: every glyph shown must be in the
 * file. Embedding the whole of Liberation Sans would add 400 KB to each
 * invoice, so the font is SUBSET: glyph ids stay as they are (the cmap, the
 * metrics and the PDF's /Widths keep pointing at the same numbers), and every
 * glyph the document does not use is emptied. The `glyf` table is nearly the
 * whole file, so that alone brings a font from 400 KB to a few dozen.
 *
 * Only what that needs is implemented: the `cmap` (3,1) format 4 subtable,
 * long and short `loca`, and composite glyphs (an "Ä" is an "A" plus a
 * diaeresis, and both must survive). Hinting tables are kept; layout tables
 * (GSUB, GPOS, kern) are dropped — the PDF positions every glyph itself.
 */

interface TableRecord {
  offset: number;
  length: number;
}

const KEEP = ['cmap', 'cvt ', 'fpgm', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'OS/2', 'post', 'prep'];

export class TrueTypeFont {
  readonly unitsPerEm: number;
  readonly bbox: [number, number, number, number];
  readonly ascent: number;
  readonly descent: number;
  readonly capHeight: number;
  readonly italicAngle: number;
  readonly fixedPitch: boolean;
  readonly bold: boolean;
  readonly postscriptName: string;
  private readonly tables = new Map<string, TableRecord>();
  private readonly advances: number[] = [];
  private readonly numGlyphs: number;
  private readonly glyphOffsets: number[] = [];
  private readonly cmap = new Map<number, number>();

  constructor(private readonly data: Buffer) {
    const numTables = data.readUInt16BE(4);
    for (let i = 0; i < numTables; i++) {
      const at = 12 + i * 16;
      this.tables.set(data.toString('latin1', at, at + 4), {
        offset: data.readUInt32BE(at + 8),
        length: data.readUInt32BE(at + 12),
      });
    }
    const head = this.table('head');
    this.unitsPerEm = data.readUInt16BE(head + 18);
    this.bbox = [data.readInt16BE(head + 36), data.readInt16BE(head + 38), data.readInt16BE(head + 40), data.readInt16BE(head + 42)];
    const longLoca = data.readInt16BE(head + 50) === 1;

    this.numGlyphs = data.readUInt16BE(this.table('maxp') + 4);

    const hhea = this.table('hhea');
    const numberOfHMetrics = data.readUInt16BE(hhea + 34);
    const hmtx = this.table('hmtx');
    let last = 0;
    for (let g = 0; g < this.numGlyphs; g++) {
      if (g < numberOfHMetrics) last = data.readUInt16BE(hmtx + g * 4);
      this.advances.push(last);
    }

    const os2 = this.table('OS/2');
    this.ascent = data.readInt16BE(os2 + 68);
    this.descent = data.readInt16BE(os2 + 70);
    this.capHeight = data.readUInt16BE(os2) >= 2 ? data.readInt16BE(os2 + 88) : this.ascent;
    this.bold = data.readUInt16BE(os2 + 4) >= 600;

    const post = this.table('post');
    this.italicAngle = data.readInt32BE(post + 4) / 65536;
    this.fixedPitch = data.readUInt32BE(post + 12) !== 0;

    const loca = this.table('loca');
    for (let g = 0; g <= this.numGlyphs; g++) {
      this.glyphOffsets.push(longLoca ? data.readUInt32BE(loca + g * 4) : data.readUInt16BE(loca + g * 2) * 2);
    }

    this.readCmap();
    this.postscriptName = this.readPostscriptName();
  }

  private table(tag: string): number {
    const record = this.tables.get(tag);
    if (!record) throw new Error(`TrueType font has no ${tag} table`);
    return record.offset;
  }

  /** The (3,1) Windows Unicode BMP subtable, format 4. */
  private readCmap(): void {
    const d = this.data;
    const cmap = this.table('cmap');
    const count = d.readUInt16BE(cmap + 2);
    let sub = -1;
    for (let i = 0; i < count; i++) {
      const at = cmap + 4 + i * 8;
      if (d.readUInt16BE(at) === 3 && d.readUInt16BE(at + 2) === 1) sub = cmap + d.readUInt32BE(at + 4);
    }
    if (sub < 0 || d.readUInt16BE(sub) !== 4) throw new Error('TrueType font has no (3,1) format 4 cmap');
    const segCount = d.readUInt16BE(sub + 6) / 2;
    const ends = sub + 14;
    const starts = ends + segCount * 2 + 2;
    const deltas = starts + segCount * 2;
    const ranges = deltas + segCount * 2;
    for (let s = 0; s < segCount; s++) {
      const end = d.readUInt16BE(ends + s * 2);
      const start = d.readUInt16BE(starts + s * 2);
      const delta = d.readInt16BE(deltas + s * 2);
      const rangeAt = ranges + s * 2;
      const rangeOffset = d.readUInt16BE(rangeAt);
      // Only the Latin-1 / WinAnsi region matters to this writer.
      for (let c = start; c <= end && c <= 0x2122; c++) {
        if (c === 0xffff) break;
        let glyph: number;
        if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
        else {
          glyph = d.readUInt16BE(rangeAt + rangeOffset + (c - start) * 2);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph !== 0) this.cmap.set(c, glyph);
      }
    }
  }

  private readPostscriptName(): string {
    const d = this.data;
    const name = this.table('name');
    const count = d.readUInt16BE(name + 2);
    const strings = name + d.readUInt16BE(name + 4);
    for (let i = 0; i < count; i++) {
      const at = name + 6 + i * 12;
      if (d.readUInt16BE(at + 6) !== 6) continue;
      const length = d.readUInt16BE(at + 8);
      const offset = strings + d.readUInt16BE(at + 10);
      const platform = d.readUInt16BE(at);
      const raw = d.subarray(offset, offset + length);
      const text = platform === 3 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1');
      return text.replace(/[^A-Za-z0-9-]/g, '');
    }
    return 'Font';
  }

  glyphOf(unicode: number): number {
    return this.cmap.get(unicode) ?? 0;
  }

  /** Advance width in PDF text space units (1/1000 em). */
  width(glyph: number): number {
    return Math.round(((this.advances[glyph] ?? 0) * 1000) / this.unitsPerEm);
  }

  /** In font units → PDF units (1/1000 em). */
  scale(value: number): number {
    return Math.round((value * 1000) / this.unitsPerEm);
  }

  private glyphData(glyph: number): Buffer {
    const glyf = this.table('glyf');
    return this.data.subarray(glyf + this.glyphOffsets[glyph]!, glyf + this.glyphOffsets[glyph + 1]!);
  }

  /** The glyphs a composite glyph is built from (and theirs, recursively). */
  private components(glyph: number, into: Set<number>): void {
    const g = this.glyphData(glyph);
    if (g.length < 10 || g.readInt16BE(0) >= 0) return;
    let at = 10;
    for (;;) {
      const flags = g.readUInt16BE(at);
      const component = g.readUInt16BE(at + 2);
      if (!into.has(component)) {
        into.add(component);
        this.components(component, into);
      }
      at += 4 + (flags & 0x0001 ? 4 : 2);
      if (flags & 0x0008) at += 2;
      else if (flags & 0x0040) at += 4;
      else if (flags & 0x0080) at += 8;
      if (!(flags & 0x0020)) break;
    }
  }

  /**
   * A copy of the font in which only `glyphs` (plus .notdef and whatever they
   * are composed of) still have outlines. Deterministic: the same glyph set
   * always yields the same bytes.
   */
  subset(glyphs: Iterable<number>): Buffer {
    const keep = new Set<number>([0]);
    for (const g of glyphs) {
      keep.add(g);
      this.components(g, keep);
    }

    const glyfParts: Buffer[] = [];
    const loca = Buffer.alloc((this.numGlyphs + 1) * 4);
    let offset = 0;
    for (let g = 0; g < this.numGlyphs; g++) {
      loca.writeUInt32BE(offset, g * 4);
      if (!keep.has(g)) continue;
      const data = this.glyphData(g);
      const padded = Buffer.alloc((data.length + 3) & ~3);
      data.copy(padded);
      glyfParts.push(padded);
      offset += padded.length;
    }
    loca.writeUInt32BE(offset, this.numGlyphs * 4);

    const head = Buffer.from(this.raw('head'));
    head.writeUInt32BE(0, 8); // checkSumAdjustment, set below
    head.writeInt16BE(1, 50); // long loca

    const out = new Map<string, Buffer>();
    for (const tag of KEEP) {
      if (!this.tables.has(tag)) continue;
      if (tag === 'glyf') out.set(tag, Buffer.concat(glyfParts));
      else if (tag === 'loca') out.set(tag, loca);
      else if (tag === 'head') out.set(tag, head);
      // post 3.0: the same metrics without the glyph-name table — a third of
      // a subset's size, and a PDF viewer never reads glyph names.
      else if (tag === 'post') {
        const post = Buffer.from(this.raw(tag).subarray(0, 32));
        post.writeUInt32BE(0x00030000, 0);
        out.set(tag, post);
      }
      else out.set(tag, Buffer.from(this.raw(tag)));
    }
    return assemble(out);
  }

  private raw(tag: string): Buffer {
    const record = this.tables.get(tag)!;
    return this.data.subarray(record.offset, record.offset + record.length);
  }
}

function checksum(buffer: Buffer): number {
  const padded = buffer.length % 4 === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(4 - (buffer.length % 4))]);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

/** Write an sfnt from tables: directory sorted by tag, 4-byte aligned, checksums set. */
function assemble(tables: Map<string, Buffer>): Buffer {
  const tags = [...tables.keys()].sort();
  const count = tags.length;
  const pow = 2 ** Math.floor(Math.log2(count));
  const header = Buffer.alloc(12 + count * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(count, 4);
  header.writeUInt16BE(pow * 16, 6);
  header.writeUInt16BE(Math.log2(pow), 8);
  header.writeUInt16BE(count * 16 - pow * 16, 10);

  const bodies: Buffer[] = [];
  let offset = header.length;
  let headAt = -1;
  tags.forEach((tag, i) => {
    const data = tables.get(tag)!;
    const at = 12 + i * 16;
    header.write(tag, at, 'latin1');
    header.writeUInt32BE(checksum(data), at + 4);
    header.writeUInt32BE(offset, at + 8);
    header.writeUInt32BE(data.length, at + 12);
    if (tag === 'head') headAt = offset;
    const padded = Buffer.alloc((data.length + 3) & ~3);
    data.copy(padded);
    bodies.push(padded);
    offset += padded.length;
  });
  const font = Buffer.concat([header, ...bodies]);
  if (headAt >= 0) font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headAt + 8);
  return font;
}
