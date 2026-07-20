import { useCallback, useEffect, useState } from 'react';
import { formatMoney, ORDER_STATUSES, type OrderSummary } from '../../shared/types';
import { api, ApiError } from '../api';
import { formatDate } from '../format';
import { StatusBadge } from './StatusBadge';

interface Props {
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}

export function OrdersList({ onOpen, onAuthLost }: Props) {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (status) params.set('status', status);
      const data = await api.orders(params);
      setOrders(data.orders);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [search, status, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasFilters = search !== '' || status !== '';

  return (
    <section>
      <header className="page__head">
        <div className="page__eyebrow mono">SELF-SERVICE · ORDERS</div>
        <h1 className="page__title">Your orders</h1>
        <p className="page__desc">Every order on your account, with live status and documents.</p>
      </header>

      <div className="toolbar">
        <input
          className="toolbar__search field__input"
          placeholder="Search order no., article, SKU…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="toolbar__select field__input"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          {ORDER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {hasFilters && (
          <button
            className="toolbar__clear mono"
            onClick={() => {
              setSearch('');
              setStatus('');
            }}
          >
            CLEAR ×
          </button>
        )}
        <div className="toolbar__count mono">
          {orders.length} {orders.length === 1 ? 'ORDER' : 'ORDERS'}
        </div>
      </div>

      {error && <div className="page__error mono">{error}</div>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">ORDER</th>
              <th className="mono">PLACED</th>
              <th className="mono">ITEMS</th>
              <th className="mono">TOTAL</th>
              <th className="mono">STATUS</th>
              <th className="mono">DOCS</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id} className="table__row-link" onClick={() => onOpen(order.id)}>
                <td className="mono">{order.order_no}</td>
                <td>{formatDate(order.placed_at)}</td>
                <td className="table__num">{order.item_count}</td>
                <td className="table__num">{formatMoney(order.total_cents, order.currency)}</td>
                <td>
                  <StatusBadge status={order.status} />
                </td>
                <td className="table__num">{order.document_count}</td>
                <td className="mono table__arrow">→</td>
              </tr>
            ))}
            {orders.length === 0 && !loading && (
              <tr>
                <td className="table__empty mono" colSpan={7}>
                  NO ORDERS{hasFilters ? ' MATCH THE CURRENT FILTERS' : ''}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
