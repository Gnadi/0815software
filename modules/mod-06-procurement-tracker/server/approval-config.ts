/**
 * Approval workflow configuration — THE one place approval rules live.
 *
 * The server derives a PO's required tiers from its total via
 * `requiredTiers()` at the moment it is submitted (and freezes them in
 * the append-only `po_submissions` snapshot); the client renders these
 * rules fetched from `GET /api/config`. Nothing else in the codebase
 * knows the thresholds — edit this file to change the workflow.
 *
 * Rules are checked in order; the first rule whose `maxTotalCents`
 * covers the PO total (inclusive) wins. The last rule must be the
 * catch-all (`maxTotalCents: null`). Tiers must be approved strictly in
 * ascending order — that ordering is enforced by the domain layer, the
 * config only says WHICH tiers a total needs.
 */

export interface ApprovalTier {
  tier: number;
  label: string;
}

export interface ApprovalRule {
  /** Inclusive upper bound for the PO total in cents; null = no bound. */
  maxTotalCents: number | null;
  /** Tiers required for totals in this bracket, ascending. */
  tiers: number[];
}

export const APPROVAL_TIERS: ApprovalTier[] = [
  { tier: 1, label: 'Team lead' },
  { tier: 2, label: 'Department head' },
  { tier: 3, label: 'Finance' },
];

export const APPROVAL_RULES: ApprovalRule[] = [
  { maxTotalCents: 1_000_00, tiers: [1] }, //        total ≤ €1,000.00  → tier 1
  { maxTotalCents: 10_000_00, tiers: [1, 2] }, //    total ≤ €10,000.00 → tiers 1+2
  { maxTotalCents: null, tiers: [1, 2, 3] }, //      above              → tiers 1+2+3
];

/** Required tiers for a PO total, ascending. First matching rule wins. */
export function requiredTiers(totalCents: number): number[] {
  for (const rule of APPROVAL_RULES) {
    if (rule.maxTotalCents === null || totalCents <= rule.maxTotalCents) {
      return [...rule.tiers];
    }
  }
  /* istanbul ignore next -- the self-check below makes this unreachable */
  throw new Error('approval-config: no rule matched — the last rule must have maxTotalCents: null');
}

export function tierLabel(tier: number): string {
  return APPROVAL_TIERS.find((t) => t.tier === tier)?.label ?? `Tier ${tier}`;
}

// ── Config self-check (runs once at import) ──────────────────────────
// Misconfiguration should fail loudly at startup, not silently at
// submit time.
{
  const known = new Set(APPROVAL_TIERS.map((t) => t.tier));
  if (APPROVAL_RULES.length === 0 || APPROVAL_RULES[APPROVAL_RULES.length - 1]!.maxTotalCents !== null) {
    throw new Error('approval-config: the last rule must be the catch-all (maxTotalCents: null)');
  }
  let prev = -1;
  for (const rule of APPROVAL_RULES) {
    if (rule.maxTotalCents !== null && rule.maxTotalCents <= prev) {
      throw new Error('approval-config: rule thresholds must be strictly ascending');
    }
    prev = rule.maxTotalCents ?? Number.MAX_SAFE_INTEGER;
    if (rule.tiers.length === 0 || rule.tiers.some((t, i) => !known.has(t) || (i > 0 && t <= rule.tiers[i - 1]!))) {
      throw new Error('approval-config: every rule needs known tiers in strictly ascending order');
    }
  }
}
