import { useCallback, useEffect, useState } from 'react';
import type { CaseRow } from '../../shared/types';
import { api, ApiError, type AppConfig, type Overview } from '../api';
import { fmtDate, humanize } from '../format';
import { DeadlineBadge, StatusBadge } from './Badges';

interface Props {
  config: AppConfig;
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}

export function CaseQueue({ config, onOpen, onAuthLost }: Props) {
  const [rows, setRows] = useState<CaseRow[] | null>(null);
  const [counts, setCounts] = useState<Overview | null>(null);
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [attention, setAttention] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (category) params.set('category', category);
      if (attention) params.set('attention', 'true');
      const [list, overview] = await Promise.all([api.cases(params), api.overview()]);
      setRows(list.cases);
      setCounts(overview);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load the queue');
    }
  }, [status, category, attention, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ WB.01 · CASES</div>
          <h1 className="resource__title">Reports</h1>
          <p className="resource__desc">
            Every report, with both statutory clocks recomputed on this read. Nothing here is a stored flag that a
            missed nightly job could leave false.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      {counts && (
        <div className="stat-row">
          <div className={`stat ${counts.acknowledgement_missed > 0 ? 'stat--alert' : ''}`}>
            <div className="stat__label mono">ACKNOWLEDGEMENT MISSED</div>
            <div className="stat__value num mono">{counts.acknowledgement_missed}</div>
            <div className="stat__sub mono">§ 17 ABS. 1 · 7 DAYS</div>
          </div>
          <div className={`stat ${counts.feedback_missed > 0 ? 'stat--alert' : ''}`}>
            <div className="stat__label mono">FEEDBACK MISSED</div>
            <div className="stat__value num mono">{counts.feedback_missed}</div>
            <div className="stat__sub mono">§ 17 ABS. 2 · 3 MONTHS</div>
          </div>
          <div className={`stat ${counts.feedback_at_risk > 0 ? 'stat--warn' : ''}`}>
            <div className="stat__label mono">FEEDBACK AT RISK</div>
            <div className="stat__value num mono">{counts.feedback_at_risk}</div>
            <div className="stat__sub mono">WITHIN A FORTNIGHT</div>
          </div>
          <div className="stat">
            <div className="stat__label mono">OPEN</div>
            <div className="stat__value num mono">{counts.open}</div>
            <div className="stat__sub mono">OF {counts.total} TOTAL</div>
          </div>
          <div className={`stat ${counts.due_for_erasure > 0 ? 'stat--warn' : ''}`}>
            <div className="stat__label mono">DUE FOR ERASURE</div>
            <div className="stat__value num mono">{counts.due_for_erasure}</div>
            <div className="stat__sub mono">§ 11 ABS. 5 · 3 YEARS</div>
          </div>
        </div>
      )}

      <div className="toolbar">
        <select className="toolbar__select mono" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">ALL STATUSES</option>
          {config.statuses.map((value) => (
            <option key={value} value={value}>
              {humanize(value)}
            </option>
          ))}
        </select>
        <select className="toolbar__select mono" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">ALL CATEGORIES</option>
          {config.categories.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
        <label className="toolbar__check mono">
          <input type="checkbox" checked={attention} onChange={(e) => setAttention(e.target.checked)} />
          NEEDS ATTENTION ONLY
        </label>
        <span className="toolbar__count mono">{rows === null ? '…' : `${rows.length} CASE(S)`}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Ref</th>
              <th>Category</th>
              <th>Subject</th>
              <th>Filed</th>
              <th>Status</th>
              <th>Deadlines</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((row) => (
              <tr key={row.id} onClick={() => onOpen(row.id)}>
                <td className="mono">
                  <span className="linklike">{row.ref}</span>
                  {row.anonymous && <span className="badge mono badge--anon">ANON</span>}
                </td>
                <td className="mono table__muted">{humanize(row.category)}</td>
                <td>{row.subject ?? <span className="table__muted">— erased —</span>}</td>
                <td className="mono">{fmtDate(row.received_at)}</td>
                <td>
                  <StatusBadge status={row.status} />
                </td>
                <td>
                  <DeadlineBadge label="ACK" deadline={row.acknowledge} />
                  <DeadlineBadge label="FB" deadline={row.feedback} />
                </td>
              </tr>
            ))}
            {rows !== null && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="table__empty mono">
                  NO CASES MATCH THIS FILTER
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
