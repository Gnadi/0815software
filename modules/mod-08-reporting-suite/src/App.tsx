import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { Login } from './components/Login';
import { ReportsView } from './components/ReportsView';
import { ReportEditor } from './components/ReportEditor';
import { ReportWorkspace } from './components/ReportWorkspace';
import { ChartsView } from './components/ChartsView';
import { SchedulesView } from './components/SchedulesView';

export type View =
  | { name: 'reports' }
  | { name: 'report'; id: number }
  | { name: 'report-editor'; id: number | null }
  | { name: 'charts' }
  | { name: 'schedules' };

const NAV: { view: View; label: string }[] = [
  { view: { name: 'reports' }, label: 'Reports' },
  { view: { name: 'charts' }, label: 'Charts' },
  { view: { name: 'schedules' }, label: 'Schedules' },
];

export function App() {
  const [ready, setReady] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);
  const [view, setView] = useState<View>({ name: 'reports' });

  const load = useCallback(async () => {
    try {
      await api.me();
      setLoggedOut(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setLoggedOut(true);
      else throw err;
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onAuthLost = useCallback(() => {
    setView({ name: 'reports' });
    setLoggedOut(true);
  }, []);

  if (!ready) {
    return <div className="boot mono">LOADING…</div>;
  }
  if (loggedOut) {
    return <Login onSuccess={() => void load()} />;
  }

  const activeNav =
    view.name === 'report' || view.name === 'report-editor' ? 'reports' : view.name;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand mono">
          <span className="sidebar__num">MOD-08</span>
          <span>REPORTING SUITE</span>
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
        {view.name === 'reports' && (
          <ReportsView
            onOpen={(id) => setView({ name: 'report', id })}
            onNew={() => setView({ name: 'report-editor', id: null })}
            onEdit={(id) => setView({ name: 'report-editor', id })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'report' && (
          <ReportWorkspace
            id={view.id}
            onBack={() => setView({ name: 'reports' })}
            onEdit={(id) => setView({ name: 'report-editor', id })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'report-editor' && (
          <ReportEditor
            id={view.id}
            onDone={(id) => setView(id === null ? { name: 'reports' } : { name: 'report', id })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'charts' && <ChartsView onAuthLost={onAuthLost} />}
        {view.name === 'schedules' && <SchedulesView onAuthLost={onAuthLost} />}
      </main>
    </div>
  );
}
