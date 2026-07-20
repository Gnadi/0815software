import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { DailyEntryView } from './components/DailyEntryView';
import { EmployeesView } from './components/EmployeesView';
import { ExportView } from './components/ExportView';
import { Login } from './components/Login';
import { ProjectsView } from './components/ProjectsView';
import { SummaryView } from './components/SummaryView';
import { TimesheetsView } from './components/TimesheetsView';

export type View = 'daily' | 'projects' | 'employees' | 'timesheets' | 'summary' | 'export';

const NAV: { view: View; label: string }[] = [
  { view: 'daily', label: 'Daily Entry' },
  { view: 'timesheets', label: 'Timesheets' },
  { view: 'summary', label: 'Summary' },
  { view: 'export', label: 'Export' },
  { view: 'projects', label: 'Projects' },
  { view: 'employees', label: 'Employees' },
];

export function App() {
  const [ready, setReady] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);
  const [view, setView] = useState<View>('daily');

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
    setView('daily');
    setLoggedOut(true);
  }, []);

  if (loggedOut) {
    return <Login onSuccess={() => void load()} />;
  }
  if (!ready) {
    return <div className="boot mono">LOADING…</div>;
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand mono">
          <span className="sidebar__num">MOD-11</span>
          <span>TIME TRACKING</span>
        </div>
        <nav className="sidebar__nav">
          {NAV.map(({ view: target, label }) => (
            <button
              key={target}
              className={`sidebar__item mono ${target === view ? 'is-active' : ''}`}
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
        {view === 'daily' && <DailyEntryView onAuthLost={onAuthLost} />}
        {view === 'timesheets' && <TimesheetsView onAuthLost={onAuthLost} />}
        {view === 'summary' && <SummaryView onAuthLost={onAuthLost} />}
        {view === 'export' && <ExportView onAuthLost={onAuthLost} />}
        {view === 'projects' && <ProjectsView onAuthLost={onAuthLost} />}
        {view === 'employees' && <EmployeesView onAuthLost={onAuthLost} />}
      </main>
    </div>
  );
}
