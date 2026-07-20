import { useCallback, useEffect, useState } from 'react';
import type { AppConfig } from '../shared/types';
import { api, ApiError } from './api';
import { ApplicationDetail } from './components/ApplicationDetail';
import { ApplicationsView } from './components/ApplicationsView';
import { DeadlinesDashboard } from './components/DeadlinesDashboard';
import { Login } from './components/Login';
import { PortfolioView } from './components/PortfolioView';
import { ProgramDetail } from './components/ProgramDetail';
import { ProgramsView } from './components/ProgramsView';

type View =
  | { name: 'deadlines' }
  | { name: 'programs' }
  | { name: 'program'; id: number }
  | { name: 'applications' }
  | { name: 'application'; id: number }
  | { name: 'portfolio' };

const NAV: { view: View; label: string; active: View['name'] }[] = [
  { view: { name: 'deadlines' }, label: 'Deadlines', active: 'deadlines' },
  { view: { name: 'programs' }, label: 'Programs', active: 'programs' },
  { view: { name: 'applications' }, label: 'Applications', active: 'applications' },
  { view: { name: 'portfolio' }, label: 'Portfolio', active: 'portfolio' },
];

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);
  const [view, setView] = useState<View>({ name: 'deadlines' });

  const load = useCallback(async () => {
    try {
      // /api/config doubles as the session probe and is the ONE source of
      // the workflow + categories for the whole console.
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
    setView({ name: 'deadlines' });
    setLoggedOut(true);
  }, []);

  if (loggedOut) {
    return <Login onSuccess={() => void load()} />;
  }
  if (!config) {
    return <div className="boot mono">LOADING…</div>;
  }

  const activeNav: View['name'] =
    view.name === 'program' ? 'programs' : view.name === 'application' ? 'applications' : view.name;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand mono">
          <span className="sidebar__num">MOD-14</span>
          <span>SUBSIDIES &amp; FUNDS</span>
        </div>
        <nav className="sidebar__nav">
          {NAV.map(({ view: target, label, active }) => (
            <button
              key={active}
              className={`sidebar__item mono ${active === activeNav ? 'is-active' : ''}`}
              onClick={() => setView(target)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar__foot mono">
          <span>SIGNED IN · {config.admin.toUpperCase()}</span>
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
        {view.name === 'deadlines' && (
          <DeadlinesDashboard
            config={config}
            onAuthLost={onAuthLost}
            onOpenApplication={(id) => setView({ name: 'application', id })}
          />
        )}
        {view.name === 'programs' && (
          <ProgramsView config={config} onOpen={(id) => setView({ name: 'program', id })} onAuthLost={onAuthLost} />
        )}
        {view.name === 'program' && (
          <ProgramDetail
            programId={view.id}
            onBack={() => setView({ name: 'programs' })}
            onOpenApplication={(id) => setView({ name: 'application', id })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'applications' && (
          <ApplicationsView config={config} onOpen={(id) => setView({ name: 'application', id })} onAuthLost={onAuthLost} />
        )}
        {view.name === 'application' && (
          <ApplicationDetail
            applicationId={view.id}
            onBack={() => setView({ name: 'applications' })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'portfolio' && <PortfolioView config={config} onAuthLost={onAuthLost} />}
      </main>
    </div>
  );
}
