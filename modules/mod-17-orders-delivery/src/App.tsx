import { useCallback, useEffect, useState } from 'react';
import type { Me } from '../shared/types';
import { AccessProvider } from './access';
import { api, ApiError } from './api';
import { Login } from './components/Login';
import { OrderDetail } from './components/OrderDetail';
import { OrdersView } from './components/OrdersView';

type View = { name: 'orders' } | { name: 'order'; id: number };

/**
 * The view a path asks for — the destinations server/summary.ts links to and
 * a shell hands off into. Read once on load; navigation after is state.
 */
export function initialView(path: string): View {
  const order = /^\/orders\/(\d+)$/.exec(path);
  return order ? { name: 'order', id: Number(order[1]) } : { name: 'orders' };
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);
  const [view, setView] = useState<View>(() => initialView(window.location.pathname));

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
    <AccessProvider level={me.access}>
      <div className="shell">
        <aside className="sidebar">
          <div className="sidebar__brand mono">
            <span className="sidebar__num">MOD-17</span>
            <span>ORDERS & DELIVERY NOTES</span>
          </div>
          <nav className="sidebar__nav">
            <button className={`sidebar__item mono ${view.name === 'orders' || view.name === 'order' ? 'is-active' : ''}`} onClick={() => setView({ name: 'orders' })}>
              Orders
            </button>
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
          {view.name === 'orders' && <OrdersView onOpen={(id) => setView({ name: 'order', id })} onAuthLost={onAuthLost} />}
          {view.name === 'order' && <OrderDetail id={view.id} onBack={() => setView({ name: 'orders' })} onAuthLost={onAuthLost} />}
        </main>
      </div>
    </AccessProvider>
  );
}
