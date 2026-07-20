import type { OfferRow } from '../shared/types.js';

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
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
