import { useCallback, useEffect, useState } from 'react';
import type { StockRow, Warehouse } from '../../shared/types';
import { api, ApiError, stockExportUrl } from '../api';
import { fmtQty } from '../format';
import { MovementModal, type MovementMode } from './MovementModal';

interface Props {
  warehouses: Warehouse[];
  onOpenProduct: (id: number) => void;
  onAuthLost: () => void;
}

export function StockOverview({ warehouses, onOpenProduct, onAuthLost }: Props) {
  const [rows, setRows] = useState<StockRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [modal, setModal] = useState<MovementMode | null>(null);
  const [error, setError] = useState('');

  const params = useCallback(() => {
    const p = new URLSearchParams();
    if (search.trim()) p.set('search', search.trim());
    if (lowOnly) p.set('low', '1');
    return p;
  }, [search, lowOnly]);

  const load = useCallback(async () => {
    try {
      const { rows: data } = await api.stock(params());
      setRows(data);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load stock');
    }
  }, [params, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const lowCount = rows?.filter((r) => r.low).length ?? 0;

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.01 · STOCK</div>
          <h1 className="resource__title">Stock overview</h1>
          <p className="resource__desc">
            Current levels per warehouse, derived from the movement ledger.
          </p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--ghost" onClick={() => setModal('adjustment')}>
            ADJUST
          </button>
          <button className="btn btn--ghost" onClick={() => setModal('transfer')}>
            TRANSFER
          </button>
          <button className="btn btn--primary" onClick={() => setModal('receipt')}>
            + RECEIPT
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <input
          className="field__input toolbar__search"
          placeholder="Search SKU or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="toolbar__toggle mono">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
          LOW STOCK ONLY {lowCount > 0 && !lowOnly ? `(${lowCount})` : ''}
        </label>
        <a className="toolbar__clear mono" href={stockExportUrl(params())} download>
          EXPORT CSV ↓
        </a>
        <span className="toolbar__count mono">{rows ? `${rows.length} PRODUCTS` : '…'}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">SKU</th>
              <th className="mono">NAME</th>
              <th className="mono">UNIT</th>
              {warehouses.map((w) => (
                <th key={w.id} className="mono" title={w.name}>
                  {w.code}
                </th>
              ))}
              <th className="mono">TOTAL</th>
              <th className="mono">REORDER PT</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((row) => (
              <tr
                key={row.id}
                className={row.low ? 'is-low' : ''}
                onClick={() => onOpenProduct(row.id)}
              >
                <td className="mono">{row.sku}</td>
                <td>
                  {row.name}
                  {row.low && <span className="lowflag mono">LOW</span>}
                </td>
                <td className="mono table__id">{row.unit}</td>
                {warehouses.map((w) => (
                  <td key={w.id} className="table__num mono">
                    {fmtQty(row.levels[w.id] ?? 0)}
                  </td>
                ))}
                <td className="table__num mono">
                  <strong>{fmtQty(row.total)}</strong>
                </td>
                <td className="table__num mono table__id">{fmtQty(row.reorder_point)}</td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={5 + warehouses.length}>
                  NO PRODUCTS MATCH
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <MovementModal
          mode={modal}
          warehouses={warehouses}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            void load();
          }}
          onAuthLost={onAuthLost}
        />
      )}
    </div>
  );
}
