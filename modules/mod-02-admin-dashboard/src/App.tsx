import { useCallback, useEffect, useState } from 'react';
import type { ResourceDef } from '../shared/resources';
import { api, ApiError } from './api';
import { Login } from './components/Login';
import { ResourceView } from './components/ResourceView';

export function App() {
  const [resources, setResources] = useState<ResourceDef[] | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);
  const [active, setActive] = useState<string>('');

  const loadConfig = useCallback(async () => {
    try {
      const config = await api.config();
      setResources(config.resources);
      setActive((current) => current || config.resources[0]?.name || '');
      setLoggedOut(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setLoggedOut(true);
      else throw err;
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  if (loggedOut) {
    return <Login onSuccess={() => void loadConfig()} />;
  }
  if (!resources) {
    return <div className="boot mono">LOADING…</div>;
  }

  const resource = resources.find((r) => r.name === active) ?? resources[0];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand mono">
          <span className="sidebar__num">MOD-02</span>
          <span>ADMIN DASHBOARD</span>
        </div>
        <nav className="sidebar__nav">
          {resources.map((r) => (
            <button
              key={r.name}
              className={`sidebar__item mono ${r.name === resource?.name ? 'is-active' : ''}`}
              onClick={() => setActive(r.name)}
            >
              {r.label}
            </button>
          ))}
        </nav>
        <div className="sidebar__foot mono">
          <span>0815SOFTWARE · MIT</span>
          <button
            className="sidebar__logout mono"
            onClick={() => {
              void api.logout().then(() => setLoggedOut(true));
            }}
          >
            LOG OUT ↗
          </button>
        </div>
      </aside>
      <main className="main">
        {resource && (
          <ResourceView key={resource.name} resource={resource} onAuthLost={() => setLoggedOut(true)} />
        )}
      </main>
    </div>
  );
}
