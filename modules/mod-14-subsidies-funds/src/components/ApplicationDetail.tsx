import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  ApplicationDetail as ApplicationDetailData,
  ApplicationEvent,
  ApplicationStatus,
} from '../../shared/types';
import { api, ApiError } from '../api';
import { eurosToCents, fmtDate, fmtDateTime, fmtEur, centsToInput } from '../format';
import { DeadlineBadge, StatusBadge } from './Badges';

interface Props {
  applicationId: number;
  onBack: () => void;
  onAuthLost: () => void;
}

function eventLine(ev: ApplicationEvent): string {
  if (ev.type === 'created') return 'Application created as a draft.';
  const base = `${ev.from_status?.replace('_', ' ')} → ${ev.to_status.replace('_', ' ')}`;
  if (ev.to_status === 'approved' && ev.approved_amount_cents !== null) {
    return `${base} · approved ${fmtEur(ev.approved_amount_cents)}`;
  }
  return base;
}

export function ApplicationDetail({ applicationId, onBack, onAuthLost }: Props) {
  const [app, setApp] = useState<ApplicationDetailData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [approveAmount, setApproveAmount] = useState('');
  const [showApprove, setShowApprove] = useState(false);
  const [tranche, setTranche] = useState({ on: fmtDate(new Date().toISOString()), amount: '', reference: '', note: '' });
  const [obligation, setObligation] = useState({ title: '', due: '' });

  const load = useCallback(async () => {
    try {
      setApp(await api.application(applicationId));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load the application');
    }
  }, [applicationId, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<ApplicationDetailData>) {
    setBusy(true);
    setError('');
    try {
      setApp(await fn());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof ApiError ? err.message : 'Action failed');
      throw err;
    } finally {
      setBusy(false);
    }
  }

  async function move(to: ApplicationStatus) {
    if (to === 'approved') {
      setShowApprove(true);
      return;
    }
    await act(() => api.transition(applicationId, { to })).catch(() => {});
  }

  async function submitApprove(event: FormEvent) {
    event.preventDefault();
    const cents = eurosToCents(approveAmount);
    if (cents === null) {
      setError('Approved amount must be an amount like 30000 or 30000.00');
      return;
    }
    try {
      await act(() => api.transition(applicationId, { to: 'approved', approved_amount_cents: cents }));
      setShowApprove(false);
      setApproveAmount('');
    } catch {
      /* error already surfaced */
    }
  }

  async function addTranche(event: FormEvent) {
    event.preventDefault();
    const cents = eurosToCents(tranche.amount);
    if (cents === null) {
      setError('Tranche amount must be an amount like 5000 or 5000.00');
      return;
    }
    try {
      await act(() =>
        api.addTranche(applicationId, {
          disbursed_on: tranche.on,
          amount_cents: cents,
          reference: tranche.reference || null,
          note: tranche.note || null,
        }),
      );
      setTranche({ on: fmtDate(new Date().toISOString()), amount: '', reference: '', note: '' });
    } catch {
      /* error already surfaced (e.g. over-disbursement 422) */
    }
  }

  async function addObligation(event: FormEvent) {
    event.preventDefault();
    try {
      await act(() => api.addObligation(applicationId, { title: obligation.title, due_date: obligation.due }));
      setObligation({ title: '', due: '' });
    } catch {
      /* error already surfaced */
    }
  }

  if (!app) {
    return (
      <div>
        <button className="backlink mono" onClick={onBack}>
          ← BACK TO APPLICATIONS
        </button>
        {error ? <div className="resource__error mono">{error}</div> : <div className="boot mono">LOADING…</div>}
      </div>
    );
  }

  const approved = app.status === 'approved';
  const remaining = app.remaining_cents ?? 0;

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← BACK TO APPLICATIONS
      </button>

      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">{app.ref} · {app.program_name.toUpperCase()}</div>
          <h1 className="resource__title">{app.title}</h1>
          <p className="resource__desc">
            {app.funding_body}
            {app.reference ? ` · case ${app.reference}` : ''}
            {app.submission_date ? ` · submitted ${fmtDate(app.submission_date)}` : ''}
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="detail">
        <div className="detail__main">
          {app.notes && (
            <div className="panel">
              <div className="panel__title mono">NOTES</div>
              <div style={{ fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{app.notes}</div>
            </div>
          )}

          <div className="section-title mono">STATUS TIMELINE · APPEND-ONLY</div>
          <div className="thread">
            {app.events.map((ev) => (
              <div className="event" key={ev.id}>
                <div className="event__meta">
                  <span className="event__when mono">{fmtDateTime(ev.created_at)}</span>
                  <span className="event__actor">{ev.actor}</span>
                </div>
                <div className="event__body">
                  {eventLine(ev)}
                  {ev.note && <div className="event__note">{ev.note}</div>}
                </div>
              </div>
            ))}
          </div>

          <div className="section-title mono">DISBURSEMENTS · TRANCHES</div>
          <div className="rows">
            {app.tranches.map((t) => (
              <div className="linerow" key={t.id}>
                <div className="linerow__main">
                  <span className="linerow__title">{fmtDate(t.disbursed_on)}</span>
                  <span className="linerow__meta mono">
                    {t.reference ?? 'no reference'}
                    {t.note ? ` · ${t.note}` : ''}
                  </span>
                </div>
                <span className="linerow__amount">{fmtEur(t.amount_cents)}</span>
              </div>
            ))}
            {app.tranches.length === 0 && <div className="rows__empty mono">NO TRANCHES RECORDED</div>}
          </div>

          {approved && remaining > 0 && (
            <form className="form" style={{ marginTop: 16 }} onSubmit={(e) => void addTranche(e)}>
              <div className="form__grid">
                <label className="field">
                  <span className="field__label mono">DISBURSED ON</span>
                  <input className="field__input" type="date" value={tranche.on} onChange={(e) => setTranche({ ...tranche, on: e.target.value })} required />
                </label>
                <label className="field">
                  <span className="field__label mono">AMOUNT (EUR)</span>
                  <input className="field__input" value={tranche.amount} onChange={(e) => setTranche({ ...tranche, amount: e.target.value })} placeholder={centsToInput(remaining)} required />
                </label>
                <label className="field">
                  <span className="field__label mono">REFERENCE</span>
                  <input className="field__input" value={tranche.reference} onChange={(e) => setTranche({ ...tranche, reference: e.target.value })} />
                </label>
              </div>
              <div className="form__hint mono">REMAINING {fmtEur(remaining)} — a tranche above this is rejected (422).</div>
              <div className="form__actions">
                <button className="btn btn--primary" type="submit" disabled={busy}>
                  RECORD TRANCHE →
                </button>
              </div>
            </form>
          )}

          <div className="section-title mono">REPORTING OBLIGATIONS</div>
          <div className="rows">
            {app.obligations.map((o) => (
              <div className="linerow" key={o.id}>
                <div className="linerow__main">
                  <span className="linerow__title">{o.title}</span>
                  <span className="linerow__meta mono">
                    due {fmtDate(o.due_date)}
                    {o.done_at ? ` · done ${fmtDate(o.done_at)}` : ''}
                  </span>
                </div>
                <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <DeadlineBadge state={o.state} />
                  <button className={`chooser__btn ${o.done ? 'is-active' : ''}`} disabled={busy} onClick={() => void act(() => api.toggleObligation(o.id)).catch(() => {})}>
                    {o.done ? 'DONE' : 'MARK DONE'}
                  </button>
                </span>
              </div>
            ))}
            {app.obligations.length === 0 && <div className="rows__empty mono">NO OBLIGATIONS</div>}
          </div>

          {approved && (
            <form className="form" style={{ marginTop: 16 }} onSubmit={(e) => void addObligation(e)}>
              <div className="form__grid">
                <label className="field">
                  <span className="field__label mono">OBLIGATION TITLE</span>
                  <input className="field__input" value={obligation.title} onChange={(e) => setObligation({ ...obligation, title: e.target.value })} placeholder="Interim report" required />
                </label>
                <label className="field">
                  <span className="field__label mono">DUE DATE</span>
                  <input className="field__input" type="date" value={obligation.due} onChange={(e) => setObligation({ ...obligation, due: e.target.value })} required />
                </label>
              </div>
              <div className="form__actions">
                <button className="btn btn--primary" type="submit" disabled={busy}>
                  ADD OBLIGATION →
                </button>
              </div>
            </form>
          )}
        </div>

        <aside className="detail__side">
          <div className="panel">
            <div className="panel__title mono">STATE</div>
            <div className="panel__row">
              <span className="mono">STATUS</span>
              <StatusBadge status={app.status} />
            </div>
            <div className="panel__row">
              <span className="mono">ELIGIBLE COSTS</span>
              <span className="num mono">{fmtEur(app.eligible_costs_cents)}</span>
            </div>
            <div className="panel__row">
              <span className="mono">FUNDING CAP · {app.program_funding_rate}%</span>
              <span className="num mono">{fmtEur(app.funding_cap_cents)}</span>
            </div>
            <div className="panel__row">
              <span className="mono">REQUESTED</span>
              <span className="num mono">{fmtEur(app.requested_amount_cents)}</span>
            </div>
            <div className="panel__row">
              <span className="mono">APPROVED</span>
              <span className="num mono">{app.approved_amount_cents === null ? '—' : fmtEur(app.approved_amount_cents)}</span>
            </div>
            <div className="panel__row">
              <span className="mono">DISBURSED</span>
              <span className="num mono">{approved ? fmtEur(app.disbursed_cents) : '—'}</span>
            </div>
            <div className="panel__row panel__row--strong">
              <span className="mono">REMAINING</span>
              <span className="num mono">{app.remaining_cents === null ? '—' : fmtEur(app.remaining_cents)}</span>
            </div>
            {app.fully_disbursed && <div className="form__hint mono" style={{ color: 'var(--ok)' }}>FULLY DISBURSED ✓</div>}
          </div>

          <div className="panel">
            <div className="panel__title mono">ADVANCE STATUS</div>
            {app.allowed_transitions.length === 0 ? (
              <div className="form__hint mono">TERMINAL — NO FURTHER MOVES</div>
            ) : (
              <div className="chooser">
                {app.allowed_transitions.map((to) => (
                  <button
                    key={to}
                    className={`chooser__btn ${to === 'rejected' || to === 'withdrawn' ? 'chooser__btn--danger' : ''}`}
                    disabled={busy}
                    onClick={() => void move(to)}
                  >
                    {to.replace('_', ' ').toUpperCase()}
                  </button>
                ))}
              </div>
            )}
            {showApprove && (
              <form onSubmit={(e) => void submitApprove(e)} style={{ display: 'grid', gap: 10, marginTop: 8 }}>
                <label className="field">
                  <span className="field__label mono">APPROVED AMOUNT (EUR)</span>
                  <input className="field__input" value={approveAmount} onChange={(e) => setApproveAmount(e.target.value)} placeholder={centsToInput(app.requested_amount_cents)} autoFocus />
                </label>
                <div className="form__hint mono">MAX GRANT {fmtEur(app.program_max_grant_cents)} — above it is rejected (422).</div>
                <div className="chooser">
                  <button className="btn btn--primary btn--sm" type="submit" disabled={busy}>
                    APPROVE →
                  </button>
                  <button className="chooser__btn" type="button" onClick={() => setShowApprove(false)}>
                    CANCEL
                  </button>
                </div>
              </form>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
