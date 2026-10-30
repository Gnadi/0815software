export { fmtEur } from '../shared/money';

const pad = (n: number): string => String(n).padStart(2, '0');

/** "2026-07-09": the day `date` falls on in the viewer's time zone. */
export function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The instant of an ISO timestamp, or null for a plain date. Timestamps are
 * stored in UTC; shown as they are, an invoice cancelled at 00:30 read as
 * cancelled the day before.
 */
function instantOf(iso: string): Date | null {
  if (!iso.includes('T')) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "2026-07-09 09:25" from an ISO timestamp, in the viewer's time zone. */
export function fmtDateTime(iso: string): string {
  const date = instantOf(iso);
  if (date === null) return iso.replace('T', ' ').replace(/(:\d{2})?Z$/, '').slice(0, 16);
  return `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "2026-07-09" from a date, or from an ISO timestamp in the viewer's time zone. */
export function fmtDate(iso: string): string {
  const date = instantOf(iso);
  return date === null ? iso.slice(0, 10) : localDate(date);
}

/** "12", "2.5" — quantities without float noise. */
export function fmtQty(n: number): string {
  // Four decimals, as the e-invoice states the quantity — three hid one.
  return String(Math.round(n * 10_000) / 10_000);
}

/**
 * Parse a EUR amount typed by a human ("1200", "12,50", "12.50") into
 * integer cents. Returns null for anything that is not a plain amount.
 */
export function parseEurToCents(raw: string): number | null {
  const cleaned = raw.trim().replace(',', '.');
  if (cleaned === '' || !/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/** Integer cents → editable text ("1234" → "12.34"). */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}
