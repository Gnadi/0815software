import { useEffect, useState } from 'react';
import type { GuestOrder } from '../../shared/types';
import { shop } from '../api';
import { fmtDateTime, fmtEur } from '../format';
import { StatusBadge, PaymentBadge } from './StatusBadge';

/**
 * Guest order status — reachable only via the signed link
 * (/order/:ref?token=…) handed out on the confirmation page. Doubles as
 * the confirmation page itself right after checkout.
 */
export function OrderStatusView({
  orderRef,
  token,
  initial,
  confirmation = false,
  onBrowse,
}: {
  orderRef: string;
  token: string;
  initial?: GuestOrder;
  confirmation?: boolean;
  onBrowse: () => void;
}) {
  const [order, setOrder] = useState<GuestOrder | null>(initial ?? null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (initial) return;
    shop
      .orderStatus(orderRef, token)
      .then(setOrder)
      .catch(() => setNotFound(true));
  }, [orderRef, token, initial]);

  if (notFound) {
    return (
      <section>
        <div className="resource__head">
          <div>
            <p className="resource__eyebrow mono">ORDER STATUS</p>
            <h1 className="resource__title">Not found.</h1>
            <p className="resource__desc">
              This link is not valid. Check that you copied the full URL from your confirmation —
              the token after <span className="mono">?token=</span> is part of it.
            </p>
          </div>
        </div>
        <button className="btn btn--ghost" onClick={onBrowse}>← BACK TO THE SHOP</button>
      </section>
    );
  }

  if (!order) {
    return <div className="boot mono">LOADING…</div>;
  }

  const statusLink = `${window.location.origin}/order/${encodeURIComponent(orderRef)}?token=${encodeURIComponent(token)}`;

  return (
    <section>
      <div className="resource__head">
        <div>
          <p className="resource__eyebrow mono">
            {confirmation ? 'ORDER PLACED' : 'ORDER STATUS'}
          </p>
          <h1 className="resource__title">
            {confirmation ? 'Thank you.' : `Order ${order.ref}`}
          </h1>
          <p className="resource__desc">
            <span className="mono">{order.ref}</span> · placed {fmtDateTime(order.created_at)} ·{' '}
            <StatusBadge status={order.status} /> <PaymentBadge status={order.payment_status} />
          </p>
        </div>
      </div>

      {confirmation && (
        <div className="keepbox">
          <p className="keepbox__title mono">KEEP THIS LINK — IT IS YOUR ONLY KEY TO THIS ORDER</p>
          <p className="keepbox__link mono">{statusLink}</p>
          <p className="keepbox__hint">
            There is no account. Anyone with this link can see the order status; without it, not
            even the order reference will get you in.
          </p>
        </div>
      )}

      <h2 className="section-title mono">ITEMS</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">SKU</th>
              <th className="mono">PRODUCT</th>
              <th className="mono">QTY</th>
              <th className="mono">UNIT PRICE</th>
              <th className="mono">LINE TOTAL</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((line, i) => (
              <tr key={i}>
                <td className="table__id mono">{line.sku}</td>
                <td>{line.name}</td>
                <td className="table__num mono">{line.quantity}</td>
                <td className="table__num mono">{fmtEur(line.unit_price_cents)}</td>
                <td className="table__num mono">{fmtEur(line.line_gross_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="totals">
        {order.totals.by_rate.map((r) => (
          <div key={r.rate} className="totals__row mono">
            <span>INCL. {r.rate}% VAT</span>
            <span>{fmtEur(r.vat_cents)}</span>
          </div>
        ))}
        <div className="totals__row totals__row--gross mono">
          <span>TOTAL</span>
          <span>{fmtEur(order.totals.gross_cents)}</span>
        </div>
      </div>

      <h2 className="section-title mono">HISTORY</h2>
      <div className="timeline">
        {order.events.map((event, i) => (
          <div key={i} className="timeline__row">
            <span className="timeline__at mono">{fmtDateTime(event.at)}</span>
            <StatusBadge status={event.status} />
          </div>
        ))}
      </div>

      <div className="cart__actions">
        <button className="btn btn--ghost" onClick={onBrowse}>← BACK TO THE SHOP</button>
      </div>
    </section>
  );
}
