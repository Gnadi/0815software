import { useCallback, useEffect, useState } from 'react';
import { admin, ApiError } from '../api';
import { CategoriesAdmin } from './CategoriesAdmin';
import { Login } from './Login';
import { OrderDetailAdmin } from './OrderDetailAdmin';
import { OrdersAdmin } from './OrdersAdmin';
import { ProductsAdmin } from './ProductsAdmin';

export type AdminView =
  | { name: 'orders' }
  | { name: 'order'; id: number }
  | { name: 'products' }
  | { name: 'categories' };

const NAV: { view: AdminView; label: string }[] = [
  { view: { name: 'orders' }, label: 'Orders' },
  { view: { name: 'products' }, label: 'Products' },
  { view: { name: 'categories' }, label: 'Categories' },
];

export function AdminApp() {
  const [ready, setReady] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);
  const [view, setView] = useState<AdminView>({ name: 'orders' });

  const load = useCallback(async () => {
    try {
      await admin.me();
      setReady(true);
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
    setReady(false);
    setView({ name: 'orders' });
    setLoggedOut(true);
  }, []);

  if (loggedOut) {
    return <Login onSuccess={() => void load()} />;
  }
  if (!ready) {
    return <div className="boot mono">LOADING…</div>;
  }

  const activeNav = view.name === 'order' ? 'orders' : view.name;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand mono">
          <span className="sidebar__num">MOD-07</span>
          <span>STOREFRONT · ADMIN</span>
        </div>
        <nav className="sidebar__nav">
          {NAV.map(({ view: target, label }) => (
            <button
              key={target.name}
              className={`sidebar__item mono ${target.name === activeNav ? 'is-active' : ''}`}
              onClick={() => setView(target)}
            >
              {label}
            </button>
          ))}
          <a className="sidebar__item mono" href="/">
            View shop ↗
          </a>
        </nav>
        <div className="sidebar__foot mono">
          <span>0815SOFTWARE · MIT</span>
          <button
            className="sidebar__logout mono"
            onClick={() => {
              void admin.logout().then(onAuthLost);
            }}
          >
            LOG OUT ↗
          </button>
        </div>
      </aside>
      <main className="main">
        {view.name === 'orders' && (
          <OrdersAdmin onOpen={(id) => setView({ name: 'order', id })} onAuthLost={onAuthLost} />
        )}
        {view.name === 'order' && (
          <OrderDetailAdmin
            id={view.id}
            onBack={() => setView({ name: 'orders' })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'products' && <ProductsAdmin onAuthLost={onAuthLost} />}
        {view.name === 'categories' && <CategoriesAdmin onAuthLost={onAuthLost} />}
      </main>
    </div>
  );
}
