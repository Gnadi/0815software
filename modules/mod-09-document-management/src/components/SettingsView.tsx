import { useCallback, useEffect, useState } from 'react';
import type { ModuleSettings, SharePolicy } from '../../shared/types';
import { api, ApiError, errorText } from '../api';
import { formatDateTime } from '../format';

interface Props {
  onAuthLost: () => void;
}

const POLICIES: { value: SharePolicy; label: string }[] = [
  { value: 'editor', label: 'Editors and owners of the matter' },
  { value: 'owner', label: 'Owners of the matter only' },
  { value: 'off', label: 'Nobody — share links switched off' },
];

/** Module settings for administrators: share links, and re-reading the files. */
export function SettingsView({ onAuthLost }: Props) {
  const [settings, setSettings] = useState<ModuleSettings | null>(null);
  const [draft, setDraft] = useState<ModuleSettings | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const s = await api.settings();
      setSettings(s);
      setDraft(s);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(errorText(err, 'Failed to load'));
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!draft) return;
    setError('');
    setMessage('');
    try {
      const s = await api.saveSettings({
        share_links: draft.share_links,
        share_default_days: draft.share_default_days,
        share_max_days: draft.share_max_days,
        share_require_password: draft.share_require_password,
      });
      setSettings(s);
      setDraft(s);
      setMessage('Saved.');
    } catch (err) {
      setError(errorText(err, 'Save failed'));
    }
  }

  async function reindex() {
    setError('');
    setMessage('Reading every file again…');
    try {
      const r = await api.reindex();
      setMessage(`Read ${r.read} versions${r.missing ? `; ${r.missing} files missing` : ''}.`);
    } catch (err) {
      setMessage('');
      setError(errorText(err, 'Re-index failed'));
    }
  }

  if (!draft || !settings) return <div className="boot mono">LOADING…</div>;
  const set = (patch: Partial<ModuleSettings>) => setDraft({ ...draft, ...patch });

  return (
    <>
      <div className="page__head">
        <div className="page__eyebrow mono">MOD-09 · ADMINISTRATION</div>
        <h1 className="page__title">Settings</h1>
        <p className="page__desc">
          Share links let someone without an account fetch one document. Switching them off stops every existing link at once.
        </p>
      </div>

      {error && <div className="page__error mono">{error}</div>}

      <h2 className="detail__heading mono">SHARE LINKS</h2>
      <div className="card card--form">
        <label className="field">
          <span className="field__label mono">WHO MAY CREATE THEM</span>
          <select className="field__input" value={draft.share_links} onChange={(e) => set({ share_links: e.target.value as SharePolicy })}>
            {POLICIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <div className="formrow">
          <label className="field">
            <span className="field__label mono">DEFAULT LIFETIME (DAYS)</span>
            <input className="field__input" type="number" min={1} max={365} value={draft.share_default_days} onChange={(e) => set({ share_default_days: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span className="field__label mono">LONGEST ALLOWED (DAYS)</span>
            <input className="field__input" type="number" min={1} max={365} value={draft.share_max_days} onChange={(e) => set({ share_max_days: Number(e.target.value) })} />
          </label>
        </div>
        <label className="checkrow">
          <input type="checkbox" checked={draft.share_require_password} onChange={(e) => set({ share_require_password: e.target.checked })} />
          Every link needs a password
        </label>
        <div className="formrow">
          <button className="btn btn--primary" onClick={() => void save()}>
            SAVE
          </button>
          <span className="detail__hint">
            {settings.updated_by_name ? `Last changed by ${settings.updated_by_name}, ${formatDateTime(settings.updated_at ?? '')}` : 'Defaults — never changed'}
          </span>
        </div>
      </div>

      <h2 className="detail__heading mono">SEARCH INDEX</h2>
      <div className="card">
        <p className="detail__hint">
          Text is read out of every upload. Read all files again after an update that improved the readers, or to repair the index.
        </p>
        <button className="btn btn--ghost" onClick={() => void reindex()}>
          RE-INDEX ALL FILES
        </button>
      </div>
      {message && <p className="detail__hint">{message}</p>}
    </>
  );
}
