import { useCallback, useEffect, useState } from 'react';
import type { PoRow } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDate, fmtEur } from '../format';
import { PoBadge, TierProgress } from './StatusBadge';

interface Props {
  onOpen: (id: number) => void;
  onNew: () => void;
  onAuthLost: () => void;
}

const FILTERS = [
  { value: '', label: 'ALL' },
  { value: 'draft', label: 'DRAFT' },
  { value: 'submitted', label: 'SUBMITTED' },
  { value: 'approved', label: 'APPROVED' },
  { value: 'ordered', label: 'ORDERED' },
  { value: 'closed', label: 'CLOSED' },
];

export function PosView({ onOpen, onNew, onAuthLost }: Props) {
  const [rows, setRows] = useState<PoRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (filter) params.set('status', filter);
      const { pos } = await api.pos(params);
      setRows(pos);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load purchase orders');
    }
  }, [search, filter, onAuthLost]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ PRC.02 · ORDERING</div>
          <h1 className="resource__title">Purchase Orders</h1>
          <p className="resource__desc">
            draft → submitted → approved (tier by tier) → ordered → closed; rejection returns to draft.
          </p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--primary" onClick={onNew}>
            + NEW PO
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <input
          className="field__input toolbar__search"
          placeholder="Search number or supplier…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="field__input toolbar__filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <span className="toolbar__count mono">{rows ? `${rows.length} POS` : ''}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">NUMBER</th>
              <th className="mono">SUPPLIER</th>
              <th className="mono">STATUS</th>
              <th className="mono">APPROVALS</th>
              <th className="mono" style={{ textAlign: 'right' }}>TOTAL</th>
              <th className="mono">CREATED</th>
              <th className="mono">ORDERED</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((po) => (
              <tr key={po.id}>
                <td className="mono">
                  <button className="linklike mono" onClick={() => onOpen(po.id)}>
                    {po.number}
                  </button>
                </td>
                <td>{po.supplier_name}</td>
                <td>
                  <PoBadge status={po.status} />
                </td>
                <td>
                  <TierProgress required={po.required_tiers} approved={po.approved_tiers} />
                </td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>
                  {fmtEur(po.total_cents)}
                </td>
                <td className="mono table__id">{fmtDate(po.created_at)}</td>
                <td className="mono table__id">{po.ordered_at ? fmtDate(po.ordered_at) : '—'}</td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={7}>
                  NO PURCHASE ORDERS MATCH
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
