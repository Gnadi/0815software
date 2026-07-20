import { useCallback, useEffect, useState } from 'react';
import type { AppConfig, Dashboard as DashboardData } from '../../shared/types';
import { api, ApiError } from '../api';

interface Props {
  config: AppConfig;
  onAuthLost: () => void;
}

export function Dashboard({ config, onAuthLost }: Props) {
  const [data, setData] = useState<DashboardData | null>(null);
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
          <div className="resource__eyebrow mono">§ SUP.02 · SLA DASHBOARD</div>
          <h1 className="resource__title">SLA dashboard</h1>
          <p className="resource__desc">
            Everything here is derived: a ticket is counted as breached when its first-response or resolution
            leg is past due, and at-risk within {config.at_risk_minutes} minutes of a due time. Closed tickets
            are excluded.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      {data && (
        <>
          <div className="stat-row">
            <div className="stat">
              <div className="stat__label mono">OPEN WORK</div>
              <div className="stat__value">{data.totals.open}</div>
            </div>
            <div className="stat stat--alert">
              <div className="stat__label mono">BREACHED</div>
              <div className="stat__value">{data.totals.breached}</div>
            </div>
            <div className="stat stat--warn">
              <div className="stat__label mono">AT RISK</div>
              <div className="stat__value">{data.totals.at_risk}</div>
            </div>
            <div className="stat">
              <div className="stat__label mono">UNASSIGNED</div>
              <div className="stat__value">{data.totals.unassigned}</div>
            </div>
          </div>

          <div className="section-title mono">BY PRIORITY</div>
          <div className="grid-cards">
            {data.by_priority.map((b) => (
              <div className="pcard" key={b.priority}>
                <div className="pcard__head">
                  <span className={`badge mono badge--${b.priority}`}>{b.priority.toUpperCase()}</span>
                  <span className="pcard__count mono">{b.open} OPEN</span>
                </div>
                <div className="pcard__legs">
                  <div className="pcard__leg">
                    <span className={`pcard__leg-val ${b.breached > 0 ? 'is-breached' : ''}`}>{b.breached}</span>
                    <span className="pcard__leg-label mono">BREACHED</span>
                  </div>
                  <div className="pcard__leg">
                    <span className={`pcard__leg-val ${b.at_risk > 0 ? 'is-risk' : ''}`}>{b.at_risk}</span>
                    <span className="pcard__leg-label mono">AT RISK</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="section-title mono">BY STATUS</div>
          <div className="stat-row">
            {config.statuses.map((s) => (
              <div className="stat" key={s}>
                <div className="stat__label mono">{s.toUpperCase()}</div>
                <div className="stat__value">{data.by_status[s] ?? 0}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
