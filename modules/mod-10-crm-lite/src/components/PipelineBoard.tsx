import { useCallback, useEffect, useState } from 'react';
import type { AppConfig, DealRow } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtEur } from '../format';
import { DealEditor } from './DealEditor';

export function PipelineBoard({
  config,
  onOpen,
  onAuthLost,
}: {
  config: AppConfig;
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}) {
  const [deals, setDeals] = useState<DealRow[]>([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.deals(new URLSearchParams());
      setDeals(res.deals);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load deals');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function move(deal: DealRow, toStage: string) {
    const note = window.prompt(`Move "${deal.title}" to ${toStage} — note (optional):`, '');
    if (note === null) return;
    try {
      await api.moveStage(deal.id, toStage, note || undefined);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Move failed');
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">PIPELINE</div>
          <h1 className="resource__title">Board</h1>
          <p className="resource__desc">
            Columns come straight from the pipeline config. Move a deal with the stage buttons on its
            card; each move appends an event to the deal's history.
          </p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--primary" onClick={() => setCreating(true)}>
            + NEW DEAL
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="board">
        {config.stages.map((stage) => {
          const columnDeals = deals.filter((d) => d.stage === stage.key);
          const value = columnDeals.reduce((n, d) => n + d.value_cents, 0);
          const expected = columnDeals.reduce((n, d) => n + d.expected_value_cents, 0);
          const targets = config.stages.filter((s) => s.key !== stage.key && !stage.terminal);
          return (
            <div className={`board__col ${stage.terminal ? 'is-terminal' : ''}`} key={stage.key}>
              <div className="board__colhead">
                <div className="board__coltitle">
                  <span className="board__colname">{stage.label}</span>
                  <span className="board__colprob mono">{stage.probability}%</span>
                </div>
                <div className="board__coltotals mono">
                  <span>
                    <strong>{columnDeals.length}</strong> deal{columnDeals.length === 1 ? '' : 's'} · {fmtEur(value)}
                  </span>
                  <span>expected {fmtEur(expected)}</span>
                </div>
              </div>
              <div className="board__cards">
                {columnDeals.length === 0 && <div className="board__empty mono">EMPTY</div>}
                {columnDeals.map((deal) => (
                  <div className="card" key={deal.id}>
                    <button className="card__title linklike" onClick={() => onOpen(deal.id)}>
                      {deal.title}
                    </button>
                    <div className="card__company mono">{deal.company_name}</div>
                    <div className="card__row">
                      <span className="card__value">{fmtEur(deal.value_cents)}</span>
                      <span className="card__expected mono">exp {fmtEur(deal.expected_value_cents)}</span>
                    </div>
                    {!stage.terminal && targets.length > 0 && (
                      <div className="card__move">
                        {targets.map((t) => (
                          <button
                            key={t.key}
                            className="card__movebtn"
                            onClick={() => void move(deal, t.key)}
                            title={`Move to ${t.label}`}
                          >
                            → {t.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {creating && (
        <DealEditor
          config={config}
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            onOpen(id);
          }}
          onAuthLost={onAuthLost}
        />
      )}
    </div>
  );
}
