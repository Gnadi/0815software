import { useCallback, useEffect, useState } from 'react';
import { AccessProvider, type AccessLevel } from './access';
import { api, ApiError } from './api';
import { AbsencesView } from './components/AbsencesView';
import { DailyEntryView } from './components/DailyEntryView';
import { EmployeesView } from './components/EmployeesView';
import { MyTasksView } from './components/MyTasksView';
import { MyAreaView } from './components/MyAreaView';
import { FlexView } from './components/FlexView';
import { ExportView } from './components/ExportView';
import { ExpensesView } from './components/ExpensesView';
import { wipeOffline } from './pwa/outbox';
import { Login } from './components/Login';
import { ProjectsView } from './components/ProjectsView';
import { SummaryView } from './components/SummaryView';
import { TimesheetsView } from './components/TimesheetsView';

export type View = 'my-area' | 'daily' | 'my-tasks' | 'absences' | 'expenses' | 'flex' | 'projects' | 'employees' | 'timesheets' | 'summary' | 'export';

const NAV: { view: View; label: string }[] = [
  { view: 'my-area', label: 'My Area' },
  { view: 'daily', label: 'Daily Entry' },
  { view: 'my-tasks', label: 'My Tasks' },
  { view: 'timesheets', label: 'Timesheets' },
  { view: 'absences', label: 'Absences' },
  { view: 'expenses', label: 'Expenses' },
  { view: 'flex', label: 'Flexitime' },
  { view: 'summary', label: 'Summary' },
  { view: 'export', label: 'Export' },
  { view: 'projects', label: 'Projects' },
  { view: 'employees', label: 'Employees' },
];

const ME_KEY = 'mod11.me';

function readCachedMe(): { username: string; access: AccessLevel; employee_id: number | null } | null {
  try {
    const raw = localStorage.getItem(ME_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function App() {
  const [ready, setReady] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);
  const [access, setAccess] = useState<AccessLevel>('view');
  const [ownEmployeeId, setOwnEmployeeId] = useState<number | null>(null);
  const [username, setUsername] = useState('');
  // Opened from the installed app without a connection: straight to capturing.
  const [view, setView] = useState<View>(navigator.onLine ? 'my-area' : 'expenses');

  const load = useCallback(async () => {
    try {
      const me = await api.me();
      setAccess(me.access);
      setOwnEmployeeId(me.employee_id);
      setUsername(me.username);
      // Who was signed in, for opening the app offline. Removed on sign-out.
      localStorage.setItem(ME_KEY, JSON.stringify(me));
      setReady(true);
      setLoggedOut(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setLoggedOut(true);
        return;
      }
      // No connection: the last signed-in person may capture; the server checks the session when it is back.
      const cached = readCachedMe();
      if (err instanceof TypeError && cached) {
        setAccess(cached.access);
        setOwnEmployeeId(cached.employee_id);
        setUsername(cached.username);
        setView('expenses');
        setReady(true);
        return;
      }
      throw err;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onAuthLost = useCallback(() => {
    setReady(false);
    setView('my-area');
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
            <span>TIME & EXPENSES</span>
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
                // A shared phone keeps nothing of the last person: captures waiting, the cached login.
                void wipeOffline()
                  .then(() => api.logout())
                  .catch(() => undefined)
                  .then(onAuthLost);
              }}
            >
              LOG OUT ↗
            </button>
          </div>
        </aside>
        <main className="main">
          {view === 'my-area' && <MyAreaView onNavigate={setView} onAuthLost={onAuthLost} />}
          {view === 'daily' && <DailyEntryView ownEmployeeId={ownEmployeeId} onAuthLost={onAuthLost} />}
          {view === 'timesheets' && <TimesheetsView ownEmployeeId={ownEmployeeId} onAuthLost={onAuthLost} />}
          {view === 'absences' && <AbsencesView ownEmployeeId={ownEmployeeId} onAuthLost={onAuthLost} />}
          {view === 'expenses' && <ExpensesView username={username} ownEmployeeId={ownEmployeeId} onAuthLost={onAuthLost} />}
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
