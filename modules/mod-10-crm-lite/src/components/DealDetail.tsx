import { useCallback, useEffect, useState } from 'react';
import type { AppConfig, DealDetail } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDateTime, fmtEur } from '../format';
import { ActivityBadge, StageBadge, activeStages } from './ui';
import { ActivityForm } from './ActivityForm';
import { DealEditor } from './DealEditor';

export function DealDetailView({
  id,
  config,
  onBack,
  onOpenContact,
  onOpenCompany,
  onAuthLost,
}: {
  id: number;
  config: AppConfig;
  onBack: () => void;
  onOpenContact: (id: number) => void;
  onOpenCompany: (id: number) => void;
  onAuthLost: () => void;
}) {
  const [deal, setDeal] = useState<DealDetail | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setDeal(await api.deal(id));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load deal');
    }
  }, [id, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Action failed');
    }
  }

  function move(toStage: string, label: string) {
    const note = window.prompt(`Move to ${label} — note (optional):`, '');
    if (note === null) return;
    void act(() => api.moveStage(id, toStage, note || undefined));
  }

  function reopen() {
    const stages = activeStages(config.stages);
    const target = window.prompt(
      `Reopen to which stage? (${stages.map((s) => s.key).join(', ')})`,
      stages[0]!.key,
    );
    if (target === null) return;
    void act(() => api.reopenDeal(id, target));
  }

  if (!deal) {
    return <div className="boot mono">{error || 'LOADING…'}</div>;
  }

  const targets = config.stages.filter((s) => s.key !== deal.stage && !deal.terminal);

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← BACK TO PIPELINE
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">DEAL #{deal.id}</div>
          <h1 className="resource__title">{deal.title}</h1>
          <p className="resource__desc">
            <button className="linklike" onClick={() => onOpenCompany(deal.company_id)}>
              {deal.company_name}
            </button>
            {deal.primary_contact_id && deal.primary_contact_name && (
              <>
                {' · '}
                <button className="linklike" onClick={() => onOpenContact(deal.primary_contact_id!)}>
                  {deal.primary_contact_name}
                </button>
              </>
            )}
          </p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--ghost" onClick={() => setEditing(true)}>
            EDIT
          </button>
          {deal.terminal ? (
            <button className="btn btn--primary" onClick={reopen}>
              REOPEN
            </button>
          ) : (
            targets.map((t) => (
              <button key={t.key} className="btn btn--ghost" onClick={() => move(t.key, t.label)}>
                → {t.label.toUpperCase()}
              </button>
            ))
          )}
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="detail-grid">
        <div>
          <div className="section-title mono">STAGE HISTORY (APPEND-ONLY)</div>
          <div className="timeline">
            {[...deal.stage_events].reverse().map((e) => (
              <div
                key={e.id}
                className={`tl-item ${e.kind === 'reopen' ? 'is-reopen' : e.to_stage === 'won' ? 'is-won' : ''}`}
              >
                <div className="tl-item__head">
                  <span className="tl-item__title">
                    {e.kind === 'open'
                      ? `Opened at ${labelFor(config, e.to_stage)}`
                      : e.kind === 'reopen'
                        ? `Reopened ${labelFor(config, e.from_stage)} → ${labelFor(config, e.to_stage)}`
                        : `${labelFor(config, e.from_stage)} → ${labelFor(config, e.to_stage)}`}
                  </span>
                  <span className="tl-item__time mono">{fmtDateTime(e.created_at)}</span>
                </div>
                {e.note && <div className="tl-item__body">{e.note}</div>}
              </div>
            ))}
          </div>

          <div className="section-title mono">ACTIVITY TIMELINE</div>
          <ActivityForm
            config={config}
            dealId={deal.id}
            onLogged={() => void load()}
            onAuthLost={onAuthLost}
          />
          <div className="timeline" style={{ marginTop: 14 }}>
            {deal.activities.length === 0 && <div className="board__empty mono">NO ACTIVITY YET</div>}
            {deal.activities.map((a) => (
              <div key={a.id} className="tl-item">
                <div className="tl-item__head">
                  <span className="tl-item__title">
                    <ActivityBadge type={a.type} /> {a.subject}
                  </span>
                  <span className="tl-item__time mono">{fmtDateTime(a.created_at)}</span>
                </div>
                {a.body && <div className="tl-item__body">{a.body}</div>}
                {a.due_date && (
                  <div className="tl-item__meta mono">
                    FOLLOW-UP DUE {a.due_date} {a.done ? '· DONE' : ''}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="detail-side">
          <div className="panel">
            <div className="panel__label mono">DEAL</div>
            <div>
              <StageBadge stageKey={deal.stage} label={deal.stage_label} />
            </div>
            <dl className="kv">
              <dt>Value</dt>
              <dd>{fmtEur(deal.value_cents)}</dd>
              <dt>Probability</dt>
              <dd>{deal.probability}%</dd>
              <dt>Expected</dt>
              <dd>{fmtEur(deal.expected_value_cents)}</dd>
              <dt>Created</dt>
              <dd>{fmtDateTime(deal.created_at)}</dd>
            </dl>
            {deal.note && <div className="tl-item__body">{deal.note}</div>}
          </div>
        </div>
      </div>

      {editing && (
        <DealEditor
          config={config}
          deal={deal}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
          onAuthLost={onAuthLost}
        />
      )}
    </div>
  );
}

function labelFor(config: AppConfig, key: string | null): string {
  if (key === null) return '—';
  return config.stages.find((s) => s.key === key)?.label ?? key;
}
