import { useState } from 'react';
import type { AppConfig } from '../../shared/types';
import { api, ApiError } from '../api';
import { Field } from './ui';

/** Inline "log activity" form used on contact and deal detail pages. */
export function ActivityForm({
  config,
  contactId,
  dealId,
  onLogged,
  onAuthLost,
}: {
  config: AppConfig;
  contactId?: number;
  dealId?: number;
  onLogged: () => void;
  onAuthLost: () => void;
}) {
  const [type, setType] = useState(config.activity_types[0] ?? 'note');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (subject.trim() === '') {
      setError('Subject is required');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.createActivity({
        type,
        subject,
        body: body || null,
        contact_id: contactId ?? null,
        deal_id: dealId ?? null,
        due_date: dueDate || null,
      });
      setSubject('');
      setBody('');
      setDueDate('');
      onLogged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to log activity');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-form">
      {error && <div className="modal__error mono">{error}</div>}
      <div className="inline-form__row">
        <Field label="TYPE">
          <select className="field__input" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            {config.activity_types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="SUBJECT" required>
          <input className="field__input" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
      </div>
      <Field label="NOTES">
        <textarea className="field__input" rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <div className="inline-form__row">
        <Field label="FOLLOW-UP DUE">
          <input className="field__input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <div className="inline-form__actions" style={{ alignItems: 'flex-end' }}>
          <button className="btn btn--primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'LOGGING…' : 'LOG ACTIVITY'}
          </button>
        </div>
      </div>
    </div>
  );
}
