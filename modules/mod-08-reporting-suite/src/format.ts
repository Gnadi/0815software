/** Render a cell value from a query/pivot result for display. */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value.toLocaleString('en-US') : String(value);
  }
  return String(value);
}

/** Render a nullable pivot number, blank for empty cells. */
export function pivotCell(value: number | null): string {
  if (value === null) return '';
  return Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : (Math.round(value * 100) / 100).toLocaleString('en-US');
}

/** Short human timestamp. */
export function ts(iso: string | null): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 19).replace('Z', '');
}
