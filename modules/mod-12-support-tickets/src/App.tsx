import { useCallback, useEffect, useState } from 'react';
import type { Agent, AppConfig } from '../shared/types';
import { api, ApiError } from './api';
import { AgentsView } from './components/AgentsView';
import { Dashboard } from './components/Dashboard';
import { Login } from './components/Login';
import { PublicStatus } from './components/PublicStatus';
import { PublicSubmit } from './components/PublicSubmit';
import { Queue } from './components/Queue';
import { SlaPolicyView } from './components/SlaPolicyView';
import { TicketDetail } from './components/TicketDetail';

type AgentView =
  | { name: 'queue' }
  | { name: 'ticket'; ref: string }
  | { name: 'dashboard' }
  | { name: 'agents' }
  | { name: 'policy' };

const NAV: { view: AgentView; label: string }[] = [
  { view: { name: 'queue' }, label: 'Queue' },
  { view: { name: 'dashboard' }, label: 'SLA Dashboard' },
  { view: { name: 'agents' }, label: 'Agents' },
  { view: { name: 'policy' }, label: 'SLA Policy' },
];

/** The authenticated agent console (login gate → shell). */
function AgentConsole() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loggedOut, setLoggedOut] = useState(false);
  const [view, setView] = useState<AgentView>({ name: 'queue' });

  const load = useCallback(async () => {
    try {
      // /api/config doubles as the session probe and is the ONE source of
      // the workflow + SLA policy for the whole console.
      const [cfg, ag] = await Promise.all([api.config(), api.agents()]);
      setConfig(cfg);
      setAgents(ag.agents);
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
    setView({ name: 'queue' });
    setLoggedOut(true);
  }, []);

  if (loggedOut) {
    return <Login onSuccess={() => void load()} />;
  }
  if (!config) {
    return <div className="boot mono">LOADING…</div>;
  }

  const activeNav = view.name === 'ticket' ? 'queue' : view.name;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand mono">
          <span className="sidebar__num">MOD-12</span>
          <span>SUPPORT TICKETS</span>
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
          <span>SIGNED IN · {config.agent.toUpperCase()}</span>
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
        {view.name === 'queue' && (
          <Queue agents={agents} onOpen={(ref) => setView({ name: 'ticket', ref })} onAuthLost={onAuthLost} />
        )}
        {view.name === 'ticket' && (
          <TicketDetail
            ticketRef={view.ref}
            config={config}
            agents={agents}
            onBack={() => setView({ name: 'queue' })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'dashboard' && <Dashboard config={config} onAuthLost={onAuthLost} />}
        {view.name === 'agents' && <AgentsView agents={agents} />}
        {view.name === 'policy' && <SlaPolicyView config={config} />}
      </main>
    </div>
  );
}

/**
 * Top-level router. Two public faces (submit form, status page) live at
 * dedicated paths and need no login; everything under /agent is the
 * authenticated console. Path-based, no router dependency — the server
 * serves index.html for every non-API GET.
 */
export function App() {
  const path = window.location.pathname;

  if (path.startsWith('/ticket/')) {
    const ticketRef = decodeURIComponent(path.slice('/ticket/'.length));
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    return <PublicStatus ticketRef={ticketRef} token={token} />;
  }
  if (path === '/agent' || path.startsWith('/agent/')) {
    return <AgentConsole />;
  }
  return <PublicSubmit />;
}
