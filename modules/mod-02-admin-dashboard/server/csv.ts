import type { ResourceDef } from '../shared/resources.js';

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) return `"${str.replaceAll('"', '""')}"`;
  return str;
}

/** Render rows as RFC-4180 CSV with a header line (id + configured fields). */
export function toCsv(resource: ResourceDef, rows: Record<string, unknown>[]): string {
  const columns = ['id', ...resource.fields.map((f) => f.name)];
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((col) => escapeCell(row[col])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
