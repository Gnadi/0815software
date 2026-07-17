import { useEffect, useState } from 'react';
import { formatMoney, type OrderDetailResponse } from '../../shared/types';
import { api, ApiError, documentDownloadUrl } from '../api';
import { formatDateTime } from '../format';
import { StatusBadge } from './StatusBadge';

interface Props {
  id: number;
  onBack: () => void;
  onAuthLost: () => void;
}

export function OrderDetail({ id, onBack, onAuthLost }: Props) {
  const [data, setData] = useState<OrderDetailResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .order(id)
      .then(setData)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onAuthLost();
        else setError(err instanceof Error ? err.message : 'Failed to load');
      });
  }, [id, onAuthLost]);

  if (error) {
    return (
      <section>
        <button className="backlink mono" onClick={onBack}>
          ← ALL ORDERS
        </button>
        <div className="page__error mono">{error}</div>
      </section>
    );
  }
  if (!data) {
    return <div className="boot mono">LOADING…</div>;
  }

  const { order, items, events, documents } = data;

  return (
    <section>
      <button className="backlink mono" onClick={onBack}>
        ← ALL ORDERS
      </button>
      <header className="page__head page__head--split">
        <div>
          <div className="page__eyebrow mono">ORDER · {order.order_no}</div>
          <h1 className="page__title">{formatMoney(order.total_cents, order.currency)}</h1>
        </div>
        <StatusBadge status={order.status} />
      </header>

      <div className="detail">
        <div className="detail__col">
          <h2 className="detail__heading mono">LINE ITEMS</h2>
          <div className="table-wrap">
            <table className="table table--tight">
              <thead>
                <tr>
                  <th className="mono">SKU</th>
                  <th className="mono">DESCRIPTION</th>
                  <th className="mono">QTY</th>
                  <th className="mono">UNIT</th>
                  <th className="mono">AMOUNT</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="mono">{item.sku}</td>
                    <td>{item.description}</td>
                    <td className="table__num">{item.quantity}</td>
                    <td className="table__num">{formatMoney(item.unit_price_cents, order.currency)}</td>
                    <td className="table__num">
                      {formatMoney(item.quantity * item.unit_price_cents, order.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="detail__heading mono">DOCUMENTS</h2>
          {documents.length === 0 ? (
            <p className="detail__none mono">NO DOCUMENTS YET</p>
          ) : (
            <ul className="doclist">
              {documents.map((doc) => (
                <li key={doc.id} className="doclist__row">
                  <span className="doclist__type mono">{doc.doc_type.replace('_', ' ').toUpperCase()}</span>
                  <span className="doclist__title">{doc.title}</span>
                  <a className="rowbtn mono" href={documentDownloadUrl(doc.id)} download>
                    DOWNLOAD ↓
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="detail__col">
          <h2 className="detail__heading mono">STATUS TIMELINE</h2>
          <ol className="timeline">
            {events.map((event, index) => (
              <li
                key={event.id}
                className={`timeline__step ${index === events.length - 1 ? 'is-current' : ''}`}
              >
                <span className="timeline__dot" />
                <div>
                  <div className="timeline__status mono">{event.status.toUpperCase()}</div>
                  <div className="timeline__at mono">{formatDateTime(event.at)}</div>
                  {event.note && <div className="timeline__note">{event.note}</div>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
