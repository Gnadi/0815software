import { useCallback, useEffect, useState } from 'react';
import type { UserProfile } from '../shared/types';
import { api, ApiError } from './api';
import { Login } from './components/Login';
import { MattersList } from './components/MattersList';
import { MatterDetail } from './components/MatterDetail';
import { DocumentDetail } from './components/DocumentDetail';
import { DocumentsView } from './components/DocumentsView';
import { UsersView } from './components/UsersView';
import { Account } from './components/Account';
import { RetentionView } from './components/RetentionView';
import { SettingsView } from './components/SettingsView';
import { SharePage } from './components/SharePage';

export type View =
  | { name: 'matters' }
  | { name: 'matter'; id: number }
  | { name: 'document'; id: number }
  | { name: 'documents' }
  | { name: 'users' }
  | { name: 'retention' }
  | { name: 'settings' }
  | { name: 'account' };

/** A share link (/s/<token>) is the public page — no login, no shell. */
export function App() {
  const shared = /^\/s\/([A-Za-z0-9_-]{20,100})$/.exec(window.location.pathname);
  if (shared) return <SharePage token={shared[1]!} />;
  return <Signed />;
}

function Signed() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);
  const [view, setView] = useState<View>({ name: 'matters' });

  const loadProfile = useCallback(async () => {
    try {
      const { user: profile } = await api.me();
      setUser(profile);
      setLoggedOut(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setLoggedOut(true);
      else throw err;
    }
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const onAuthLost = useCallback(() => {
    setUser(null);
    setView({ name: 'matters' });
    setLoggedOut(true);
  }, []);

  if (loggedOut) {
    return <Login onSuccess={() => void loadProfile()} />;
  }
  if (!user) {
    return <div className="boot mono">LOADING…</div>;
  }

  const nav: { view: View; label: string }[] = [
    { view: { name: 'matters' }, label: 'Matters' },
    { view: { name: 'documents' }, label: 'All Documents' },
    ...(user.role === 'admin'
      ? [
          { view: { name: 'users' } as View, label: 'Users' },
          { view: { name: 'retention' } as View, label: 'Retention' },
          { view: { name: 'settings' } as View, label: 'Settings' },
        ]
      : []),
    { view: { name: 'account' }, label: 'Account' },
  ];
  const activeNav =
    view.name === 'matter' ? 'matters' : view.name === 'document' ? 'documents' : view.name;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand mono">
          <span className="sidebar__num">MOD-09</span>
          <span>DOCUMENT MANAGEMENT</span>
        </div>
        <nav className="sidebar__nav">
          {nav.map(({ view: target, label }) => (
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
          <span className="sidebar__who">
            {user.name} · {user.role.toUpperCase()}
          </span>
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
        {view.name === 'matters' && (
          <MattersList onOpen={(id) => setView({ name: 'matter', id })} onAuthLost={onAuthLost} />
        )}
        {view.name === 'matter' && (
          <MatterDetail
            id={view.id}
            user={user}
            onBack={() => setView({ name: 'matters' })}
            onOpenDocument={(id) => setView({ name: 'document', id })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'document' && (
          <DocumentDetail
            id={view.id}
            onBack={() => setView({ name: 'documents' })}
            onOpenMatter={(id) => setView({ name: 'matter', id })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'documents' && (
          <DocumentsView onOpen={(id) => setView({ name: 'document', id })} onAuthLost={onAuthLost} />
        )}
        {view.name === 'users' && <UsersView onAuthLost={onAuthLost} />}
        {view.name === 'retention' && <RetentionView onOpenDocument={(id) => setView({ name: 'document', id })} onAuthLost={onAuthLost} />}
        {view.name === 'settings' && <SettingsView onAuthLost={onAuthLost} />}
        {view.name === 'account' && <Account user={user} onAuthLost={onAuthLost} />}
      </main>
    </div>
  );
}
