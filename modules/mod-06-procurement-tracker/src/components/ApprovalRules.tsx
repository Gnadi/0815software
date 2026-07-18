import type { AppConfig } from '../../shared/types';
import { fmtEur } from '../format';

/**
 * Renders the approval brackets exactly as configured on the server
 * (fetched via /api/config) — the UI never duplicates the thresholds.
 * `activeTotalCents` highlights the bracket a given total falls into.
 */
export function ApprovalRules({
  config,
  activeTotalCents,
}: {
  config: AppConfig;
  activeTotalCents?: number;
}) {
  const label = (tier: number) => config.tiers.find((t) => t.tier === tier)?.label ?? `Tier ${tier}`;
  let prevBound = -1; // inclusive upper bound of the previous bracket, in cents
  return (
    <div className="rules">
      {config.rules.map((rule, i) => {
        const from = prevBound; // this bracket covers (from, to]
        const to = rule.max_total_cents;
        prevBound = to ?? Number.MAX_SAFE_INTEGER;
        const active =
          activeTotalCents !== undefined && activeTotalCents > from && (to === null || activeTotalCents <= to);
        const range =
          to === null
            ? `ABOVE ${fmtEur(from)}`
            : from < 0
              ? `UP TO ${fmtEur(to)}`
              : `${fmtEur(from + 1)} — ${fmtEur(to)}`;
        return (
          <div key={i} className={`rules__row mono ${active ? 'is-active' : ''}`}>
            <span>{active ? '▸ ' : ''}{range}</span>
            <span>{rule.tiers.map((t) => `${t} · ${label(t).toUpperCase()}`).join('  +  ')}</span>
          </div>
        );
      })}
      <div className="rules__hint mono">
        THRESHOLDS ARE SERVER CONFIG (server/approval-config.ts) — FROZEN PER PO AT SUBMIT
      </div>
    </div>
  );
}
