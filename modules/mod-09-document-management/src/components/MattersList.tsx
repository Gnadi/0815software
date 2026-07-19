import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { MatterSummary, UserProfile } from '../../shared/types';
import { api, ApiError } from '../api';

interface Props {
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}

export function MattersList({ onOpen, onAuthLost }: Props) {
  const [matters, setMatters] = useState<MatterSummary[] | null>(null);
  const [me, setMe] = useState<UserProfile | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ matters: list }, { user }] = await Promise.all([api.matters(), api.me()]);
      setMatters(list);
      setMe(user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!matters || !me) return <div className="boot mono">LOADING…</div>;

  return (
    <>
      <div className="page__head page__head--split">
        <div>
          <div className="page__eyebrow mono">MOD-09 · DOCUMENT MANAGEMENT</div>
          <h1 className="page__title">Matters</h1>
          <p className="page__desc">Every document belongs to a matter. You see only the matters you are a member of.</p>
        </div>
        {me.role === 'admin' && (
          <button className="btn btn--primary" onClick={() => setCreating((v) => !v)}>
            {creating ? 'CLOSE' : 'NEW MATTER +'}
          </button>
        )}
      </div>

      {error && <div className="page__error mono">{error}</div>}
      {creating && me.role === 'admin' && (
        <NewMatterForm
          onDone={() => {
            setCreating(false);
            void load();
          }}
        />
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Name</th>
              <th>Your role</th>
              <th className="table__num">Documents</th>
              <th className="table__num">Members</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {matters.length === 0 && (
              <tr>
                <td className="table__empty" colSpan={6}>
                  NO MATTERS
                </td>
              </tr>
            )}
            {matters.map((m) => (
              <tr key={m.id} className="table__row-link" onClick={() => onOpen(m.id)}>
                <td className="mono">{m.key}</td>
                <td>{m.name}</td>
                <td>
                  <span className="badge">{m.role}</span>
                </td>
                <td className="table__num">{m.document_count}</td>
                <td className="table__num">{m.member_count}</td>
                <td className="table__arrow">→</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function NewMatterForm({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.createMatter({ key: key.trim().toUpperCase(), name, description });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card card--form" onSubmit={(e) => void submit(e)}>
      <div className="formrow">
        <label className="field">
          <span className="field__label mono">KEY</span>
          <input className="field__input" value={key} onChange={(e) => setKey(e.target.value)} placeholder="MAT-2026-050" />
        </label>
        <label className="field field--grow">
          <span className="field__label mono">NAME</span>
          <input className="field__input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span className="field__label mono">DESCRIPTION</span>
        <input className="field__input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {error && <div className="login__error mono">{error}</div>}
      <button className="btn btn--primary" type="submit" disabled={busy}>
        {busy ? 'CREATING…' : 'CREATE MATTER'}
      </button>
    </form>
  );
}
