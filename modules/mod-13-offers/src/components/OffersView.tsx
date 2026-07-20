import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OfferRow } from '../../shared/types';
import { api, ApiError, offersCsvUrl } from '../api';
import { fmtDate, fmtEur } from '../format';
import { StatusBadge } from './StatusBadge';

interface Props {
  onOpen: (id: number) => void;
  onNew: () => void;
  onAuthLost: () => void;
}

const FILTERS = [
  { value: '', label: 'ALL' },
  { value: 'draft', label: 'DRAFT' },
  { value: 'sent', label: 'SENT' },
  { value: 'expired', label: 'EXPIRED' },
  { value: 'accepted', label: 'ACCEPTED' },
  { value: 'rejected', label: 'REJECTED' },
  { value: 'withdrawn', label: 'WITHDRAWN' },
  { value: 'superseded', label: 'SUPERSEDED' },
];

export function OffersView({ onOpen, onNew, onAuthLost }: Props) {
  const [rows, setRows] = useState<OfferRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (search.trim()) p.set('search', search.trim());
    if (filter) p.set('status', filter);
    return p;
  }, [search, filter]);

  const load = useCallback(async () => {
    try {
      const { offers } = await api.offers(params);
      setRows(offers);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load offers');
    }
  }, [params, onAuthLost]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ OFF.01 · SALES</div>
          <h1 className="resource__title">Offers</h1>
          <p className="resource__desc">draft → sent → accepted / rejected; expired is derived from the validity date.</p>
        </div>
        <div className="resource__actions">
          <a className="btn btn--ghost" href={offersCsvUrl(params)}>
            CSV ↓
          </a>
          <button className="btn btn--primary" onClick={onNew}>
            + NEW OFFER
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <input
          className="field__input toolbar__search"
          placeholder="Search number, title or customer…"
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
        <span className="toolbar__count mono">{rows ? `${rows.length} OFFERS` : ''}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">NUMBER</th>
              <th className="mono">TITLE</th>
              <th className="mono">CUSTOMER</th>
              <th className="mono">STATUS</th>
              <th className="mono">VALID UNTIL</th>
              <th className="mono" style={{ textAlign: 'right' }}>NET</th>
              <th className="mono" style={{ textAlign: 'right' }}>GROSS</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((o) => (
              <tr
                key={o.id}
                className={o.expired ? 'is-expired' : o.status === 'superseded' ? 'is-superseded' : ''}
                onClick={() => onOpen(o.id)}
                style={{ cursor: 'pointer' }}
              >
                <td className="mono">
                  <button className="linklike mono" onClick={() => onOpen(o.id)}>
                    {o.number ?? `DRAFT #${o.id}`}
                  </button>
                </td>
                <td>{o.title}</td>
                <td>{o.customer_name}</td>
                <td>
                  <StatusBadge status={o.status} />
                </td>
                <td className="mono table__id">{o.valid_until ? fmtDate(o.valid_until) : '—'}</td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>{fmtEur(o.net_cents)}</td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>{fmtEur(o.gross_cents)}</td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={7}>
                  NO OFFERS MATCH
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
