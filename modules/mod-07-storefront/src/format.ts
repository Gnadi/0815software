export { fmtEur } from '../shared/money';

/** "2026-07-09 09:25" from an ISO timestamp. */
export function fmtDateTime(iso: string): string {
  return iso.replace('T', ' ').replace(/(:\d{2})?Z$/, '').slice(0, 16);
}

/** "2026-07-09" from an ISO timestamp or date. */
export function fmtDate(iso: string): string {
  return iso.slice(0, 10);
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

/** "Desk Pad A2" → "DP" — monogram initials for the SVG placeholder mark. */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
