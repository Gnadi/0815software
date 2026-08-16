import { useState, type FormEvent } from 'react';
import type { ReporterView } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDate, fmtDateTime, humanize } from '../format';

/**
 * The reporter's side of the two-way channel.
 *
 * The access code lives in component state and nowhere else — not in the URL,
 * not in localStorage, not in a cookie. Closing the tab ends the session, and
 * that is the intended behaviour on what may well be a shared machine.
 */
export function PublicStatus() {
  const [code, setCode] = useState('');
  const [view, setView] = useState<ReporterView | null>(null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function open(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      setView(await api.myCase(code));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that report');
    } finally {
      setBusy(false);
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      setView(await api.myMessage(code, reply));
      setReply('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send that');
    } finally {
      setBusy(false);
    }
  }

  if (!view) {
    return (
      <div className="public">
        <form className="public__card" onSubmit={(e) => void open(e)}>
          <div className="public__eyebrow mono">INTERNAL REPORTING CHANNEL</div>
          <h1 className="public__title">Check your report</h1>
          <p className="public__lede">
            Enter the access code you were given when you filed. Upper or lower case, with or without the dashes — it
            makes no difference.
          </p>
          {error && <div className="resource__error mono">{error}</div>}
          <label className="field">
            <span className="field__label mono">ACCESS CODE</span>
            <input
              className="field__input field__input--code mono"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              required
            />
          </label>
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? 'OPENING…' : 'OPEN MY REPORT →'}
          </button>
          <a className="public__link mono" href="/">
            ← FILE A NEW REPORT
          </a>
        </form>
      </div>
    );
  }

  return (
    <div className="public">
      <div className="public__card">
        <div className="public__eyebrow mono">
          {view.ref} · {humanize(view.status)}
          {view.outcome && ` · ${humanize(view.outcome)}`}
        </div>
        <h1 className="public__title">{view.subject ?? 'This report has been erased'}</h1>

        {view.erased_at ? (
          <div className="notice mono">
            THE DOCUMENTATION FOR THIS REPORT WAS ERASED ON {fmtDate(view.erased_at)} UNDER § 11 ABS. 5 HinSchG,
            THREE YEARS AFTER THE PROCEDURE WAS CONCLUDED.
          </div>
        ) : (
          <>
            <div className="kv">
              <div className="kv__row">
                <dt className="mono">FILED</dt>
                <dd className="mono">{fmtDate(view.received_at)}</dd>
              </div>
              <div className="kv__row">
                <dt className="mono">RECEIPT CONFIRMED</dt>
                <dd className="mono">
                  {view.acknowledged_at ? fmtDate(view.acknowledged_at) : `owed by ${fmtDate(view.acknowledge_due_at)}`}
                </dd>
              </div>
              <div className="kv__row">
                <dt className="mono">FEEDBACK OWED BY</dt>
                <dd className="mono">{fmtDate(view.feedback_due_at)}</dd>
              </div>
            </div>
            <div className="report">{view.body}</div>
          </>
        )}

        <h2 className="section-title mono">MESSAGES</h2>
        {view.messages.length === 0 && <div className="rows__empty mono">NOTHING YET</div>}
        <ol className="thread">
          {view.messages.map((message) => (
            <li key={message.id} className={`event event--${message.author_type}`}>
              <div className="event__head mono">
                <span>{message.author_type === 'reporter' ? 'YOU' : 'CASE HANDLER'}</span>
                <span className="event__at">{fmtDateTime(message.created_at)}</span>
              </div>
              <div className="event__body">{message.body ?? '—'}</div>
            </li>
          ))}
        </ol>

        {error && <div className="resource__error mono">{error}</div>}

        {view.status !== 'closed' && !view.erased_at && (
          <form className="form form--inline" onSubmit={(e) => void send(e)}>
            <label className="field">
              <span className="field__label mono">ADD SOMETHING</span>
              <textarea
                className="field__input field__input--area"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={5}
                maxLength={20_000}
                required
              />
            </label>
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'SENDING…' : 'SEND →'}
            </button>
          </form>
        )}
        {view.status === 'closed' && (
          <div className="notice mono">THIS PROCEDURE IS CONCLUDED AND NO LONGER TAKES FOLLOW-UP.</div>
        )}

        <button
          className="public__link mono"
          onClick={() => {
            setView(null);
            setCode('');
          }}
        >
          ← CLOSE AND FORGET THE CODE
        </button>
      </div>
    </div>
  );
}
