/** "2026-02-18 11:05" from an ISO timestamp. */
export function formatDateTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}`;
}

/** "2026-02-18" from an ISO timestamp. */
export function formatDate(iso: string): string {
  return iso ? iso.slice(0, 10) : '—';
}
