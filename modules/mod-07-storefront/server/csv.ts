import type { OrderRow } from '../shared/types.js';

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
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
