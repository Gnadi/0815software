import { useCallback, useEffect, useState } from 'react';
import type { Me } from '../shared/types';
import { api, ApiError } from './api';
import { ItemsView } from './components/ItemsView';
import { Login } from './components/Login';

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);

  const load = useCallback(async () => {
    try {
      setMe(await api.me());
      setLoggedOut(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setLoggedOut(true);
      else throw err;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onAuthLost = useCallback(() => {
    setMe(null);
    setLoggedOut(true);
  }, []);

  if (loggedOut) return <Login onSuccess={() => void load()} />;
  if (!me) return <div className="boot mono">LOADING…</div>;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand mono">
          <span className="sidebar__num">{{N}}</span>
          <span>{{TITLE_UPPER}}</span>
        </div>
        <nav className="sidebar__nav">
          <button className="sidebar__item mono is-active">Items</button>
        </nav>
        <div className="sidebar__foot mono">
          <span>
            {me.username} · {me.access.toUpperCase()}
          </span>
          <button className="sidebar__logout mono" onClick={() => void api.logout().then(onAuthLost)}>
            LOG OUT ↗
          </button>
        </div>
      </aside>
      <main className="main">
        <ItemsView access={me.access} onAuthLost={onAuthLost} />
      </main>
    </div>
  );
}
