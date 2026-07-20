import type { InvoiceStatus, PaymentStatus } from '../../shared/types';

const LABELS: Record<InvoiceStatus, string> = {
  draft: 'DRAFT',
  sent: 'SENT',
  paid: 'PAID',
  cancelled: 'CANCELLED',
};

export function StatusBadge({ status, overdue }: { status: InvoiceStatus; overdue?: boolean }) {
  return (
    <>
      <span className={`badge mono badge--${status}`}>{LABELS[status]}</span>
      {overdue && <span className="badge mono badge--overdue">OVERDUE</span>}
    </>
  );
}

const PAYMENT_LABELS: Record<PaymentStatus, string> = {
  unpaid: 'UNPAID',
  partially_paid: 'PARTIAL',
  paid: 'PAID',
};

export function PaymentBadge({ status }: { status: PaymentStatus }) {
  return <span className={`badge mono pay--${status}`}>{PAYMENT_LABELS[status]}</span>;
}
