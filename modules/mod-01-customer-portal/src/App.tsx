import { useCallback, useEffect, useState } from 'react';
import type { CustomerProfile } from '../shared/types';
import { api, ApiError } from './api';
import { Account } from './components/Account';
import { DocumentsList } from './components/DocumentsList';
import { Login } from './components/Login';
import { OrderDetail } from './components/OrderDetail';
import { OrdersList } from './components/OrdersList';

export type View =
  | { name: 'orders' }
  | { name: 'order'; id: number }
  | { name: 'documents' }
  | { name: 'account' };

const NAV: { view: View; label: string }[] = [
  { view: { name: 'orders' }, label: 'Orders' },
  { view: { name: 'documents' }, label: 'Documents' },
  { view: { name: 'account' }, label: 'Account' },
];

export function App() {
  const [customer, setCustomer] = useState<CustomerProfile | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);
  const [view, setView] = useState<View>({ name: 'orders' });

  const loadProfile = useCallback(async () => {
    try {
      const { customer: profile } = await api.me();
      setCustomer(profile);
      setLoggedOut(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setLoggedOut(true);
      else throw err;
    }
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const onAuthLost = useCallback(() => {
    setCustomer(null);
    setView({ name: 'orders' });
    setLoggedOut(true);
  }, []);

  if (loggedOut) {
    return <Login onSuccess={() => void loadProfile()} />;
  }
  if (!customer) {
    return <div className="boot mono">LOADING…</div>;
  }

  const activeNav = view.name === 'order' ? 'orders' : view.name;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand mono">
          <span className="sidebar__num">MOD-01</span>
          <span>CUSTOMER PORTAL</span>
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
        </nav>
        <div className="sidebar__foot mono">
          <span className="sidebar__who">{customer.email}</span>
          <span>0815SOFTWARE · MIT</span>
          <button
            className="sidebar__logout mono"
            onClick={() => {
              void api.logout().then(onAuthLost);
            }}
          >
            LOG OUT ↗
          </button>
        </div>
      </aside>
      <main className="main">
        {view.name === 'orders' && (
          <OrdersList onOpen={(id) => setView({ name: 'order', id })} onAuthLost={onAuthLost} />
        )}
        {view.name === 'order' && (
          <OrderDetail id={view.id} onBack={() => setView({ name: 'orders' })} onAuthLost={onAuthLost} />
        )}
        {view.name === 'documents' && <DocumentsList onAuthLost={onAuthLost} />}
        {view.name === 'account' && (
          <Account customer={customer} onAuthLost={onAuthLost} />
        )}
      </main>
    </div>
  );
}
