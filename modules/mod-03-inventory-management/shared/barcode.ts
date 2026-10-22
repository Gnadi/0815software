/**
 * Barcodes, as bars — shared by the label the client prints and the tests.
 *
 * Two symbologies, chosen per product:
 *
 * - **GTIN** (EAN-13, EAN-8, UPC-A) when the product carries a manufacturer
 *   number. The last digit is the GS1 mod-10 check digit, which is what a
 *   scanner verifies, so a mistyped number is refused when it is entered.
 * - **Code 128** of the SKU otherwise — every product gets a scannable label,
 *   with or without a GTIN.
 *
 * Output is a string of modules, "1" bar and "0" space, which the label
 * draws as SVG. `test/barcode.test.ts` pins every encoder against vectors from
 * python-barcode, an independent implementation, rather than our own idea of
 * the standard.
 */

/** GS1 mod-10 check digit for a GTIN body (all digits but the check digit). */
export function gtinCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10;
}

/** A GTIN-8, -12, -13 or -14 whose check digit is right. */
export function isValidGtin(code: string): boolean {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return false;
  return gtinCheckDigit(code.slice(0, -1)) === Number(code.at(-1));
}

// ── EAN / UPC ───────────────────────────────────────────────────────────

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = L.map((p) => [...p].reverse().map((b) => (b === '1' ? '0' : '1')).join(''));
const R = L.map((p) => [...p].map((b) => (b === '1' ? '0' : '1')).join(''));
/** Which left-half digits use G instead of L, keyed by EAN-13's first digit. */
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

export function ean13Modules(code: string): string {
  if (!/^\d{13}$/.test(code) || !isValidGtin(code)) throw new Error(`Not a valid EAN-13: ${code}`);
  const parity = PARITY[Number(code[0])]!;
  let out = '101';
  for (let i = 1; i <= 6; i++) out += (parity[i - 1] === 'L' ? L : G)[Number(code[i])];
  out += '01010';
  for (let i = 7; i <= 12; i++) out += R[Number(code[i])];
  return `${out}101`;
}

export function ean8Modules(code: string): string {
  if (!/^\d{8}$/.test(code) || !isValidGtin(code)) throw new Error(`Not a valid EAN-8: ${code}`);
  let out = '101';
  for (let i = 0; i < 4; i++) out += L[Number(code[i])];
  out += '01010';
  for (let i = 4; i < 8; i++) out += R[Number(code[i])];
  return `${out}101`;
}

/** UPC-A is EAN-13 with a leading zero — the same bars. */
export function upcaModules(code: string): string {
  if (!/^\d{12}$/.test(code)) throw new Error(`Not a valid UPC-A: ${code}`);
  return ean13Modules(`0${code}`);
}

// ── Code 128 ────────────────────────────────────────────────────────────

/** Bar/space widths of symbol values 0–105 (ISO/IEC 15417, table 1). */
const C128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212',
  '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321',
  '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212',
  '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232',
];
const STOP = '2331112';
const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;

function widthsToModules(widths: string): string {
  let out = '';
  [...widths].forEach((w, i) => (out += (i % 2 === 0 ? '1' : '0').repeat(Number(w))));
  return out;
}

/** Length of the run of digits starting at `pos`. */
function digitRun(text: string, pos: number): number {
  let n = 0;
  while (pos + n < text.length && text[pos + n]! >= '0' && text[pos + n]! <= '9') n++;
  return n;
}

/**
 * The symbol values for `text`: set B for printable ASCII, set C (two digits
 * per symbol) for runs of four or more digits — shorter labels for numeric
 * SKUs, the usual rule of thumb (ISO/IEC 15417 Annex E).
 */
export function code128Values(text: string): number[] {
  if (text.length === 0 || ![...text].every((c) => c >= ' ' && c <= '~')) {
    throw new Error('Code 128 here encodes printable ASCII only');
  }
  const values: number[] = [];
  let set: 'B' | 'C' = digitRun(text, 0) >= 4 ? 'C' : 'B';
  values.push(set === 'C' ? START_C : START_B);
  let pos = 0;
  while (pos < text.length) {
    const run = digitRun(text, pos);
    if (set === 'B' && run >= 4) {
      values.push(CODE_C);
      set = 'C';
    }
    if (set === 'C') {
      if (run >= 2) {
        values.push(Number(text.slice(pos, pos + 2)));
        pos += 2;
        continue;
      }
      values.push(CODE_B);
      set = 'B';
    }
    values.push(text.charCodeAt(pos) - 32);
    pos += 1;
  }
  const check = values.reduce((sum, v, i) => sum + v * (i === 0 ? 1 : i), 0) % 103;
  return [...values, check];
}

export function code128Modules(text: string): string {
  return code128Values(text).map((v) => widthsToModules(C128[v]!)).join('') + widthsToModules(STOP);
}

// ── Choosing ────────────────────────────────────────────────────────────

export interface Barcode {
  symbology: 'EAN-13' | 'EAN-8' | 'UPC-A' | 'Code 128';
  /** What is printed under the bars. */
  text: string;
  modules: string;
}

/** The label barcode for a product: its GTIN when it has one, its SKU in Code 128 otherwise. */
export function productBarcode(product: { sku: string; barcode: string | null }): Barcode {
  const gtin = product.barcode;
  if (gtin && isValidGtin(gtin)) {
    if (gtin.length === 13) return { symbology: 'EAN-13', text: gtin, modules: ean13Modules(gtin) };
    if (gtin.length === 8) return { symbology: 'EAN-8', text: gtin, modules: ean8Modules(gtin) };
    if (gtin.length === 12) return { symbology: 'UPC-A', text: gtin, modules: upcaModules(gtin) };
  }
  return { symbology: 'Code 128', text: product.sku, modules: code128Modules(product.sku) };
}
