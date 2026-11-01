import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { formatBytes, type PublicShare } from '../../shared/types';
import { api, ApiError, sharedUrl } from '../api';
import { formatDate } from '../format';
import { Preview } from './Preview';

/**
 * What someone opening a share link sees — no account, no session. One
 * document's title, size and expiry, a preview where the type allows one,
 * and the download. A link that does not work says only that.
 */
export function SharePage({ token }: { token: string }) {
  const [share, setShare] = useState<PublicShare | null>(null);
  const [gone, setGone] = useState(false);
  const [grant, setGrant] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .shared(token)
      .then(setShare)
      .catch(() => setGone(true));
  }, [token]);

  const loadText = useCallback(() => api.sharedText(token, grant), [token, grant]);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      setGrant((await api.unlockShared(token, password)).grant);
      setPassword('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? 'Too many wrong passwords — try again later.' : 'Wrong password.');
    }
  }

  if (gone) {
    return (
      <div className="login">
        <div className="login__card">
          <div className="login__eyebrow mono">0815SOFTWARE · SHARED DOCUMENT</div>
          <h1 className="login__title">This link does not work</h1>
          <p className="login__hint">It may have expired or been revoked. Ask the person who sent it for a new one.</p>
        </div>
      </div>
    );
  }
  if (!share) return <div className="boot mono">LOADING…</div>;

  const locked = share.password_required && grant === null;
  return (
    <div className="sharepage">
      <div className="page__head page__head--split">
        <div>
          <div className="page__eyebrow mono">0815SOFTWARE · SHARED DOCUMENT</div>
          <h1 className="page__title">{share.title}</h1>
          <p className="page__desc">
            {share.filename} · {formatBytes(share.size_bytes)} · version {share.version_no} · available until {formatDate(share.expires_at)}
            {share.downloads_left !== null && ` · ${share.downloads_left} download${share.downloads_left === 1 ? '' : 's'} left`}
          </p>
        </div>
        {!locked && (
          <div className="head__actions">
            <a className="btn btn--primary" href={sharedUrl(token, 'download', grant)}>
              DOWNLOAD ↓
            </a>
          </div>
        )}
      </div>
      {locked ? (
        <form className="card card--form formrow" onSubmit={(e) => void unlock(e)}>
          <label className="field field--grow">
            <span className="field__label mono">PASSWORD</span>
            <input className="field__input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </label>
          <button className="btn btn--primary" type="submit">
            OPEN
          </button>
          {error && <div className="login__error mono">{error}</div>}
        </form>
      ) : (
        <Preview kind={share.preview} inlineUrl={sharedUrl(token, 'preview', grant)} loadText={loadText} title={share.title} />
      )}
    </div>
  );
}
