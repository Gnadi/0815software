import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type AuthMode } from '../api';
import { QrCode } from './QrCode';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // Shown once PS-01 says the account has a second factor (an authenticator
  // app's six digits, or one of the recovery codes).
  const [otp, setOtp] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  // The organization requires a second factor this person has not set up:
  // scan, type the first code, and the sign-in switches it on.
  const [setup, setSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  // Shown once, after a sign-in that set the factor up.
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
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
      const result = await api.login(username, password, needsCode ? otp : undefined);
      if (result.recovery_codes && result.recovery_codes.length > 0) setRecoveryCodes(result.recovery_codes);
      else onSuccess();
    } catch (err) {
      const factor = err instanceof ApiError ? err.details.find((d) => d.field === 'otp') : undefined;
      if (factor) {
        setNeedsCode(true);
        const offered = (factor as { setup?: { secret: string; otpauth_uri: string } }).setup;
        if (offered) setSetup(offered);
        setError(
          factor.message === 'is invalid' ? 'That code did not work. Enter the current one.' : '',
        );
      } else {
        setError(err instanceof ApiError ? err.message : 'Login failed');
      }
    } finally {
      setBusy(false);
    }
  }

  if (recoveryCodes) {
    return (
      <div className="login">
        <div className="login__card">
          <h1 className="login__title">Save your recovery codes</h1>
          <p className="login__hint mono">
            EACH CODE SIGNS YOU IN ONCE IF YOUR PHONE IS LOST. THEY ARE SHOWN ONLY NOW — PRINT THEM OR KEEP THEM IN A PASSWORD
            MANAGER.
          </p>
          <ol className="login__codes mono">
            {recoveryCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
          <button className="btn btn--primary" type="button" onClick={onSuccess}>
            I HAVE SAVED THEM →
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login">
      <form className="login__card" onSubmit={(e) => void submit(e)}>
        <div className="login__eyebrow mono">MOD-10 · CRM LITE</div>
        <h1 className="login__title">Sign in</h1>
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
        {setup && (
          <div className="login__setup">
            <p className="login__hint mono">
              YOUR ORGANIZATION REQUIRES TWO-FACTOR SIGN-IN. SCAN THIS WITH AN AUTHENTICATOR APP, THEN ENTER THE CODE IT
              SHOWS.
            </p>
            <QrCode text={setup.otpauth_uri} label="QR code for your authenticator app" />
            <p className="login__hint mono">
              OR TYPE THIS KEY: <span className="login__secret">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</span>
            </p>
          </div>
        )}
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
              : 'LOCAL DEV DEFAULT · admin / admin'}
          </div>
        )}
      </form>
    </div>
  );
}
