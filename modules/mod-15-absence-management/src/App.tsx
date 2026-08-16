import { useCallback, useEffect, useState } from 'react';
import type { Employee } from '../shared/types';
import { api, ApiError, type AppConfig } from './api';
import { BalancesView } from './components/BalancesView';
import { CalendarView } from './components/CalendarView';
import { Login } from './components/Login';
import { RequestDetail } from './components/RequestDetail';
import { RequestsView } from './components/RequestsView';
import { TeamView } from './components/TeamView';

type View =
  | { name: 'requests' }
  | { name: 'request'; id: number }
  | { name: 'balances' }
  | { name: 'team' }
  | { name: 'calendar' };

const NAV: { view: View; label: string }[] = [
  { view: { name: 'requests' }, label: 'Requests' },
  { view: { name: 'balances' }, label: 'Balances' },
  { view: { name: 'team' }, label: 'Team' },
  { view: { name: 'calendar' }, label: 'Calendar' },
];

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loggedOut, setLoggedOut] = useState(false);
  const [view, setView] = useState<View>({ name: 'requests' });

  const load = useCallback(async () => {
    try {
      // /api/config doubles as the session probe and is the ONE source of the
      // absence types and regions for the whole console — the client can never
      // offer an option the server would reject.
      const [cfg, people] = await Promise.all([api.config(), api.employees()]);
      setConfig(cfg);
      setEmployees(people.employees);
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
    setView({ name: 'requests' });
    setLoggedOut(true);
  }, []);

  if (loggedOut) return <Login onSuccess={() => void load()} />;
  if (!config) return <div className="boot mono">LOADING…</div>;

  const activeNav = view.name === 'request' ? 'requests' : view.name;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand mono">
          <span className="sidebar__num">MOD-15</span>
          <span>ABSENCE MANAGEMENT</span>
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
          <span>SIGNED IN · {config.username.toUpperCase()}</span>
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
        {view.name === 'requests' && (
          <RequestsView
            config={config}
            employees={employees}
            onOpen={(id) => setView({ name: 'request', id })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'request' && (
          <RequestDetail
            requestId={view.id}
            config={config}
            onBack={() => setView({ name: 'requests' })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'balances' && <BalancesView config={config} onAuthLost={onAuthLost} />}
        {view.name === 'team' && <TeamView config={config} onChanged={() => void load()} onAuthLost={onAuthLost} />}
        {view.name === 'calendar' && <CalendarView config={config} onAuthLost={onAuthLost} />}
      </main>
    </div>
  );
}
