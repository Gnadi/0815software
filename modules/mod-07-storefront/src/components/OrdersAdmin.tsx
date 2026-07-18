import { useEffect, useMemo, useState } from 'react';
import { ORDER_STATUSES, PAYMENT_STATUSES, type OrderRow } from '../../shared/types';
import { admin, ApiError, ordersCsvUrl } from '../api';
import { fmtDateTime, fmtEur } from '../format';
import { StatusBadge, PaymentBadge } from './StatusBadge';

export function OrdersAdmin({
  onOpen,
  onAuthLost,
}: {
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}) {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [status, setStatus] = useState('');
  const [payment, setPayment] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (payment) p.set('payment', payment);
    if (search.trim()) p.set('search', search.trim());
    return p;
  }, [status, payment, search]);

  useEffect(() => {
    const timer = setTimeout(() => {
      admin
        .orders(params)
        .then((res) => {
          setOrders(res.orders);
          setError('');
        })
        .catch((err) => {
          if (err instanceof ApiError && err.status === 401) onAuthLost();
          else setError('Could not load orders');
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [params, onAuthLost]);

  return (
    <section>
      <div className="resource__head">
        <div>
          <p className="resource__eyebrow mono">ORDERS</p>
          <h1 className="resource__title">Orders</h1>
          <p className="resource__desc">Totals are derived from the snapshot lines — nothing stored, nothing stale.</p>
        </div>
        <div className="resource__actions">
          <a className="btn btn--ghost" href={ordersCsvUrl(params)}>
            EXPORT CSV ↓
          </a>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <input
          className="field__input toolbar__search"
          placeholder="Search ref / customer / email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="field__input toolbar__filter"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">STATUS: ALL</option>
          {ORDER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.toUpperCase()}
            </option>
          ))}
        </select>
        <select
          className="field__input toolbar__filter"
          value={payment}
          onChange={(e) => setPayment(e.target.value)}
        >
          <option value="">PAYMENT: ALL</option>
          {PAYMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.toUpperCase()}
            </option>
          ))}
        </select>
        {(status || payment || search) && (
          <button
            className="toolbar__clear mono"
            onClick={() => {
              setStatus('');
              setPayment('');
              setSearch('');
            }}
          >
            CLEAR
          </button>
        )}
        <span className="toolbar__count mono">{orders.length} ORDERS</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">REF</th>
              <th className="mono">PLACED</th>
              <th className="mono">CUSTOMER</th>
              <th className="mono">ITEMS</th>
              <th className="mono">TOTAL</th>
              <th className="mono">STATUS</th>
              <th className="mono">PAYMENT</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id} onClick={() => onOpen(order.id)} style={{ cursor: 'pointer' }}>
                <td className="mono">{order.ref}</td>
                <td className="table__id mono">{fmtDateTime(order.created_at)}</td>
                <td>{order.customer_name}</td>
                <td className="table__num mono">{order.item_count}</td>
                <td className="table__num mono">{fmtEur(order.gross_cents)}</td>
                <td><StatusBadge status={order.status} /></td>
                <td><PaymentBadge status={order.payment_status} /></td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={7}>
                  NO ORDERS MATCH
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
