import type { PoStatus } from '../../shared/types';

const LABELS: Record<PoStatus, string> = {
  draft: 'DRAFT',
  ordered: 'ORDERED',
  partially_received: 'PARTIAL',
  received: 'RECEIVED',
};

export function StatusBadge({ status }: { status: PoStatus }) {
  return <span className={`badge mono badge--${status}`}>{LABELS[status]}</span>;
}
