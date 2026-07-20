/** "2026-07-09 09:25" from an ISO timestamp. */
export function fmtDateTime(iso: string): string {
  return iso.replace('T', ' ').replace(/(:\d{2})?Z$/, '').slice(0, 16);
}

/** "2026-07-09" from an ISO timestamp or date. */
export function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Compact human duration for SLA targets: 30 → "30m", 240 → "4h", 1920 → "32h". */
export function fmtMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Signed relative time from now to an ISO instant, e.g. "in 12m",
 * "3h ago". Used to render SLA due/breach distances.
 */
export function fmtRelative(iso: string, now: number = Date.now()): string {
  const deltaMin = Math.round((Date.parse(iso) - now) / 60_000);
  const abs = Math.abs(deltaMin);
  const unit = abs < 60 ? `${abs}m` : abs < 60 * 48 ? `${Math.round(abs / 60)}h` : `${Math.round(abs / 1440)}d`;
  if (deltaMin === 0) return 'now';
  return deltaMin > 0 ? `in ${unit}` : `${unit} ago`;
}

const SLA_LABELS: Record<string, string> = {
  met: 'MET',
  breached: 'BREACHED',
  at_risk: 'AT RISK',
  pending: 'PENDING',
};

export function slaLabel(state: string): string {
  return SLA_LABELS[state] ?? state.toUpperCase();
}
