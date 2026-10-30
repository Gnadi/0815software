/**
 * The fonts behind the four the layout names (server/pdf.ts): Liberation Sans
 * and Mono (SIL OFL, metric-compatible with Helvetica and Courier, shipped in
 * assets/fonts). The PDF/A embeds them (server/pdfa.ts); the layout measures
 * text with them, so a line it wraps fits in the plain PDF, set in Helvetica
 * by the viewer, as it does in the PDF/A.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FontKey } from './pdf.js';
import { TrueTypeFont } from './ttf.js';

const FONT_FILES: Record<FontKey, string> = {
  F1: 'LiberationSans-Regular.ttf',
  F2: 'LiberationSans-Bold.ttf',
  F3: 'LiberationMono-Regular.ttf',
  F4: 'LiberationMono-Bold.ttf',
};

/** Windows-1252 bytes 0x80–0x9F → Unicode (the rest of 0x20–0xFF is Latin-1). */
const CP1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020,
  0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152,
  0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

/** The Unicode code point a WinAnsi code shows, or null for the five codes it leaves unassigned. */
export function unicodeOf(code: number): number | null {
  if (code >= 0x80 && code <= 0x9f) return CP1252[code] ?? null;
  return code;
}

const WIN_ANSI_OF = new Map<number, number>(Object.entries(CP1252).map(([code, unicode]) => [unicode, Number(code)]));

/**
 * The WinAnsi code that shows a Unicode code point, or null when it has none.
 * The inverse of `unicodeOf`, from the same table — the PDF writer used to
 * keep a second, shorter one, and Š, Ž, Œ and Ÿ came out as "?" (review N4).
 */
export function winAnsiOf(unicode: number): number | null {
  if ((unicode >= 0x20 && unicode < 0x7f) || (unicode >= 0xa0 && unicode <= 0xff)) return unicode;
  return WIN_ANSI_OF.get(unicode) ?? null;
}

/** assets/fonts, found from this file whether it runs from server/ or dist/server/server/. */
function fontDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'assets', 'fonts');
    if (existsSync(join(candidate, FONT_FILES.F1))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('assets/fonts not found — the PDF fonts ship with the module and must be deployed with it');
}

let loaded: Record<FontKey, TrueTypeFont> | null = null;
/** The four fonts, read once per process. */
export function fonts(): Record<FontKey, TrueTypeFont> {
  if (loaded === null) {
    const dir = fontDir();
    loaded = Object.fromEntries(
      (Object.keys(FONT_FILES) as FontKey[]).map((k) => [k, new TrueTypeFont(readFileSync(join(dir, FONT_FILES[k])))]),
    ) as Record<FontKey, TrueTypeFont>;
  }
  return loaded;
}
