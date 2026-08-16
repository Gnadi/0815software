import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { IntakeResult } from '../../shared/types';
import { api, ApiError, type PublicConfig } from '../api';
import { fmtDate } from '../format';

const BLANK = { category: '', subject: '', body: '', contact: '' };

/**
 * The code hand-off.
 *
 * Deliberately a full screen with nothing else on it and no way past except a
 * confirmation. The code cannot be reissued — reissuing it would mean knowing
 * who the reporter is, which is exactly what this module refuses to know — so
 * the one moment it is readable has to be impossible to scroll past.
 */
function CodeHandover({ result, onDone }: { result: IntakeResult; onDone: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <div className="public">
      <div className="public__card">
        <div className="public__eyebrow mono">REPORT FILED · {result.ref}</div>
        <h1 className="public__title">Write down your access code</h1>
        <p className="public__lede">
          This is the only way back to your report. With it you can read our reply and add to what you told us —
          without ever giving us your name.
        </p>

        <div className="code">
          <div className="code__value mono">{result.code}</div>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => {
              void navigator.clipboard?.writeText(result.code).then(() => setCopied(true));
            }}
          >
            {copied ? 'COPIED' : 'COPY'}
          </button>
        </div>

        <div className="notice notice--warn mono">
          WE CANNOT SEND IT TO YOU AND WE CANNOT RESET IT. WE STORE ONLY A ONE-WAY HASH OF THIS CODE — NOBODY HERE,
          INCLUDING WHOEVER RUNS THIS SYSTEM, CAN READ IT BACK. IF YOU LOSE IT, THE REPORT STAYS BUT YOUR CHANNEL TO
          IT IS GONE.
        </div>

        <p className="public__note">
          We will confirm receipt by <strong>{fmtDate(result.acknowledge_due_at)}</strong> at the latest, as § 17 Abs.
          1 HinSchG requires. Come back to this site and choose “Check my report”.
        </p>

        <label className="field field--check">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span className="field__label mono">I HAVE WRITTEN THE CODE DOWN SOMEWHERE SAFE</span>
        </label>
        <button className="btn btn--primary" disabled={!confirmed} onClick={onDone}>
          DONE →
        </button>
      </div>
    </div>
  );
}

export function PublicSubmit() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [form, setForm] = useState(BLANK);
  const [result, setResult] = useState<IntakeResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setConfig(await api.publicConfig());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the form');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      setResult(await api.fileReport({ ...form, contact: form.contact || null }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to file the report');
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <CodeHandover
        result={result}
        onDone={() => {
          setResult(null);
          setForm(BLANK);
        }}
      />
    );
  }
  if (!config) return <div className="boot mono">LOADING…</div>;

  const chosen = config.categories.find((category) => category.key === form.category);

  return (
    <div className="public">
      <form className="public__card" onSubmit={(e) => void submit(e)}>
        <div className="public__eyebrow mono">{config.organisation.toUpperCase()} · INTERNAL REPORTING CHANNEL</div>
        <h1 className="public__title">Report a concern</h1>
        <p className="public__lede">
          This channel exists under the Hinweisgeberschutzgesetz. You do not need an account, a name or an email
          address. You will get an access code to follow your report and to hear back.
        </p>

        <ul className="promises mono">
          <li>WE CONFIRM RECEIPT WITHIN {config.acknowledge_days} DAYS</li>
          <li>WE GIVE YOU FEEDBACK WITHIN {config.feedback_months} MONTHS</li>
          <li>WE DO NOT RECORD YOUR IP ADDRESS OR ANYTHING ELSE THAT IDENTIFIES YOU</li>
          <li>RETALIATION FOR REPORTING IS PROHIBITED BY LAW (§ 36 HinSchG)</li>
        </ul>

        {error && <div className="resource__error mono">{error}</div>}

        <label className="field">
          <span className="field__label mono">WHAT IS THIS ABOUT?</span>
          <select
            className="field__input"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            required
          >
            <option value="">Choose a category…</option>
            {config.categories.map((category) => (
              <option key={category.key} value={category.key}>
                {category.label}
              </option>
            ))}
          </select>
        </label>
        {chosen && <div className="field__hint">{chosen.hint}</div>}

        <label className="field">
          <span className="field__label mono">IN ONE LINE</span>
          <input
            className="field__input"
            value={form.subject}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
            maxLength={200}
            required
          />
        </label>

        <label className="field">
          <span className="field__label mono">WHAT HAPPENED?</span>
          <textarea
            className="field__input field__input--area"
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            rows={10}
            maxLength={20_000}
            placeholder="What happened, when, where, and who was involved if you know. Anything you can describe helps — dates, documents, systems."
            required
          />
        </label>

        <label className="field">
          <span className="field__label mono">CONTACT — OPTIONAL, AND YOU MAY LEAVE IT EMPTY</span>
          <input
            className="field__input"
            value={form.contact}
            onChange={(e) => setForm({ ...form, contact: e.target.value })}
            maxLength={500}
            placeholder="Only if you want to be reachable another way"
          />
        </label>
        <div className="field__hint">
          Leaving this empty is a complete report, not a lesser one. The access code alone gives you the full two-way
          channel.
        </div>

        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'FILING…' : 'FILE THE REPORT →'}
        </button>
        <a className="public__link mono" href="/status">
          ALREADY HAVE AN ACCESS CODE? CHECK YOUR REPORT ↗
        </a>
      </form>
    </div>
  );
}
