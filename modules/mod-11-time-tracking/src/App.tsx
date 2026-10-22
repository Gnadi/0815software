import { useCallback, useEffect, useState } from 'react';
import { AccessProvider, type AccessLevel } from './access';
import { api, ApiError } from './api';
import { AbsencesView } from './components/AbsencesView';
import { DailyEntryView } from './components/DailyEntryView';
import { EmployeesView } from './components/EmployeesView';
import { MyTasksView } from './components/MyTasksView';
import { FlexView } from './components/FlexView';
import { ExportView } from './components/ExportView';
import { Login } from './components/Login';
import { ProjectsView } from './components/ProjectsView';
import { SummaryView } from './components/SummaryView';
import { TimesheetsView } from './components/TimesheetsView';

export type View = 'daily' | 'my-tasks' | 'absences' | 'flex' | 'projects' | 'employees' | 'timesheets' | 'summary' | 'export';

const NAV: { view: View; label: string }[] = [
  { view: 'daily', label: 'Daily Entry' },
  { view: 'my-tasks', label: 'My Tasks' },
  { view: 'timesheets', label: 'Timesheets' },
  { view: 'absences', label: 'Absences' },
  { view: 'flex', label: 'Flexitime' },
  { view: 'summary', label: 'Summary' },
  { view: 'export', label: 'Export' },
  { view: 'projects', label: 'Projects' },
  { view: 'employees', label: 'Employees' },
];

export function App() {
  const [ready, setReady] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);
  const [access, setAccess] = useState<AccessLevel>('view');
  const [ownEmployeeId, setOwnEmployeeId] = useState<number | null>(null);
  const [view, setView] = useState<View>('daily');

  const load = useCallback(async () => {
    try {
      const me = await api.me();
      setAccess(me.access);
      setOwnEmployeeId(me.employee_id);
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
    <AccessProvider level={access}>
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
          {view === 'daily' && <DailyEntryView ownEmployeeId={ownEmployeeId} onAuthLost={onAuthLost} />}
          {view === 'timesheets' && <TimesheetsView ownEmployeeId={ownEmployeeId} onAuthLost={onAuthLost} />}
          {view === 'absences' && <AbsencesView ownEmployeeId={ownEmployeeId} onAuthLost={onAuthLost} />}
          {view === 'my-tasks' && <MyTasksView onAuthLost={onAuthLost} />}
          {view === 'flex' && <FlexView ownEmployeeId={ownEmployeeId} onAuthLost={onAuthLost} />}
          {view === 'summary' && <SummaryView onAuthLost={onAuthLost} />}
          {view === 'export' && <ExportView onAuthLost={onAuthLost} />}
          {view === 'projects' && <ProjectsView onAuthLost={onAuthLost} />}
          {view === 'employees' && <EmployeesView onAuthLost={onAuthLost} />}
        </main>
      </div>
    </AccessProvider>
  );
}
