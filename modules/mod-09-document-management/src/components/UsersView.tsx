import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { GlobalRole, UserRef } from '../../shared/types';
import { api, ApiError } from '../api';

interface Props {
  onAuthLost: () => void;
}

export function UsersView({ onAuthLost }: Props) {
  const [users, setUsers] = useState<UserRef[]>([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const { users: list } = await api.users();
      setUsers(list);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page__head page__head--split">
        <div>
          <div className="page__eyebrow mono">MOD-09 · ADMIN</div>
          <h1 className="page__title">Users</h1>
          <p className="page__desc">Global roles. Admins see every matter; members see only granted matters.</p>
        </div>
        <button className="btn btn--primary" onClick={() => setCreating((v) => !v)}>
          {creating ? 'CLOSE' : 'NEW USER +'}
        </button>
      </div>

      {error && <div className="page__error mono">{error}</div>}
      {creating && (
        <NewUserForm
          onDone={() => {
            setCreating(false);
            void load();
          }}
        />
      )}

      <div className="table-wrap">
        <table className="table table--tight">
          <thead>
            <tr>
              <th>Name</th>
              <th>Username</th>
              <th>Global role</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td className="mono">{u.username}</td>
                <td>
                  <span className={`badge ${u.role === 'admin' ? 'badge--delivered' : ''}`}>{u.role}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function NewUserForm({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<GlobalRole>('member');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.createUser({ username: username.trim().toLowerCase(), name, role, password });
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
          <span className="field__label mono">USERNAME</span>
          <input className="field__input" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field field--grow">
          <span className="field__label mono">NAME</span>
          <input className="field__input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label mono">ROLE</span>
          <select className="field__input" value={role} onChange={(e) => setRole(e.target.value as GlobalRole)}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span className="field__label mono">PASSWORD (MIN 8)</span>
        <input className="field__input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <div className="login__error mono">{error}</div>}
      <button className="btn btn--primary" type="submit" disabled={busy}>
        {busy ? 'CREATING…' : 'CREATE USER'}
      </button>
    </form>
  );
}
