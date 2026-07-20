import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { CustomersView } from './components/CustomersView';
import { Dashboard } from './components/Dashboard';
import { Login } from './components/Login';
import { OfferDetail } from './components/OfferDetail';
import { OfferEditor } from './components/OfferEditor';
import { OffersView } from './components/OffersView';
import { PublicOffer } from './components/PublicOffer';

export type View =
  | { name: 'dashboard' }
  | { name: 'offers' }
  | { name: 'offer'; id: number }
  | { name: 'editor'; id: number | null }
  | { name: 'customers' };

const NAV: { view: View; label: string }[] = [
  { view: { name: 'dashboard' }, label: 'Dashboard' },
  { view: { name: 'offers' }, label: 'Offers' },
  { view: { name: 'customers' }, label: 'Customers' },
];

/**
 * One app, two faces. The path decides once, on load:
 *
 *   /offer/:ref?token=… → the public acceptance page (no login)
 *   everything else      → the staff face (login + management)
 *
 * Navigation inside the staff face is plain component state — no router
 * dependency, same as the other modules.
 */
export function App() {
  const path = window.location.pathname;
  const offerMatch = /^\/offer\/([^/]+)$/.exec(path);
  if (offerMatch) {
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    return <PublicOffer refId={decodeURIComponent(offerMatch[1]!)} token={token} />;
  }
  return <AdminApp />;
}

function AdminApp() {
  const [ready, setReady] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);
  const [view, setView] = useState<View>({ name: 'dashboard' });

  const load = useCallback(async () => {
    try {
      await api.me();
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
    setView({ name: 'dashboard' });
    setLoggedOut(true);
  }, []);

  if (loggedOut) {
    return <Login onSuccess={() => void load()} />;
  }
  if (!ready) {
    return <div className="boot mono">LOADING…</div>;
  }

  const activeNav =
    view.name === 'offer' || view.name === 'editor' ? 'offers' : view.name;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand mono">
          <span className="sidebar__num">MOD-13</span>
          <span>OFFERS</span>
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
        {view.name === 'dashboard' && (
          <Dashboard onOpen={(id) => setView({ name: 'offer', id })} onAuthLost={onAuthLost} />
        )}
        {view.name === 'offers' && (
          <OffersView
            onOpen={(id) => setView({ name: 'offer', id })}
            onNew={() => setView({ name: 'editor', id: null })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'offer' && (
          <OfferDetail
            id={view.id}
            onBack={() => setView({ name: 'offers' })}
            onEdit={(id) => setView({ name: 'editor', id })}
            onOpen={(id) => setView({ name: 'offer', id })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'editor' && (
          <OfferEditor
            id={view.id}
            onDone={(id) => setView(id === null ? { name: 'offers' } : { name: 'offer', id })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'customers' && <CustomersView onAuthLost={onAuthLost} />}
      </main>
    </div>
  );
}
