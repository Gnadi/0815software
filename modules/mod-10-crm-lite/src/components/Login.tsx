import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(username, password);
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login__card" onSubmit={(e) => void submit(e)}>
        <div className="login__eyebrow mono">MOD-10 · CRM LITE</div>
        <h1 className="login__title">Sign in</h1>
        <label className="field">
          <span className="field__label mono">USERNAME</span>
          <input
            className="field__input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </label>
        <label className="field">
          <span className="field__label mono">PASSWORD</span>
          <input
            className="field__input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && <div className="login__error mono">{error}</div>}
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'SIGNING IN…' : 'SIGN IN →'}
        </button>
        <div className="login__hint mono">LOCAL DEV DEFAULT · admin / admin</div>
      </form>
    </div>
  );
}
