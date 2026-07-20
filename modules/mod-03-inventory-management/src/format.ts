/** "12", "12.5", "+12", "-3.25" — quantities without float noise. */
export function fmtQty(n: number, signed = false): string {
  const rounded = Math.round(n * 1000) / 1000;
  const str = String(rounded);
  return signed && rounded > 0 ? `+${str}` : str;
}

/** "2026-07-09 09:25" from an ISO timestamp. */
export function fmtDateTime(iso: string): string {
  return iso.replace('T', ' ').replace(/(:\d{2})?Z$/, '').slice(0, 16);
}

/** "2026-07-09" from an ISO timestamp. */
export function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}
