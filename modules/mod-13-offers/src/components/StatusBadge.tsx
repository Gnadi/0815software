import type { OfferStatus } from '../../shared/types';

const LABELS: Record<OfferStatus, string> = {
  draft: 'DRAFT',
  sent: 'SENT',
  accepted: 'ACCEPTED',
  rejected: 'REJECTED',
  withdrawn: 'WITHDRAWN',
  superseded: 'SUPERSEDED',
  expired: 'EXPIRED',
};

export function StatusBadge({ status }: { status: OfferStatus }) {
  return <span className={`badge mono badge--${status}`}>{LABELS[status]}</span>;
}
