import type { StockRow, Warehouse } from '../shared/types.js';

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) return `"${str.replaceAll('"', '""')}"`;
  return str;
}

/**
 * Render the current stock levels as RFC-4180 CSV: one row per product,
 * one column per warehouse (by code), plus total and reorder point.
 */
export function stockCsv(warehouses: Warehouse[], rows: StockRow[]): string {
  const header = ['sku', 'name', 'unit', 'reorder_point', ...warehouses.map((w) => w.code), 'total'];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.sku,
        row.name,
        row.unit,
        row.reorder_point,
        ...warehouses.map((w) => row.levels[w.id] ?? 0),
        row.total,
      ]
        .map(escapeCell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
