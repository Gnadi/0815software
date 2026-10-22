import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { OrderDetail as Detail } from '../../shared/types';
import { Can, useCan } from '../access';
import { api, ApiError, deliveryNotePdfUrl, fmtEur, fmtQty, orderPdfUrl } from '../api';
import { STATUS_BADGE, STATUS_LABEL } from './OrdersView';

/**
 * One order: what was ordered, what has been delivered (derived from the
 * delivery notes), and the next delivery. A delivery note is written once and
 * never changed; what is still open is whatever the notes do not cover.
 */

interface Props {
  id: number;
  onBack: () => void;
  onAuthLost: () => void;
}

export function OrderDetail({ id, onBack, onAuthLost }: Props) {
  const [order, setOrder] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [deliveredOn, setDeliveredOn] = useState('');
  const [note, setNote] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const canEdit = useCan('edit');

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof ApiError && err.details.length > 0 ? `${err.message}: ${err.details.map((d) => d.message).join(' · ')}` : err instanceof Error ? err.message : 'Request failed');
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    try {
      const detail = await api.order(id);
      setOrder(detail);
      // Offer the rest of every line as the next delivery; the person adjusts.
      setQuantities(Object.fromEntries(detail.lines.map((l) => [l.id, l.remaining_quantity > 0 ? fmtQty(l.remaining_quantity) : ''])));
    } catch (err) {
      handle(err);
    }
  }, [id, handle]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (err) {
      handle(err);
    } finally {
      setBusy(false);
    }
  }

  function deliver(event: FormEvent) {
    event.preventDefault();
    const lines = Object.entries(quantities)
      .filter(([, q]) => q.trim() !== '' && Number(q.replace(',', '.')) > 0)
      .map(([lineId, q]) => ({ order_line_id: Number(lineId), quantity: Number(q.replace(',', '.')) }));
    void run(async () => {
      await api.deliver(id, { delivered_on: deliveredOn || undefined, note: note || undefined, lines });
      setDeliveredOn('');
      setNote('');
    });
  }

  if (!order) return error ? <div className="resource__error mono">{error}</div> : <div className="boot mono">LOADING…</div>;
  const deliverable = order.status === 'open' || order.status === 'partially_delivered';

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← ORDERS
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ ORD.01 · SALES</div>
          <h1 className="resource__title">{order.number}</h1>
          <p className="resource__desc">
            {order.customer.name} · ordered {order.order_date}
            {order.customer_reference && <> · their order {order.customer_reference}</>}
            {order.source_reference && <> · from {order.source_reference}</>}
            {' · '}
            <span className={`badge mono ${STATUS_BADGE[order.status]}`}>{STATUS_LABEL[order.status]}</span>
          </p>
        </div>
        <div className="resource__actions">
          <a className="btn btn--ghost" href={orderPdfUrl(order.id)} target="_blank" rel="noreferrer">
            CONFIRMATION PDF ↓
          </a>
          {deliverable && (
            <Can level="manage">
              <button className="btn btn--ghost" disabled={busy} onClick={() => setCancelling(true)}>
                CANCEL REST
              </button>
            </Can>
          )}
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}
      {order.status === 'cancelled' && (
        <div className="resource__error mono">
          CANCELLED {order.cancelled_at?.slice(0, 10)} — {order.cancel_reason}. Delivery notes already written stay valid.
        </div>
      )}

      <div className="stat-row">
        <div className="stat">
          <div className="stat__label mono">NET</div>
          <div className="stat__value">{fmtEur(order.totals.net_cents)}</div>
        </div>
        <div className="stat">
          <div className="stat__label mono">VAT</div>
          <div className="stat__value">{fmtEur(order.totals.vat_cents)}</div>
        </div>
        <div className="stat stat--total">
          <div className="stat__label mono">GROSS</div>
          <div className="stat__value">{fmtEur(order.totals.gross_cents)}</div>
        </div>
      </div>

      <form onSubmit={deliver}>
        <div className="section-title mono">LINES</div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>SKU</th>
                <th>Description</th>
                <th className="table__num">Ordered</th>
                <th className="table__num">Delivered</th>
                <th className="table__num">Open</th>
                <th className="table__num">Net</th>
                {deliverable && <th className="table__num">Deliver now</th>}
              </tr>
            </thead>
            <tbody>
              {order.lines.map((l) => (
                <tr key={l.id}>
                  <td className="mono table__id">{l.position}</td>
                  <td className="mono">
                    {canEdit && order.status !== 'cancelled' ? (
                      <button
                        type="button"
                        className="linklike mono"
                        title="MOD-03 article number — decides which stock a delivery issues"
                        onClick={() => {
                          const next = window.prompt(`Article number (SKU) for line ${l.position} — empty for a service:`, l.sku ?? '');
                          if (next !== null) void run(() => api.setSku(order.id, l.id, next.trim()));
                        }}
                      >
                        {l.sku ?? 'set…'}
                      </button>
                    ) : (
                      (l.sku ?? '—')
                    )}
                  </td>
                  <td>{l.description}</td>
                  <td className="table__num mono">{fmtQty(l.quantity)}</td>
                  <td className="table__num mono">{fmtQty(l.delivered_quantity)}</td>
                  <td className={`table__num mono ${l.remaining_quantity > 0 ? 'qty-neg' : 'qty-pos'}`}>{fmtQty(l.remaining_quantity)}</td>
                  <td className="table__num mono">{fmtEur(l.net_cents)}</td>
                  {deliverable && (
                    <td className="table__num">
                      {l.remaining_quantity > 0 && (
                        <input
                          className="field__input receive-input"
                          value={quantities[l.id] ?? ''}
                          onChange={(e) => setQuantities({ ...quantities, [l.id]: e.target.value })}
                        />
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {deliverable && (
          <Can>
            <div className="receive-bar">
              <label className="field">
                <span className="field__label mono">DELIVERED ON</span>
                <input className="field__input" type="date" value={deliveredOn} title="Empty → today" onChange={(e) => setDeliveredOn(e.target.value)} />
              </label>
              <label className="field" style={{ minWidth: 240 }}>
                <span className="field__label mono">NOTE</span>
                <input className="field__input" value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <button className="btn btn--primary" type="submit" disabled={busy}>
                WRITE DELIVERY NOTE →
              </button>
              <span className="receive-bar__hint mono">NEVER MORE THAN IS OPEN</span>
            </div>
          </Can>
        )}
      </form>

      <div className="section-title mono">DELIVERY NOTES</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Delivered</th>
              <th>Lines</th>
              <th>By</th>
              <th>Stock</th>
              <th>Invoicing</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {order.delivery_notes.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={7}>
                  NOTHING DELIVERED YET
                </td>
              </tr>
            )}
            {order.delivery_notes.map((n) => (
              <tr key={n.id}>
                <td className="mono">{n.number}</td>
                <td className="mono table__id">{n.delivered_on}</td>
                <td className="note-cell">{n.lines.map((l) => `${fmtQty(l.quantity)} × ${l.description}`).join(' · ')}</td>
                <td className="table__id">{n.created_by}</td>
                <td className="mono">
                  {n.stock_status === 'booked' && `BOOKED · ${n.stock_warehouse}`}
                  {n.stock_status === 'failed' && <span className="qty-neg" title={n.stock_error ?? ''}>FAILED — {n.stock_error}</span>}
                  {n.stock_status === null && (n.lines.some((l) => l.sku) ? 'NOT BOOKED' : '—')}
                  {n.stock_status !== 'booked' && n.lines.some((l) => l.sku) && (
                    <Can>
                      {' '}
                      <button type="button" className="rowbtn mono" disabled={busy} onClick={() => void run(() => api.bookStock(n.id))}>
                        BOOK STOCK
                      </button>
                    </Can>
                  )}
                </td>
                <td className="mono">{n.invoiced_at ? `${n.invoice_reference} · ${n.invoiced_at.slice(0, 10)}` : 'NOT YET — bill it in MOD-04 by its number'}</td>
                <td className="table__rowactions">
                  <a className="rowbtn mono" href={deliveryNotePdfUrl(n.id)} target="_blank" rel="noreferrer">
                    PDF ↓
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-title mono">HISTORY</div>
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {order.events.map((e) => (
              <tr key={e.id}>
                <td className="mono table__id">{e.at.slice(0, 16).replace('T', ' ')}</td>
                <td className="mono">{e.type.toUpperCase()}</td>
                <td className="note-cell">{e.detail}</td>
                <td className="table__id">{e.actor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {cancelling && (
        <div className="modal">
          <div className="modal__backdrop" onClick={() => setCancelling(false)} />
          <form
            className="modal__card"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.cancelOrder(order.id, reason)).then(() => setCancelling(false));
            }}
          >
            <div className="modal__eyebrow mono">CANCEL {order.number}</div>
            <h2 className="modal__title">Cancel what is still open</h2>
            <p className="resource__desc">Nothing more is delivered on this order. Delivery notes already written stay, and can still be billed.</p>
            <label className="field">
              <span className="field__label mono">
                REASON <span className="field__req">*</span>
              </span>
              <input className="field__input" value={reason} autoFocus onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="modal__actions">
              <button className="btn btn--ghost" type="button" onClick={() => setCancelling(false)}>
                KEEP ORDER
              </button>
              <button className="btn btn--primary" type="submit" disabled={busy || reason.trim() === ''}>
                CANCEL REST →
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
