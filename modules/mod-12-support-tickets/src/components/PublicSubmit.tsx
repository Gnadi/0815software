import { useState, type FormEvent } from 'react';
import type { Priority } from '../../shared/types';
import { api, ApiError, type WebIntakeResult } from '../api';

const PRIORITY_HINTS: { value: Priority; label: string; hint: string }[] = [
  { value: 'low', label: 'LOW', hint: 'A minor issue or a suggestion.' },
  { value: 'normal', label: 'NORMAL', hint: 'Something is wrong but I can work around it.' },
  { value: 'high', label: 'HIGH', hint: 'A serious problem affecting my work.' },
  { value: 'urgent', label: 'URGENT', hint: 'Everything is blocked / production is down.' },
];

export function PublicSubmit() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WebIntakeResult | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api.submitWeb({
        requester_name: name,
        requester_email: email,
        subject,
        body,
        priority,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit the ticket');
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const link = `${window.location.origin}/ticket/${encodeURIComponent(result.ref)}?token=${encodeURIComponent(result.token)}`;
    return (
      <div className="public">
        <div className="public__card">
          <div className="public__head">
            <div className="public__eyebrow mono">MOD-12 · SUPPORT DESK</div>
            <h1 className="public__title">Ticket received</h1>
            <p className="public__lede">
              Keep the link below — it is the only way to check the status of this ticket and add follow-ups.
              We did not create an account for you.
            </p>
          </div>
          <div className="receipt">
            <div className="receipt__label mono">YOUR TICKET REFERENCE</div>
            <div className="receipt__ref">{result.ref}</div>
            <div className="receipt__label mono">PRIVATE STATUS LINK</div>
            <div className="receipt__link">{link}</div>
            <a className="btn btn--primary" href={link}>
              VIEW TICKET STATUS →
            </a>
          </div>
          <div className="public__foot mono">
            <a href="/">← SUBMIT ANOTHER TICKET</a>
            <a href="/agent">AGENT SIGN IN ↗</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="public">
      <form className="public__card" onSubmit={(e) => void submit(e)}>
        <div className="public__head">
          <div className="public__eyebrow mono">MOD-12 · SUPPORT DESK</div>
          <h1 className="public__title">Submit a ticket</h1>
          <p className="public__lede">
            Tell us what is going wrong. You will get a reference and a private link to track progress — no
            sign-up needed.
          </p>
        </div>

        <div className="public__panel">
          {error && <div className="resource__error mono">{error}</div>}

          <label className="field">
            <span className="field__label mono">
              YOUR NAME <span className="field__req">*</span>
            </span>
            <input className="field__input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>

          <label className="field">
            <span className="field__label mono">
              EMAIL <span className="field__req">*</span>
            </span>
            <input
              className="field__input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </label>

          <label className="field">
            <span className="field__label mono">
              SUBJECT <span className="field__req">*</span>
            </span>
            <input className="field__input" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>

          <label className="field">
            <span className="field__label mono">
              WHAT HAPPENED <span className="field__req">*</span>
            </span>
            <textarea className="field__input" value={body} onChange={(e) => setBody(e.target.value)} />
          </label>

          <div className="field">
            <span className="field__label mono">PRIORITY HINT</span>
            <div className="chooser">
              {PRIORITY_HINTS.map((p) => (
                <button
                  type="button"
                  key={p.value}
                  className={`chooser__btn ${priority === p.value ? 'is-active' : ''}`}
                  onClick={() => setPriority(p.value)}
                  title={p.hint}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <span className="field__label mono" style={{ color: 'var(--fg-mute)' }}>
              {PRIORITY_HINTS.find((p) => p.value === priority)?.hint}
            </span>
          </div>

          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? 'SUBMITTING…' : 'SUBMIT TICKET →'}
          </button>
        </div>

        <div className="public__foot mono">
          <span>0815SOFTWARE · MIT</span>
          <a href="/agent">AGENT SIGN IN ↗</a>
        </div>
      </form>
    </div>
  );
}
