import { useCallback, useEffect, useState } from 'react';
import type { DashboardStats, OfferRow } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDate, fmtEur } from '../format';
import { StatusBadge } from './StatusBadge';

interface Props {
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}

export function Dashboard({ onOpen, onAuthLost }: Props) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recent, setRecent] = useState<OfferRow[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([api.stats(), api.offers(new URLSearchParams())]);
      setStats(s);
      setRecent(list.offers.slice(0, 8));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <div className="resource__error mono">{error}</div>;
  if (!stats) return <div className="boot mono">LOADING…</div>;

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ OFF.00 · OVERVIEW</div>
          <h1 className="resource__title">Dashboard</h1>
          <p className="resource__desc">Pipeline figures for {stats.period} — all values derived from the offer lines.</p>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat stat--total">
          <div className="stat__label mono">OPEN (SENT)</div>
          <div className="stat__value">{fmtEur(stats.open_value_cents)}</div>
          <div className="stat__sub mono">{stats.open_count} OFFERS AWAITING A DECISION</div>
        </div>
        <div className="stat">
          <div className="stat__label mono">ACCEPTED</div>
          <div className="stat__value">{fmtEur(stats.accepted_value_cents)}</div>
          <div className="stat__sub mono">{stats.accepted_count} WON</div>
        </div>
        <div className="stat">
          <div className="stat__label mono">REJECTED</div>
          <div className="stat__value">{fmtEur(stats.rejected_value_cents)}</div>
          <div className="stat__sub mono">{stats.rejected_count} LOST</div>
        </div>
        <div className="stat">
          <div className="stat__label mono">EXPIRED</div>
          <div className="stat__value">{fmtEur(stats.expired_value_cents)}</div>
          <div className="stat__sub mono">{stats.expired_count} LAPSED</div>
        </div>
        <div className="stat">
          <div className="stat__label mono">WIN RATE</div>
          <div className="stat__value">{stats.win_rate_pct}%</div>
          <div className="stat__sub mono">OF DECIDED OFFERS</div>
        </div>
      </div>

      <div className="section-title mono">RECENT OFFERS</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">NUMBER</th>
              <th className="mono">TITLE</th>
              <th className="mono">CUSTOMER</th>
              <th className="mono">STATUS</th>
              <th className="mono">VALID UNTIL</th>
              <th className="mono" style={{ textAlign: 'right' }}>GROSS</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((o) => (
              <tr
                key={o.id}
                className={o.expired ? 'is-expired' : ''}
                onClick={() => onOpen(o.id)}
                style={{ cursor: 'pointer' }}
              >
                <td className="mono">{o.number ?? `DRAFT #${o.id}`}</td>
                <td>{o.title}</td>
                <td>{o.customer_name}</td>
                <td>
                  <StatusBadge status={o.status} />
                </td>
                <td className="mono table__id">{o.valid_until ? fmtDate(o.valid_until) : '—'}</td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>{fmtEur(o.gross_cents)}</td>
              </tr>
            ))}
            {recent.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={6}>
                  NO OFFERS YET
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
