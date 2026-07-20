import { useCallback, useEffect, useState } from 'react';
import type { AppConfig, Dashboard } from '../../shared/types';
import { api, ApiError, EXPORT_URL } from '../api';
import { fmtEur } from '../format';

interface Props {
  config: AppConfig;
  onAuthLost: () => void;
}

export function PortfolioView({ config, onAuthLost }: Props) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api.dashboard());
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load the portfolio');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const p = data?.portfolio;

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ SUB.04 · PORTFOLIO</div>
          <h1 className="resource__title">Portfolio</h1>
          <p className="resource__desc">
            Every figure is derived: requested is the sum across all applications, approved and disbursed come
            from approved applications and their append-only tranches, and remaining is approved − disbursed.
          </p>
        </div>
        <div className="resource__actions">
          <a className="btn btn--ghost" href={EXPORT_URL}>
            EXPORT CSV ↓
          </a>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      {p && (
        <>
          <div className="stat-row">
            <div className="stat">
              <div className="stat__label mono">REQUESTED</div>
              <div className="stat__value stat__value--money num">{fmtEur(p.requested_cents)}</div>
              <div className="stat__sub mono">{p.application_count} APPLICATIONS</div>
            </div>
            <div className="stat stat--ok">
              <div className="stat__label mono">APPROVED</div>
              <div className="stat__value stat__value--money num">{fmtEur(p.approved_cents)}</div>
              <div className="stat__sub mono">{p.counts_by_status.approved} GRANTED</div>
            </div>
            <div className="stat">
              <div className="stat__label mono">DISBURSED</div>
              <div className="stat__value stat__value--money num">{fmtEur(p.disbursed_cents)}</div>
            </div>
            <div className="stat stat--warn">
              <div className="stat__label mono">REMAINING</div>
              <div className="stat__value stat__value--money num">{fmtEur(p.remaining_cents)}</div>
            </div>
          </div>

          <div className="section-title mono">APPLICATIONS BY STATUS</div>
          <div className="stat-row">
            {config.statuses.map((s) => (
              <div className="stat" key={s}>
                <div className="stat__label mono">{s.replace('_', ' ').toUpperCase()}</div>
                <div className="stat__value num">{p.counts_by_status[s] ?? 0}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
