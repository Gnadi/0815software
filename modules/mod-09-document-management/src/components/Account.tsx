import { useState, type FormEvent } from 'react';
import type { UserProfile } from '../../shared/types';
import { api, ApiError } from '../api';
import { formatDate } from '../format';

interface Props {
  user: UserProfile;
  onAuthLost: () => void;
}

export function Account({ user, onAuthLost }: Props) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setOk(false);
    try {
      await api.changePassword(currentPassword, newPassword);
      setOk(true);
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && err.message.includes('Authentication')) {
        onAuthLost();
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page__head">
        <div className="page__eyebrow mono">MOD-09 · ACCOUNT</div>
        <h1 className="page__title">Account</h1>
      </div>

      <dl className="proplist">
        <dt className="mono">NAME</dt>
        <dd>{user.name}</dd>
        <dt className="mono">USERNAME</dt>
        <dd className="mono">{user.username}</dd>
        <dt className="mono">GLOBAL ROLE</dt>
        <dd>{user.role}</dd>
        <dt className="mono">MEMBER SINCE</dt>
        <dd className="mono">{formatDate(user.created_at)}</dd>
      </dl>

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
          />
        </label>
        <label className="field">
          <span className="field__label mono">NEW PASSWORD (MIN 8)</span>
          <input
            className="field__input"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        {error && <div className="login__error mono">{error}</div>}
        {ok && <div className="pwform__ok mono">PASSWORD CHANGED</div>}
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'SAVING…' : 'CHANGE PASSWORD'}
        </button>
      </form>
    </>
  );
}
