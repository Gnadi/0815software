import { useCallback, useEffect, useState } from 'react';
import { NEXT_STATUS, type OrderDetail } from '../../shared/types';
import { admin, ApiError } from '../api';
import { fmtDateTime, fmtEur } from '../format';
import { StatusBadge, PaymentBadge } from './StatusBadge';

export function OrderDetailAdmin({
  id,
  onBack,
  onAuthLost,
}: {
  id: number;
  onBack: () => void;
  onAuthLost: () => void;
}) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setOrder(await admin.order(id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError('Could not load the order');
    }
  }, [id, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: () => Promise<OrderDetail>) {
    setBusy(true);
    setError('');
    try {
      setOrder(await action());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  if (!order) {
    return (
      <section>
        <button className="backlink mono" onClick={onBack}>← ORDERS</button>
        {error && <div className="resource__error mono">{error}</div>}
      </section>
    );
  }

  const next = NEXT_STATUS[order.status];
  const cancellable = order.status === 'placed' || order.status === 'confirmed';

  return (
    <section>
      <button className="backlink mono" onClick={onBack}>← ORDERS</button>
      <div className="resource__head">
        <div>
          <p className="resource__eyebrow mono">ORDER</p>
          <h1 className="resource__title">{order.ref}</h1>
          <p className="resource__desc">
            {order.customer_name} · {order.email} · placed {fmtDateTime(order.created_at)}
          </p>
          <p className="resource__desc">
            <StatusBadge status={order.status} /> <PaymentBadge status={order.payment_status} />
          </p>
        </div>
        <div className="resource__actions">
          {next && (
            <button
              className="btn btn--primary"
              disabled={busy}
              onClick={() => void act(() => admin.setStatus(order.id, next))}
            >
              MARK {next.toUpperCase()} →
            </button>
          )}
          {order.payment_status === 'unpaid' && order.status !== 'cancelled' && (
            <button
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => void act(() => admin.markPaid(order.id))}
            >
              MARK PAID
            </button>
          )}
          {cancellable && (
            <button
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => void act(() => admin.cancelOrder(order.id))}
            >
              CANCEL + RESTOCK
            </button>
          )}
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <h2 className="section-title mono">SHIPPING ADDRESS</h2>
      <p className="address">{order.address}</p>

      <h2 className="section-title mono">LINES (PRICES SNAPSHOTTED AT CHECKOUT)</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">#</th>
              <th className="mono">SKU</th>
              <th className="mono">PRODUCT</th>
              <th className="mono">QTY</th>
              <th className="mono">UNIT PRICE</th>
              <th className="mono">VAT</th>
              <th className="mono">LINE TOTAL</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((line) => (
              <tr key={line.id}>
                <td className="table__id mono">{line.position}</td>
                <td className="table__id mono">{line.sku}</td>
                <td>{line.name}</td>
                <td className="table__num mono">{line.quantity}</td>
                <td className="table__num mono">{fmtEur(line.unit_price_cents)}</td>
                <td className="table__num mono">{line.vat_rate}%</td>
                <td className="table__num mono">{fmtEur(line.line_gross_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="totals">
        {order.vat_breakdown.map((r) => (
          <div key={r.rate} className="totals__row mono">
            <span>{r.rate}% VAT (ON {fmtEur(r.gross_cents)})</span>
            <span>{fmtEur(r.vat_cents)}</span>
          </div>
        ))}
        <div className="totals__row mono">
          <span>NET</span>
          <span>{fmtEur(order.net_cents)}</span>
        </div>
        <div className="totals__row totals__row--gross mono">
          <span>TOTAL</span>
          <span>{fmtEur(order.gross_cents)}</span>
        </div>
      </div>

      <h2 className="section-title mono">HISTORY</h2>
      <div className="timeline">
        {order.events.map((event) => (
          <div key={event.id} className="timeline__row">
            <span className="timeline__at mono">{fmtDateTime(event.at)}</span>
            <StatusBadge status={event.status} />
            {event.note && <span className="table__id mono">{event.note}</span>}
          </div>
        ))}
        {order.paid_at && (
          <div className="timeline__row">
            <span className="timeline__at mono">{fmtDateTime(order.paid_at)}</span>
            <span className="badge mono pay--paid">PAID</span>
          </div>
        )}
      </div>
    </section>
  );
}
