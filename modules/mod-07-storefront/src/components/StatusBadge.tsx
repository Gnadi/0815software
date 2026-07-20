import type { OrderStatus, PaymentStatus } from '../../shared/types';

const LABELS: Record<OrderStatus, string> = {
  placed: 'PLACED',
  confirmed: 'CONFIRMED',
  shipped: 'SHIPPED',
  delivered: 'DELIVERED',
  cancelled: 'CANCELLED',
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  return <span className={`badge mono badge--${status}`}>{LABELS[status]}</span>;
}

const PAYMENT_LABELS: Record<PaymentStatus, string> = {
  unpaid: 'UNPAID',
  paid: 'PAID',
};

export function PaymentBadge({ status }: { status: PaymentStatus }) {
  return <span className={`badge mono pay--${status}`}>{PAYMENT_LABELS[status]}</span>;
}
