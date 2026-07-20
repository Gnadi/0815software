import type { QueryResult } from '../shared/types.js';

/** RFC-4180 cell escaping with a fixed delimiter (comma). */
function escapeCell(value: unknown, delimiter: string): string {
  const s =
    value === null || value === undefined
      ? ''
      : typeof value === 'bigint'
        ? value.toString()
        : String(value);
  if (s.includes('"') || s.includes(delimiter) || /[\n\r]/.test(s)) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
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
