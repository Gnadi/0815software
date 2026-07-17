import { useCallback, useEffect, useState } from 'react';
import type { MovementRow, Product } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDateTime, fmtQty } from '../format';

interface Props {
  id: number;
  onBack: () => void;
  onAuthLost: () => void;
}

interface StockEntry {
  warehouse_id: number;
  code: string;
  name: string;
  level: number;
}

const TYPE_LABELS: Record<MovementRow['type'], string> = {
  receipt: 'RECEIPT',
  transfer_out: 'TRANSFER OUT',
  transfer_in: 'TRANSFER IN',
  adjustment: 'ADJUSTMENT',
  po_receipt: 'PO RECEIPT',
};

export function ProductDetail({ id, onBack, onAuthLost }: Props) {
  const [product, setProduct] = useState<Product | null>(null);
  const [stock, setStock] = useState<StockEntry[]>([]);
  const [movements, setMovements] = useState<MovementRow[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [detail, history] = await Promise.all([api.productDetail(id), api.productMovements(id)]);
      setProduct(detail.product);
      setStock(detail.stock);
      setMovements(history.movements);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load product');
    }
  }, [id, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div>
        <button className="backlink mono" onClick={onBack}>
          ← PRODUCTS
        </button>
        <div className="resource__error mono">{error}</div>
      </div>
    );
  }
  if (!product || !movements) {
    return <div className="boot mono">LOADING…</div>;
  }

  const total = stock.reduce((a, s) => a + s.level, 0);
  const low = total <= product.reorder_point;

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← PRODUCTS
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.02 · PRODUCT</div>
          <h1 className="resource__title">
            <span className="mono">{product.sku}</span> — {product.name}
          </h1>
          <p className="resource__desc">
            Unit {product.unit} · reorder point {fmtQty(product.reorder_point)}
            {low && <span className="lowflag mono">LOW</span>}
          </p>
        </div>
      </div>

      <div className="stat-row">
        {stock.map((s) => (
          <div key={s.warehouse_id} className="stat">
            <div className="stat__label mono" title={s.name}>
              {s.code}
            </div>
            <div className="stat__value mono">{fmtQty(s.level)}</div>
          </div>
        ))}
        <div className="stat stat--total">
          <div className="stat__label mono">TOTAL</div>
          <div className="stat__value mono">{fmtQty(total)}</div>
        </div>
      </div>

      <h2 className="section-title mono">MOVEMENT HISTORY · {movements.length} ENTRIES</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">DATE</th>
              <th className="mono">TYPE</th>
              <th className="mono">WAREHOUSE</th>
              <th className="mono">QTY</th>
              <th className="mono">REFERENCE</th>
              <th className="mono">NOTE</th>
            </tr>
          </thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id}>
                <td className="mono table__id">{fmtDateTime(m.created_at)}</td>
                <td>
                  <span className={`movetype mono movetype--${m.type}`}>{TYPE_LABELS[m.type]}</span>
                </td>
                <td className="mono">{m.warehouse_code}</td>
                <td className={`table__num mono ${m.quantity < 0 ? 'qty-neg' : 'qty-pos'}`}>
                  {fmtQty(m.quantity, true)}
                </td>
                <td className="mono table__id">{m.reference ?? '—'}</td>
                <td className="note-cell">{m.note ?? ''}</td>
              </tr>
            ))}
            {movements.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={6}>
                  NO MOVEMENTS YET
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
