import { useCallback, useEffect, useState } from 'react';
import type { Balance, RequestDetail as RequestDetailData, RequestEvent } from '../../shared/types';
import { api, ApiError, type AppConfig } from '../api';
import { fmtDateTime, fmtDays, fmtRange } from '../format';
import { StatusBadge, TypeBadge } from './Badges';

interface Props {
  requestId: number;
  config: AppConfig;
  onBack: () => void;
  onAuthLost: () => void;
}

/**
 * Which buttons are offered, mirroring the TRANSITIONS map in
 * server/absences.ts. The server is the authority — it refuses anything else
 * with a 409 — so this list only decides what is worth showing.
 */
const ACTIONS: Record<string, { action: 'approve' | 'reject' | 'withdraw'; label: string; kind: string }[]> = {
  pending: [
    { action: 'approve', label: 'APPROVE ✓', kind: 'btn--primary' },
    { action: 'reject', label: 'REJECT ✕', kind: 'btn--danger' },
    { action: 'withdraw', label: 'WITHDRAW', kind: 'btn--ghost' },
  ],
  approved: [{ action: 'withdraw', label: 'WITHDRAW', kind: 'btn--ghost' }],
  rejected: [],
  withdrawn: [],
};

function eventLine(event: RequestEvent): string {
  if (event.from_status === null) return `Filed as ${event.to_status}`;
  return `${event.from_status} → ${event.to_status}`;
}

export function RequestDetail({ requestId, config, onBack, onAuthLost }: Props) {
  const [request, setRequest] = useState<RequestDetailData | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const detail = await api.request(requestId);
      setRequest(detail);
      setBalance(await api.balance(detail.employee_id, Number(detail.from_date.slice(0, 4))));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load the request');
    }
  }, [requestId, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(action: 'approve' | 'reject' | 'withdraw') {
    setBusy(true);
    setError('');
    try {
      await api.decide(requestId, action, note.trim() === '' ? undefined : note.trim());
      setNote('');
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof ApiError ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  if (!request) {
    return (
      <div>
        <button className="backlink mono" onClick={onBack}>
          ← BACK TO REQUESTS
        </button>
        {error ? <div className="resource__error mono">{error}</div> : <div className="boot mono">LOADING…</div>}
      </div>
    );
  }

  const type = config.types.find((candidate) => candidate.key === request.type);
  const actions = ACTIONS[request.status] ?? [];

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← BACK TO REQUESTS
      </button>

      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ ABS.02 · REQUEST #{request.id}</div>
          <h1 className="resource__title">{request.employee_name}</h1>
          <p className="resource__desc">
            {fmtRange(request.from_date, request.to_date)} · {fmtDays(request.days)} working{' '}
            {request.days === 1 ? 'day' : 'days'}
            {type && !type.deducts && ' · does not deduct from the annual entitlement'}
          </p>
        </div>
        <div className="resource__actions">
          <StatusBadge status={request.status} />
          <TypeBadge type={request.type} types={config.types} />
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="detail">
        <div className="detail__main">
          <section className="panel">
            <h2 className="panel__title mono">THE DAYS CHARGED</h2>
            <p className="panel__hint">
              Weekends and the public holidays of the employee's own region are already out. This is exactly the set
              the {fmtDays(request.days)}-day figure counts.
            </p>
            <div className="daygrid">
              {request.covered_days.map((day) => (
                <span key={day} className="daygrid__day mono">
                  {day}
                </span>
              ))}
              {request.covered_days.length === 0 && (
                <span className="daygrid__empty mono">NO WORKING DAYS IN THIS SPAN</span>
              )}
            </div>
            {(request.half_start || request.half_end) && (
              <div className="panel__note mono">
                HALF DAY ON {request.half_start ? 'THE FIRST' : ''}
                {request.half_start && request.half_end ? ' AND ' : ''}
                {request.half_end ? 'THE LAST' : ''} DAY
              </div>
            )}
            {request.note && <div className="panel__note">{request.note}</div>}
          </section>

          {actions.length > 0 && (
            <section className="panel">
              <h2 className="panel__title mono">DECIDE</h2>
              <label className="field">
                <span className="field__label mono">NOTE (RECORDED WITH THE DECISION)</span>
                <input
                  className="field__input"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional"
                />
              </label>
              <div className="chooser">
                {actions.map((action) => (
                  <button
                    key={action.action}
                    className={`btn ${action.kind}`}
                    disabled={busy}
                    onClick={() => void decide(action.action)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        <div className="detail__side">
          {balance && (
            <section className="panel">
              <h2 className="panel__title mono">BALANCE {balance.year}</h2>
              <dl className="kv">
                <div className="kv__row">
                  <dt className="mono">ENTITLED</dt>
                  <dd className="num mono">{fmtDays(balance.entitled_days)}</dd>
                </div>
                <div className="kv__row">
                  <dt className="mono">TAKEN</dt>
                  <dd className="num mono">{fmtDays(balance.taken_days)}</dd>
                </div>
                <div className="kv__row">
                  <dt className="mono">PENDING</dt>
                  <dd className="num mono">{fmtDays(balance.pending_days)}</dd>
                </div>
                <div className="kv__row kv__row--strong">
                  <dt className="mono">REMAINING</dt>
                  <dd className="num mono">{fmtDays(balance.remaining_days)}</dd>
                </div>
                {balance.carry_over_expired_days > 0 && (
                  <div className="kv__row">
                    <dt className="mono">CARRY-OVER LAPSED</dt>
                    <dd className="num mono">{fmtDays(balance.carry_over_expired_days)}</dd>
                  </div>
                )}
              </dl>
              <p className="panel__hint">
                Recomputed from the entitlement and the approved requests on every read — nothing here is stored, so
                nothing can drift.
              </p>
            </section>
          )}

          <section className="panel">
            <h2 className="panel__title mono">HISTORY</h2>
            <p className="panel__hint">Append-only. A decision is never edited or deleted, only followed by another.</p>
            <ol className="thread">
              {request.events.map((event) => (
                <li key={event.id} className="event">
                  <div className="event__head mono">
                    <span>{eventLine(event)}</span>
                    <span className="event__at">{fmtDateTime(event.at)}</span>
                  </div>
                  <div className="event__actor mono">{event.actor}</div>
                  {event.note && <div className="event__body">{event.note}</div>}
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}
