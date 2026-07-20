import { useCallback, useEffect, useState } from 'react';
import type { AppConfig, Dashboard } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDate, fmtDaysUntil, fmtEur } from '../format';
import { DeadlineBadge } from './Badges';

interface Props {
  config: AppConfig;
  onAuthLost: () => void;
  onOpenApplication: (id: number) => void;
}

export function DeadlinesDashboard({ config, onAuthLost, onOpenApplication }: Props) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api.dashboard());
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load the dashboard');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ SUB.01 · DEADLINES</div>
          <h1 className="resource__title">Deadlines</h1>
          <p className="resource__desc">
            Everything here is derived at read time from the wall clock: application deadlines of programs we
            can still apply to, and our post-award reporting obligations. At-risk means due within {config.at_risk_days}{' '}
            days; overdue means the due day has passed.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      {data && (
        <>
          <div className="stat-row">
            <div className="stat stat--alert">
              <div className="stat__label mono">OVERDUE</div>
              <div className="stat__value num">{data.totals.overdue}</div>
            </div>
            <div className="stat stat--warn">
              <div className="stat__label mono">AT RISK · ≤{config.at_risk_days}D</div>
              <div className="stat__value num">{data.totals.at_risk}</div>
            </div>
            <div className="stat">
              <div className="stat__label mono">UPCOMING</div>
              <div className="stat__value num">{data.totals.upcoming}</div>
            </div>
          </div>

          <div className="section-title mono">PORTFOLIO · DERIVED</div>
          <div className="stat-row">
            <div className="stat">
              <div className="stat__label mono">REQUESTED</div>
              <div className="stat__value stat__value--money num">{fmtEur(data.portfolio.requested_cents)}</div>
            </div>
            <div className="stat stat--ok">
              <div className="stat__label mono">APPROVED</div>
              <div className="stat__value stat__value--money num">{fmtEur(data.portfolio.approved_cents)}</div>
            </div>
            <div className="stat">
              <div className="stat__label mono">DISBURSED</div>
              <div className="stat__value stat__value--money num">{fmtEur(data.portfolio.disbursed_cents)}</div>
            </div>
            <div className="stat stat--warn">
              <div className="stat__label mono">REMAINING</div>
              <div className="stat__value stat__value--money num">{fmtEur(data.portfolio.remaining_cents)}</div>
            </div>
          </div>

          <div className="section-title mono">PROGRAM APPLICATION DEADLINES · OPEN PROGRAMS</div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="mono">PROGRAM</th>
                  <th className="mono">FUNDING BODY</th>
                  <th className="mono">DEADLINE</th>
                  <th className="mono">WHEN</th>
                  <th className="mono">STATE</th>
                </tr>
              </thead>
              <tbody>
                {data.program_deadlines.map((d) => (
                  <tr key={`p${d.program_id}`}>
                    <td>{d.program_name}</td>
                    <td className="table__id">{d.funding_body}</td>
                    <td className="mono">{fmtDate(d.due_date)}</td>
                    <td className="mono table__id">{fmtDaysUntil(d.due_date)}</td>
                    <td>
                      <DeadlineBadge state={d.state} />
                    </td>
                  </tr>
                ))}
                {data.program_deadlines.length === 0 && (
                  <tr>
                    <td className="table__empty mono" colSpan={5}>
                      NO OPEN PROGRAMS WITH A DEADLINE
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="section-title mono">REPORTING OBLIGATIONS · OUTSTANDING</div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="mono">OBLIGATION</th>
                  <th className="mono">APPLICATION</th>
                  <th className="mono">PROGRAM</th>
                  <th className="mono">DUE</th>
                  <th className="mono">WHEN</th>
                  <th className="mono">STATE</th>
                </tr>
              </thead>
              <tbody>
                {data.obligation_deadlines.map((o) => (
                  <tr key={`o${o.obligation_id}`}>
                    <td>{o.title}</td>
                    <td className="mono">
                      <button className="linklike mono" onClick={() => onOpenApplication(o.application_id)}>
                        {o.application_ref}
                      </button>
                    </td>
                    <td className="table__id">{o.program_name}</td>
                    <td className="mono">{fmtDate(o.due_date)}</td>
                    <td className="mono table__id">{fmtDaysUntil(o.due_date)}</td>
                    <td>
                      <DeadlineBadge state={o.state} />
                    </td>
                  </tr>
                ))}
                {data.obligation_deadlines.length === 0 && (
                  <tr>
                    <td className="table__empty mono" colSpan={6}>
                      NO OUTSTANDING OBLIGATIONS
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
