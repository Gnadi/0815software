import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type AuthMode } from '../api';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // Shown once PS-01 says the account has a second factor (an authenticator
  // app's six digits, or one of the recovery codes).
  const [otp, setOtp] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);

  // Only the server knows whether PS-01 validates logins here, so the hint
  // below is asked for rather than assumed. Until it answers — or if it never
  // does — no hint is shown, which beats naming credentials that may be wrong.
  useEffect(() => {
    let live = true;
    void api
      .authMode()
      .then((mode) => {
        if (live) setAuthMode(mode);
      })
      .catch(() => {
        /* no hint rather than a guessed one */
      });
    return () => {
      live = false;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(username, password, needsCode ? otp : undefined);
      onSuccess();
    } catch (err) {
      const factor = err instanceof ApiError ? err.details.find((d) => d.field === 'otp') : undefined;
      if (factor) {
        setNeedsCode(true);
        setError(factor.message === 'is required' ? '' : 'That code did not work. Enter the current one.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Login failed');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login__card" onSubmit={(e) => void submit(e)}>
        <div className="login__eyebrow mono">MOD-12 · SUPPORT DESK</div>
        <h1 className="login__title">Agent sign in</h1>
        <label className="field">
          <span className="field__label mono">{authMode?.sso ? 'EMAIL' : 'USERNAME'}</span>
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
        {needsCode && (
          <label className="field">
            <span className="field__label mono">CODE FROM YOUR AUTHENTICATOR APP</span>
            <input
              className="field__input"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              autoComplete="one-time-code"
              placeholder="123456 · or a recovery code"
              autoFocus
            />
          </label>
        )}
        {error && <div className="login__error mono">{error}</div>}
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'SIGNING IN…' : 'SIGN IN →'}
        </button>
        {authMode && (
          <div className="login__hint mono">
            {authMode.sso
              ? `SINGLE SIGN-ON · PS-01 IDENTITY · ORG ${authMode.org.toUpperCase()}`
              : 'LOCAL DEV DEFAULT · agent / agent'}
          </div>
        )}
        <a className="login__back mono" href="/">
          ← BACK TO TICKET SUBMISSION
        </a>
      </form>
    </div>
  );
}
