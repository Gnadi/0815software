import { useCallback, useEffect, useState } from 'react';
import type { AppConfig } from '../shared/types';
import { api, ApiError } from './api';
import { ExportView } from './components/ExportView';
import { Login } from './components/Login';
import { PoDetailView } from './components/PoDetail';
import { PoEditor } from './components/PoEditor';
import { PosView } from './components/PosView';
import { RfqDetailView } from './components/RfqDetail';
import { RfqEditor } from './components/RfqEditor';
import { RfqsView } from './components/RfqsView';
import { SuppliersView } from './components/SuppliersView';

export type View =
  | { name: 'rfqs' }
  | { name: 'rfq'; id: number }
  | { name: 'rfq-editor'; id: number | null }
  | { name: 'pos' }
  | { name: 'po'; id: number }
  | { name: 'po-editor'; id: number | null }
  | { name: 'suppliers' }
  | { name: 'export' };

const NAV: { view: View; label: string }[] = [
  { view: { name: 'rfqs' }, label: 'RFQs' },
  { view: { name: 'pos' }, label: 'Purchase Orders' },
  { view: { name: 'suppliers' }, label: 'Suppliers' },
  { view: { name: 'export' }, label: 'ERP Export' },
];

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);
  const [view, setView] = useState<View>({ name: 'rfqs' });

  const load = useCallback(async () => {
    try {
      // /api/config doubles as the session probe — and is the ONE
      // source of approval rules and export profiles for the whole UI.
      setConfig(await api.config());
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
    setConfig(null);
    setView({ name: 'rfqs' });
    setLoggedOut(true);
  }, []);

  if (loggedOut) {
    return <Login onSuccess={() => void load()} />;
  }
  if (!config) {
    return <div className="boot mono">LOADING…</div>;
  }

  const activeNav =
    view.name === 'rfq' || view.name === 'rfq-editor'
      ? 'rfqs'
      : view.name === 'po' || view.name === 'po-editor'
        ? 'pos'
        : view.name;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand mono">
          <span className="sidebar__num">MOD-06</span>
          <span>PROCUREMENT TRACKER</span>
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
        {view.name === 'rfqs' && (
          <RfqsView
            onOpen={(id) => setView({ name: 'rfq', id })}
            onNew={() => setView({ name: 'rfq-editor', id: null })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'rfq' && (
          <RfqDetailView
            id={view.id}
            onBack={() => setView({ name: 'rfqs' })}
            onEdit={(id) => setView({ name: 'rfq-editor', id })}
            onOpenPo={(id) => setView({ name: 'po', id })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'rfq-editor' && (
          <RfqEditor
            id={view.id}
            onDone={(id) => setView(id === null ? { name: 'rfqs' } : { name: 'rfq', id })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'pos' && (
          <PosView
            onOpen={(id) => setView({ name: 'po', id })}
            onNew={() => setView({ name: 'po-editor', id: null })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'po' && (
          <PoDetailView
            id={view.id}
            config={config}
            onBack={() => setView({ name: 'pos' })}
            onEdit={(id) => setView({ name: 'po-editor', id })}
            onOpenRfq={(id) => setView({ name: 'rfq', id })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'po-editor' && (
          <PoEditor
            id={view.id}
            config={config}
            onDone={(id) => setView(id === null ? { name: 'pos' } : { name: 'po', id })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'suppliers' && <SuppliersView onAuthLost={onAuthLost} />}
        {view.name === 'export' && <ExportView config={config} onAuthLost={onAuthLost} />}
      </main>
    </div>
  );
}
