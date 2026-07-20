import type { Priority, SlaLeg, Status } from '../../shared/types';
import { slaLabel } from '../format';

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge mono badge--${status}`}>{status.toUpperCase()}</span>;
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={`badge mono badge--${priority}`}>{priority.toUpperCase()}</span>;
}

/** SLA leg badge — the `pending` state uses a distinct class to avoid clashing
 *  with the `pending` status colour. */
export function SlaBadge({ leg }: { leg: SlaLeg }) {
  const cls = leg.state === 'pending' ? 'pending-sla' : leg.state;
  return <span className={`badge mono badge--${cls}`}>{slaLabel(leg.state)}</span>;
}
