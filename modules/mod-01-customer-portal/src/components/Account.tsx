import { useState, type FormEvent } from 'react';
import type { CustomerProfile } from '../../shared/types';
import { api, ApiError } from '../api';
import { formatDate } from '../format';

interface Props {
  customer: CustomerProfile;
  onAuthLost: () => void;
}

export function Account({ customer, onAuthLost }: Props) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setSaved(false);
    if (newPassword !== repeatPassword) {
      setError('New passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setSaved(true);
      setCurrentPassword('');
      setNewPassword('');
      setRepeatPassword('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && err.message === 'Authentication required') {
        onAuthLost();
        return;
      }
      setError(err instanceof Error ? err.message : 'Password change failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <header className="page__head">
        <div className="page__eyebrow mono">SELF-SERVICE · ACCOUNT</div>
        <h1 className="page__title">Your account</h1>
      </header>

      <div className="detail">
        <div className="detail__col">
          <h2 className="detail__heading mono">PROFILE</h2>
          <dl className="proplist">
            <dt className="mono">NAME</dt>
            <dd>{customer.name}</dd>
            <dt className="mono">COMPANY</dt>
            <dd>{customer.company}</dd>
            <dt className="mono">EMAIL</dt>
            <dd>{customer.email}</dd>
            <dt className="mono">CUSTOMER SINCE</dt>
            <dd>{formatDate(customer.created_at)}</dd>
          </dl>
          <p className="detail__hint">
            Profile changes go through your usual contact — this portal is read-only for master data
            by design.
          </p>
        </div>

        <div className="detail__col">
          <h2 className="detail__heading mono">CHANGE PASSWORD</h2>
          <form className="pwform" onSubmit={(e) => void submit(e)}>
            <label className="field">
              <span className="field__label mono">CURRENT PASSWORD</span>
              <input
                className="field__input"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <label className="field">
              <span className="field__label mono">NEW PASSWORD (MIN. 8 CHARS)</span>
              <input
                className="field__input"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            <label className="field">
              <span className="field__label mono">REPEAT NEW PASSWORD</span>
              <input
                className="field__input"
                type="password"
                value={repeatPassword}
                onChange={(e) => setRepeatPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            {error && <div className="page__error mono">{error}</div>}
            {saved && <div className="pwform__ok mono">PASSWORD CHANGED ✓</div>}
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'SAVING…' : 'CHANGE PASSWORD →'}
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
