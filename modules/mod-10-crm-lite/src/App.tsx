import { useCallback, useEffect, useState } from 'react';
import type { AppConfig } from '../shared/types';
import { api, ApiError } from './api';
import { Login } from './components/Login';
import { Dashboard } from './components/Dashboard';
import { PipelineBoard } from './components/PipelineBoard';
import { DealDetailView } from './components/DealDetail';
import { ContactsView } from './components/ContactsView';
import { ContactDetailView } from './components/ContactDetail';
import { CompaniesView } from './components/CompaniesView';
import { CompanyDetailView } from './components/CompanyDetail';
import { FollowUpsView } from './components/FollowUpsView';

export type View =
  | { name: 'dashboard' }
  | { name: 'pipeline' }
  | { name: 'deal'; id: number }
  | { name: 'contacts' }
  | { name: 'contact'; id: number }
  | { name: 'companies' }
  | { name: 'company'; id: number }
  | { name: 'followups' };

const NAV: { view: View; label: string }[] = [
  { view: { name: 'dashboard' }, label: 'Dashboard' },
  { view: { name: 'pipeline' }, label: 'Pipeline' },
  { view: { name: 'contacts' }, label: 'Contacts' },
  { view: { name: 'companies' }, label: 'Companies' },
  { view: { name: 'followups' }, label: 'Follow-ups' },
];

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);
  const [view, setView] = useState<View>({ name: 'dashboard' });

  const load = useCallback(async () => {
    try {
      // /api/config doubles as the session probe — and is the ONE source
      // of the pipeline stages for the whole UI.
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
    setView({ name: 'dashboard' });
    setLoggedOut(true);
  }, []);

  if (loggedOut) {
    return <Login onSuccess={() => void load()} />;
  }
  if (!config) {
    return <div className="boot mono">LOADING…</div>;
  }

  const activeNav: string =
    view.name === 'deal'
      ? 'pipeline'
      : view.name === 'contact'
        ? 'contacts'
        : view.name === 'company'
          ? 'companies'
          : view.name;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand mono">
          <span className="sidebar__num">MOD-10</span>
          <span>CRM LITE</span>
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
        {view.name === 'dashboard' && <Dashboard onAuthLost={onAuthLost} />}
        {view.name === 'pipeline' && (
          <PipelineBoard config={config} onOpen={(id) => setView({ name: 'deal', id })} onAuthLost={onAuthLost} />
        )}
        {view.name === 'deal' && (
          <DealDetailView
            id={view.id}
            config={config}
            onBack={() => setView({ name: 'pipeline' })}
            onOpenContact={(id) => setView({ name: 'contact', id })}
            onOpenCompany={(id) => setView({ name: 'company', id })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'contacts' && (
          <ContactsView onOpen={(id) => setView({ name: 'contact', id })} onAuthLost={onAuthLost} />
        )}
        {view.name === 'contact' && (
          <ContactDetailView
            id={view.id}
            config={config}
            onBack={() => setView({ name: 'contacts' })}
            onOpenDeal={(id) => setView({ name: 'deal', id })}
            onOpenCompany={(id) => setView({ name: 'company', id })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'companies' && (
          <CompaniesView onOpen={(id) => setView({ name: 'company', id })} onAuthLost={onAuthLost} />
        )}
        {view.name === 'company' && (
          <CompanyDetailView
            id={view.id}
            onBack={() => setView({ name: 'companies' })}
            onOpenContact={(id) => setView({ name: 'contact', id })}
            onOpenDeal={(id) => setView({ name: 'deal', id })}
            onDeleted={() => setView({ name: 'companies' })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'followups' && (
          <FollowUpsView
            onOpenDeal={(id) => setView({ name: 'deal', id })}
            onOpenContact={(id) => setView({ name: 'contact', id })}
            onAuthLost={onAuthLost}
          />
        )}
      </main>
    </div>
  );
}
