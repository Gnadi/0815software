import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { CaseDetail, CaseEvent, CaseOutcome, MessageVisibility } from '../../shared/types';
import { api, ApiError, type AppConfig } from '../api';
import { fmtDate, fmtDateTime, humanize } from '../format';
import { DeadlineBadge, OutcomeBadge, StatusBadge } from './Badges';

interface Props {
  caseId: number;
  config: AppConfig;
  onBack: () => void;
  onAuthLost: () => void;
}

function eventLine(event: CaseEvent): string {
  if (event.type === 'received') return 'Report filed';
  if (event.type === 'erased') return 'Documentation erased — § 11 Abs. 5 HinSchG';
  if (event.type === 'message') return 'Message';
  const move = `${humanize(event.from_status ?? '')} → ${humanize(event.to_status ?? '')}`;
  return event.outcome ? `${move} · ${humanize(event.outcome)}` : move;
}

export function CaseDetailView({ caseId, config, onBack, onAuthLost }: Props) {
  const [item, setItem] = useState<CaseDetail | null>(null);
  const [message, setMessage] = useState('');
  const [visibility, setVisibility] = useState<MessageVisibility>('reporter');
  const [outcome, setOutcome] = useState<CaseOutcome | ''>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItem(await api.case(caseId));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load the case');
    }
  }, [caseId, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<CaseDetail>): Promise<void> {
    setBusy(true);
    setError('');
    try {
      setItem(await fn());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof ApiError ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault();
    await act(() => api.message(caseId, visibility, message));
    setMessage('');
  }

  async function erase(): Promise<void> {
    const early = item?.erase_due_on !== null && (item?.erase_due_on ?? '') > config.now.slice(0, 10);
    const prompt = early
      ? `${item?.ref} is retained until ${item?.erase_due_on}. Erase it early anyway? This cannot be undone.`
      : `Erase the documentation for ${item?.ref}? The report, the contact details and every message body are destroyed. This cannot be undone.`;
    if (!window.confirm(prompt)) return;
    await act(() => api.erase(caseId, early));
  }

  if (!item) {
    return (
      <div>
        <button className="backlink mono" onClick={onBack}>
          ← BACK TO CASES
        </button>
        {error ? <div className="resource__error mono">{error}</div> : <div className="boot mono">LOADING…</div>}
      </div>
    );
  }

  const erased = item.erased_at !== null;
  const reporterMessages = item.messages.filter((entry) => entry.visibility === 'reporter');
  const internalNotes = item.messages.filter((entry) => entry.visibility === 'internal');

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← BACK TO CASES
      </button>

      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">
            § WB.02 · {item.ref} · {humanize(item.category)}
          </div>
          <h1 className="resource__title">{item.subject ?? '— erased —'}</h1>
          <p className="resource__desc">
            Filed {fmtDate(item.received_at)} · {item.anonymous ? 'no contact details given' : 'contact details given'}
          </p>
        </div>
        <div className="resource__actions">
          <StatusBadge status={item.status} />
          {item.outcome && <OutcomeBadge outcome={item.outcome} />}
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}
      {erased && (
        <div className="notice mono">
          ERASED ON {fmtDate(item.erased_at!)} UNDER § 11 ABS. 5 HinSchG. THE SKELETON AND THE TRAIL BELOW ARE WHAT
          REMAINS — DELIBERATELY, SO THE PROCEDURE CAN STILL BE PROVEN.
        </div>
      )}

      <div className="detail">
        <div className="detail__main">
          <section className="panel">
            <h2 className="panel__title mono">THE REPORT</h2>
            <div className="report">{item.body ?? '— erased —'}</div>
            {item.contact && (
              <div className="panel__note">
                <span className="mono">CONTACT GIVEN BY THE REPORTER · </span>
                {item.contact}
              </div>
            )}
          </section>

          <section className="panel">
            <h2 className="panel__title mono">CHANNEL TO THE REPORTER</h2>
            <p className="panel__hint">
              Everything here is readable by whoever holds the access code. This is where the § 17 Abs. 2 feedback
              obligation is actually discharged — an internal note, however thorough, is not feedback.
            </p>
            {reporterMessages.length === 0 && <div className="rows__empty mono">NOTHING SENT YET</div>}
            <ol className="thread">
              {reporterMessages.map((entry) => (
                <li key={entry.id} className={`event event--${entry.author_type}`}>
                  <div className="event__head mono">
                    <span>{entry.author_type === 'reporter' ? 'REPORTER' : entry.author}</span>
                    <span className="event__at">{fmtDateTime(entry.created_at)}</span>
                  </div>
                  <div className="event__body">{entry.body ?? '— erased —'}</div>
                </li>
              ))}
            </ol>
          </section>

          <section className="panel">
            <h2 className="panel__title mono">INTERNAL NOTES</h2>
            <p className="panel__hint">Never returned by any public route. The reporter cannot see these.</p>
            {internalNotes.length === 0 && <div className="rows__empty mono">NONE</div>}
            <ol className="thread">
              {internalNotes.map((entry) => (
                <li key={entry.id} className="event event--internal">
                  <div className="event__head mono">
                    <span>{entry.author}</span>
                    <span className="event__at">{fmtDateTime(entry.created_at)}</span>
                  </div>
                  <div className="event__body">{entry.body ?? '— erased —'}</div>
                </li>
              ))}
            </ol>
          </section>

          {!erased && (
            <form className="form" onSubmit={(e) => void send(e)}>
              <div className="chooser">
                {(['reporter', 'internal'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`btn btn--ghost btn--sm ${visibility === option ? 'is-active' : ''}`}
                    onClick={() => setVisibility(option)}
                  >
                    {option === 'reporter' ? 'TO THE REPORTER' : 'INTERNAL NOTE'}
                  </button>
                ))}
              </div>
              <label className="field">
                <span className="field__label mono">
                  {visibility === 'reporter' ? 'THE REPORTER WILL READ THIS' : 'ONLY CASE HANDLERS WILL READ THIS'}
                </span>
                <textarea
                  className="field__input field__input--area"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={5}
                  maxLength={20_000}
                  required
                />
              </label>
              <div className="form__actions">
                <button className="btn btn--primary" type="submit" disabled={busy}>
                  {busy ? 'SAVING…' : 'SEND →'}
                </button>
              </div>
            </form>
          )}
        </div>

        <div className="detail__side">
          <section className="panel">
            <h2 className="panel__title mono">STATUTORY DEADLINES</h2>
            <div className="deadline-row">
              <DeadlineBadge label="ACKNOWLEDGE" deadline={item.acknowledge} />
              <span className="deadline-row__due mono">due {fmtDate(item.acknowledge.due_at)}</span>
            </div>
            <div className="deadline-row">
              <DeadlineBadge label="FEEDBACK" deadline={item.feedback} />
              <span className="deadline-row__due mono">due {fmtDate(item.feedback.due_at)}</span>
            </div>
            <p className="panel__hint">
              When a case is never acknowledged, the feedback clock starts at the expiry of the seven days rather than
              waiting — Art. 9(1)(f) of the directive. Silence accrues both failures.
            </p>
          </section>

          {!erased && (
            <section className="panel">
              <h2 className="panel__title mono">ACT</h2>
              {item.status === 'received' && (
                <button className="btn btn--primary" disabled={busy} onClick={() => void act(() => api.acknowledge(caseId))}>
                  CONFIRM RECEIPT ✓
                </button>
              )}
              {item.status === 'acknowledged' && (
                <button className="btn btn--ghost" disabled={busy} onClick={() => void act(() => api.investigate(caseId))}>
                  START INVESTIGATING →
                </button>
              )}
              {(item.status === 'acknowledged' || item.status === 'investigating') && (
                <>
                  <label className="field">
                    <span className="field__label mono">OUTCOME</span>
                    <select
                      className="field__input"
                      value={outcome}
                      onChange={(e) => setOutcome(e.target.value as CaseOutcome | '')}
                    >
                      <option value="">Choose an outcome…</option>
                      {config.outcomes.map((option) => (
                        <option key={option.key} value={option.key}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="btn btn--danger"
                    disabled={busy || outcome === ''}
                    onClick={() => void act(() => api.close(caseId, outcome as CaseOutcome))}
                  >
                    CONCLUDE THE PROCEDURE
                  </button>
                </>
              )}
              {item.status === 'received' && (
                <p className="panel__hint">
                  A case cannot be concluded before receipt is confirmed. The acknowledgement is the § 17 Abs. 1 act
                  and it is what starts the feedback clock — closing around it would bury the fact that it never
                  happened.
                </p>
              )}
            </section>
          )}

          <section className="panel">
            <h2 className="panel__title mono">RETENTION</h2>
            <div className="kv">
              <div className="kv__row">
                <dt className="mono">ERASE ON</dt>
                <dd className="mono">{item.erase_due_on ?? 'not concluded yet'}</dd>
              </div>
              <div className="kv__row">
                <dt className="mono">ERASED</dt>
                <dd className="mono">{item.erased_at ? fmtDate(item.erased_at) : 'no'}</dd>
              </div>
            </div>
            {!erased && item.status === 'closed' && (
              <button className="btn btn--danger btn--sm" disabled={busy} onClick={() => void erase()}>
                ERASE DOCUMENTATION
              </button>
            )}
            <p className="panel__hint">
              § 11 Abs. 5 HinSchG: three years after the procedure is concluded. Erasing destroys the report, the
              contact details and every message body; the case skeleton and this trail survive.
            </p>
          </section>

          <section className="panel">
            <h2 className="panel__title mono">TRAIL</h2>
            <p className="panel__hint">Append-only. Nothing here is ever edited or removed.</p>
            <ol className="thread">
              {item.events.map((event) => (
                <li key={event.id} className="event">
                  <div className="event__head mono">
                    <span>{eventLine(event)}</span>
                    <span className="event__at">{fmtDateTime(event.created_at)}</span>
                  </div>
                  <div className="event__actor mono">{event.actor}</div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}
