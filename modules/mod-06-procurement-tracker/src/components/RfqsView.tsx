import { useCallback, useEffect, useState } from 'react';
import type { RfqRow } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDate } from '../format';
import { RfqBadge } from './StatusBadge';

interface Props {
  onOpen: (id: number) => void;
  onNew: () => void;
  onAuthLost: () => void;
}

const FILTERS = [
  { value: '', label: 'ALL' },
  { value: 'open', label: 'OPEN' },
  { value: 'quoted', label: 'QUOTED' },
  { value: 'awarded', label: 'AWARDED' },
  { value: 'closed', label: 'CLOSED' },
];

export function RfqsView({ onOpen, onNew, onAuthLost }: Props) {
  const [rows, setRows] = useState<RfqRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (filter) params.set('status', filter);
      const { rfqs } = await api.rfqs(params);
      setRows(rfqs);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load RFQs');
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
          <div className="resource__eyebrow mono">§ PRC.01 · SOURCING</div>
          <h1 className="resource__title">Requests for Quotation</h1>
          <p className="resource__desc">open → quoted → awarded (draft PO) or closed without award.</p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--primary" onClick={onNew}>
            + NEW RFQ
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <input
          className="field__input toolbar__search"
          placeholder="Search title…"
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
        <span className="toolbar__count mono">{rows ? `${rows.length} RFQS` : ''}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">#</th>
              <th className="mono">TITLE</th>
              <th className="mono">STATUS</th>
              <th className="mono">LINES</th>
              <th className="mono">INVITED</th>
              <th className="mono">QUOTES</th>
              <th className="mono">DUE</th>
              <th className="mono">AWARDED TO</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((rfq) => (
              <tr key={rfq.id}>
                <td className="mono table__id">RFQ-{rfq.id}</td>
                <td>
                  <button className="linklike" onClick={() => onOpen(rfq.id)}>
                    {rfq.title}
                  </button>
                </td>
                <td>
                  <RfqBadge status={rfq.status} />
                </td>
                <td className="table__num mono">{rfq.line_count}</td>
                <td className="table__num mono">{rfq.invited_count}</td>
                <td className="table__num mono">{rfq.quote_count}</td>
                <td className="mono table__id">{rfq.due_date ? fmtDate(rfq.due_date) : '—'}</td>
                <td className="table__id">{rfq.awarded_supplier_name ?? '—'}</td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={8}>
                  NO RFQS MATCH
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
