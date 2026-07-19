import { useCallback, useEffect, useState } from 'react';
import type { Metrics } from '../../shared/types';
import { api, ApiError, dealsCsvUrl } from '../api';
import { fmtEur } from '../format';

export function Dashboard({ onAuthLost }: { onAuthLost: () => void }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setMetrics(await api.metrics(from || undefined, to || undefined));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load metrics');
    }
  }, [from, to, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!metrics) {
    return <div className="boot mono">{error || 'LOADING…'}</div>;
  }

  const maxValue = Math.max(1, ...metrics.stages.map((s) => s.value_cents));
  const winRate = metrics.win_rate.rate;

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">DASHBOARD</div>
          <h1 className="resource__title">Pipeline</h1>
          <p className="resource__desc">
            Every figure below is derived on read from the deals and the pipeline config — nothing is
            stored or cached.
          </p>
        </div>
        <div className="resource__actions">
          <a className="btn btn--ghost" href={dealsCsvUrl}>
            EXPORT DEALS CSV ↓
          </a>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="stat-row">
        <div className="stat stat--total">
          <div className="stat__label mono">OPEN DEALS</div>
          <div className="stat__value">
            {metrics.stages
              .filter((s) => !s.terminal)
              .reduce((n, s) => n + s.count, 0)}
          </div>
        </div>
        <div className="stat">
          <div className="stat__label mono">OPEN VALUE</div>
          <div className="stat__value">
            {fmtEur(metrics.stages.filter((s) => !s.terminal).reduce((n, s) => n + s.value_cents, 0))}
          </div>
        </div>
        <div className="stat">
          <div className="stat__label mono">WEIGHTED (EXPECTED)</div>
          <div className="stat__value">
            {fmtEur(metrics.stages.filter((s) => !s.terminal).reduce((n, s) => n + s.expected_value_cents, 0))}
          </div>
        </div>
        <div className="stat">
          <div className="stat__label mono">WIN RATE</div>
          <div className="stat__value">
            {winRate === null ? '—' : `${Math.round(winRate * 100)}%`}
          </div>
        </div>
      </div>

      <div className="section-title mono">PER-STAGE — COUNT · VALUE · EXPECTED VALUE</div>
      <div className="funnel">
        {metrics.stages.map((stage) => (
          <div className="funnel__row" key={stage.key}>
            <span className="funnel__label">{stage.label}</span>
            <div className="funnel__bar">
              <div
                className="funnel__fill"
                style={{ width: `${(stage.value_cents / maxValue) * 100}%` }}
              />
              <div className="funnel__text">
                <span>
                  {fmtEur(stage.value_cents)}
                  <span className="funnel__count"> · exp {fmtEur(stage.expected_value_cents)}</span>
                </span>
                <span className="funnel__count">{stage.count} deal{stage.count === 1 ? '' : 's'} · {stage.probability}%</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="section-title mono">WIN RATE OVER A DATE RANGE</div>
      <div className="toolbar">
        <label className="field toolbar__filter">
          <span className="field__label mono">FROM</span>
          <input className="field__input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field toolbar__filter">
          <span className="field__label mono">TO</span>
          <input className="field__input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button className="btn btn--ghost" onClick={() => { setFrom(''); setTo(''); }}>
          CLEAR
        </button>
      </div>
      <div className="stat-row">
        <div className="stat">
          <div className="stat__label mono">WON</div>
          <div className="stat__value">{metrics.win_rate.won}</div>
        </div>
        <div className="stat">
          <div className="stat__label mono">LOST</div>
          <div className="stat__value">{metrics.win_rate.lost}</div>
        </div>
        <div className="stat stat--total">
          <div className="stat__label mono">WIN RATE {from || to ? '(RANGE)' : '(ALL TIME)'}</div>
          <div className="stat__value">{winRate === null ? '—' : `${Math.round(winRate * 100)}%`}</div>
        </div>
      </div>
    </div>
  );
}
