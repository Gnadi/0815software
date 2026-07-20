import type { PoStatus, RfqStatus } from '../../shared/types';

const PO_LABELS: Record<PoStatus, string> = {
  draft: 'DRAFT',
  submitted: 'SUBMITTED',
  approved: 'APPROVED',
  ordered: 'ORDERED',
  closed: 'CLOSED',
};

export function PoBadge({ status }: { status: PoStatus }) {
  return <span className={`badge mono badge--${status}`}>{PO_LABELS[status]}</span>;
}

const RFQ_LABELS: Record<RfqStatus, string> = {
  open: 'OPEN',
  quoted: 'QUOTED',
  awarded: 'AWARDED',
  closed: 'CLOSED',
};

export function RfqBadge({ status }: { status: RfqStatus }) {
  return <span className={`badge mono badge--${status}`}>{RFQ_LABELS[status]}</span>;
}

/** "1 2 3" tier dots: filled = approved, outlined = pending, dim = not required. */
export function TierProgress({
  required,
  approved,
}: {
  required: number[];
  approved: number[];
}) {
  if (required.length === 0) return <span className="table__id mono">—</span>;
  return (
    <span className="tiers">
      {required.map((tier) => (
        <span
          key={tier}
          className={`tiers__dot ${approved.includes(tier) ? 'is-approved' : 'is-pending'}`}
          title={approved.includes(tier) ? `Tier ${tier} approved` : `Tier ${tier} pending`}
        >
          {tier}
        </span>
      ))}
    </span>
  );
}
