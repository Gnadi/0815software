import type { OrderStatus } from '../../shared/types';

export function StatusBadge({ status }: { status: OrderStatus }) {
  return <span className={`badge mono badge--${status}`}>{status.toUpperCase()}</span>;
}
