import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { PurchaseOrderDetail, Warehouse } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDateTime, fmtQty } from '../format';
import { StatusBadge } from './StatusBadge';

interface Props {
  id: number;
  warehouses: Warehouse[];
  onBack: () => void;
  onAuthLost: () => void;
}

export function PurchaseOrderView({ id, warehouses, onBack, onAuthLost }: Props) {
  const [po, setPo] = useState<PurchaseOrderDetail | null>(null);
  const [warehouse, setWarehouse] = useState(String(warehouses[0]?.id ?? ''));
  const [receiveQty, setReceiveQty] = useState<Record<number, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setPo(await api.purchaseOrderDetail(id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load purchase order');
    }
  }, [id, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      setReceiveQty({});
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      if (err instanceof ApiError) {
        setError(err.details.length > 0 ? err.details.map((d) => d.message).join(' · ') : err.message);
      } else {
        setError('Request failed');
      }
    } finally {
      setBusy(false);
    }
  }

  async function receive(event: FormEvent) {
    event.preventDefault();
    await run(() =>
      api.receivePurchaseOrder(id, {
        warehouse_id: Number(warehouse),
        lines: Object.entries(receiveQty)
          .filter(([, qty]) => qty !== '' && Number(qty) !== 0)
          .map(([lineId, qty]) => ({ line_id: Number(lineId), quantity: Number(qty) })),
      }),
    );
  }

  if (!po) {
    return error ? (
      <div>
        <button className="backlink mono" onClick={onBack}>
          ← PURCHASE ORDERS
        </button>
        <div className="resource__error mono">{error}</div>
      </div>
    ) : (
      <div className="boot mono">LOADING…</div>
    );
  }

  const receivable = po.status === 'ordered' || po.status === 'partially_received';

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← PURCHASE ORDERS
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.03 · PURCHASE ORDER</div>
          <h1 className="resource__title">
            <span className="mono">{po.po_number}</span> · {po.supplier_name}
          </h1>
          <p className="resource__desc">
            Created {fmtDateTime(po.created_at)} · <StatusBadge status={po.status} />
          </p>
        </div>
        {po.status === 'draft' && (
          <div className="resource__actions">
            <button
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Delete draft ${po.po_number}?`)) {
                  void run(async () => {
                    await api.deletePurchaseOrder(id);
                    onBack();
                  });
                }
              }}
            >
              DELETE DRAFT
            </button>
            <button className="btn btn--primary" disabled={busy} onClick={() => void run(() => api.markOrdered(id))}>
              MARK ORDERED →
            </button>
          </div>
        )}
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <form onSubmit={(e) => void receive(e)}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="mono">SKU</th>
                <th className="mono">PRODUCT</th>
                <th className="mono">ORDERED</th>
                <th className="mono">RECEIVED</th>
                <th className="mono">OPEN</th>
                {receivable && <th className="mono">RECEIVE NOW</th>}
              </tr>
            </thead>
            <tbody>
              {po.lines.map((line) => {
                const open = Math.round((line.qty_ordered - line.qty_received) * 1000) / 1000;
                return (
                  <tr key={line.id}>
                    <td className="mono">{line.sku}</td>
                    <td>{line.product_name}</td>
                    <td className="table__num mono">
                      {fmtQty(line.qty_ordered)} {line.unit}
                    </td>
                    <td className="table__num mono">{fmtQty(line.qty_received)}</td>
                    <td className="table__num mono">{open > 0 ? fmtQty(open) : '—'}</td>
                    {receivable && (
                      <td>
                        {open > 0 ? (
                          <input
                            className="field__input receive-input mono"
                            type="number"
                            step="any"
                            min="0"
                            max={open}
                            placeholder="0"
                            value={receiveQty[line.id] ?? ''}
                            onChange={(e) => setReceiveQty({ ...receiveQty, [line.id]: e.target.value })}
                          />
                        ) : (
                          <span className="mono table__id">COMPLETE</span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {receivable && (
          <div className="receive-bar">
            <label className="field receive-bar__warehouse">
              <span className="field__label mono">RECEIVE INTO</span>
              <select className="field__input" value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} — {w.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'RECEIVING…' : 'RECEIVE GOODS →'}
            </button>
            <span className="receive-bar__hint mono">
              PARTIAL RECEIPTS ALLOWED · OVER-RECEIPT IS REJECTED
            </span>
          </div>
        )}
        {po.status === 'draft' && (
          <p className="receive-bar__hint mono" style={{ marginTop: 14 }}>
            DRAFT — MARK AS ORDERED BEFORE RECEIVING GOODS
          </p>
        )}
      </form>
    </div>
  );
}
