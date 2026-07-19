import { useCallback, useEffect, useState } from 'react';
import type { ChartRow } from '../../shared/types';
import { api, ApiError } from '../api';

interface Props {
  onAuthLost: () => void;
}

export function ChartsView({ onAuthLost }: Props) {
  const [charts, setCharts] = useState<ChartRow[]>([]);
  const [embeds, setEmbeds] = useState<Record<number, string>>({});
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { charts } = await api.charts();
      setCharts(charts);
      const map: Record<number, string> = {};
      for (const c of charts) {
        const e = await api.chartEmbed(c.id);
        map[c.id] = `${window.location.origin}${e.path}`;
      }
      setEmbeds(map);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : 'Failed to load charts');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(id: number) {
    if (!confirm('Delete this chart? Its embed URL will stop working.')) return;
    try {
      await api.deleteChart(id);
      void load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">SAVED CHARTS</div>
          <h1 className="resource__title">Charts</h1>
          <p className="resource__desc">
            Hand-rolled SVG charts, rendered server-side from a report. Each has a signed embed URL
            that renders standalone — no login — for use in an iframe. Build new charts from a
            report&rsquo;s Chart tab.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      {charts.length === 0 ? (
        <div className="table-wrap">
          <div className="table__empty mono">NO CHARTS YET — OPEN A REPORT AND USE THE CHART TAB</div>
        </div>
      ) : (
        <div className="cardlist">
          {charts.map((c) => (
            <div key={c.id} style={{ display: 'grid', gap: 12 }}>
              <div className="resource__head" style={{ marginBottom: 0 }}>
                <div>
                  <div className="reportcard__name">{c.name}</div>
                  <div className="reportcard__desc mono">
                    {c.kind.toUpperCase()} · {c.report_name} · {c.x_column} × {c.y_column}
                  </div>
                </div>
                <div className="reportcard__actions">
                  <button className="rowbtn rowbtn--danger" onClick={() => void remove(c.id)}>
                    DELETE
                  </button>
                </div>
              </div>
              <div className="chart-panel">
                <img src={`/api/charts/${c.id}/svg`} alt={c.name} />
              </div>
              {embeds[c.id] && (
                <div className="embed-box">
                  <span className="embed-box__label mono">EMBED URL</span>
                  <div className="embed-box__row">
                    <span className="embed-box__url">{embeds[c.id]}</span>
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => void navigator.clipboard?.writeText(embeds[c.id]!)}
                    >
                      COPY
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
