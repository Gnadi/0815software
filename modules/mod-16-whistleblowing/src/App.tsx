import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type AppConfig } from './api';
import { CaseDetailView } from './components/CaseDetailView';
import { CaseQueue } from './components/CaseQueue';
import { Login } from './components/Login';
import { PublicStatus } from './components/PublicStatus';
import { PublicSubmit } from './components/PublicSubmit';

type View = { name: 'cases' } | { name: 'case'; id: number };

/** The authenticated case-handler console (login gate → shell). */
function HandlerConsole() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);
  const [view, setView] = useState<View>({ name: 'cases' });

  const load = useCallback(async () => {
    try {
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
    setView({ name: 'cases' });
    setLoggedOut(true);
  }, []);

  if (loggedOut) return <Login onSuccess={() => void load()} />;
  if (!config) return <div className="boot mono">LOADING…</div>;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand mono">
          <span className="sidebar__num">MOD-16</span>
          <span>WHISTLEBLOWING</span>
        </div>
        <nav className="sidebar__nav">
          <button className="sidebar__item mono is-active" onClick={() => setView({ name: 'cases' })}>
            Cases
          </button>
          <a className="sidebar__item mono" href="/">
            Public channel ↗
          </a>
        </nav>
        <div className="sidebar__foot mono">
          <span>{config.organisation.toUpperCase()}</span>
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
        {view.name === 'cases' && (
          <CaseQueue config={config} onOpen={(id) => setView({ name: 'case', id })} onAuthLost={onAuthLost} />
        )}
        {view.name === 'case' && (
          <CaseDetailView
            caseId={view.id}
            config={config}
            onBack={() => setView({ name: 'cases' })}
            onAuthLost={onAuthLost}
          />
        )}
      </main>
    </div>
  );
}

/**
 * Top-level router. Two public faces — file a report, check a report — and
 * the handler console behind /handler. Path-based, no router dependency: the
 * server serves index.html for every non-API GET.
 *
 * The reporting form is at `/`, deliberately. It is the face of this module,
 * and a reporter should never have to navigate past an admin login to find
 * it.
 */
export function App() {
  const path = window.location.pathname;

  if (path === '/status' || path.startsWith('/status/')) return <PublicStatus />;
  if (path === '/handler' || path.startsWith('/handler/')) return <HandlerConsole />;
  return <PublicSubmit />;
}
