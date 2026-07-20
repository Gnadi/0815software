import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { DepartmentsView } from './components/DepartmentsView';
import { DirectoryView } from './components/DirectoryView';
import { EmployeeDetailView } from './components/EmployeeDetail';
import { Login } from './components/Login';
import { OnboardingView } from './components/OnboardingView';
import { OrgChartView } from './components/OrgChartView';

export type View =
  | { name: 'directory' }
  | { name: 'employee'; id: number }
  | { name: 'orgchart' }
  | { name: 'departments' }
  | { name: 'onboarding' };

const NAV: { view: View; label: string }[] = [
  { view: { name: 'directory' }, label: 'Directory' },
  { view: { name: 'orgchart' }, label: 'Org Chart' },
  { view: { name: 'departments' }, label: 'Departments' },
  { view: { name: 'onboarding' }, label: 'Onboarding' },
];

export function App() {
  const [ready, setReady] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);
  const [view, setView] = useState<View>({ name: 'directory' });

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
    setView({ name: 'directory' });
    setLoggedOut(true);
  }, []);

  if (loggedOut) {
    return <Login onSuccess={() => void load()} />;
  }
  if (!ready) {
    return <div className="boot mono">LOADING…</div>;
  }

  const activeNav = view.name === 'employee' ? 'directory' : view.name;
  const openEmployee = (id: number) => setView({ name: 'employee', id });

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand mono">
          <span className="sidebar__num">MOD-05</span>
          <span>EMPLOYEE DIRECTORY</span>
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
        {view.name === 'directory' && <DirectoryView onOpen={openEmployee} onAuthLost={onAuthLost} />}
        {view.name === 'employee' && (
          <EmployeeDetailView
            id={view.id}
            onBack={() => setView({ name: 'directory' })}
            onOpen={openEmployee}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'orgchart' && <OrgChartView onOpen={openEmployee} onAuthLost={onAuthLost} />}
        {view.name === 'departments' && <DepartmentsView onAuthLost={onAuthLost} />}
        {view.name === 'onboarding' && <OnboardingView onOpen={openEmployee} onAuthLost={onAuthLost} />}
      </main>
    </div>
  );
}
