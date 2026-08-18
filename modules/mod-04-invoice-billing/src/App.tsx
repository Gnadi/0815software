import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { CustomerLedger } from './components/CustomerLedger';
import { CustomersView } from './components/CustomersView';
import { InvoiceDetail } from './components/InvoiceDetail';
import { InvoiceEditor } from './components/InvoiceEditor';
import { InvoicesView } from './components/InvoicesView';
import { Login } from './components/Login';

export type View =
  | { name: 'invoices'; status?: string }
  | { name: 'invoice'; id: number }
  | { name: 'editor'; id: number | null }
  | { name: 'customers' }
  | { name: 'ledger'; id: number };

const NAV: { view: View; label: string }[] = [
  { view: { name: 'invoices' }, label: 'Invoices' },
  { view: { name: 'customers' }, label: 'Customers' },
];

/**
 * The view a path asks for, or the invoice list when it asks for nothing.
 *
 * These are the destinations `server/summary.ts` puts in its `href`s and the
 * ones MOD-15 Workspace hands off into, so the two must agree — a summary
 * pointing at `/invoices?status=overdue` and an app that ignored the path
 * would "work" by silently landing everyone on the unfiltered list, which
 * looks like a dead link and reads like a bug in the shell.
 *
 * Read once on load and then dropped: navigation inside the app stays plain
 * component state, with no router dependency and no history rewriting.
 */
export function initialView(path: string, search: string): View {
  const detail = /^\/invoices\/(\d+)$/.exec(path);
  if (detail) return { name: 'invoice', id: Number(detail[1]) };
  if (path === '/invoices/new') return { name: 'editor', id: null };
  if (path === '/invoices') {
    const status = new URLSearchParams(search).get('status');
    return { name: 'invoices', status: status ?? undefined };
  }
  const ledger = /^\/customers\/(\d+)$/.exec(path);
  if (ledger) return { name: 'ledger', id: Number(ledger[1]) };
  if (path === '/customers') return { name: 'customers' };
  return { name: 'invoices' };
}

export function App() {
  const [ready, setReady] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);
  const [view, setView] = useState<View>(() => initialView(window.location.pathname, window.location.search));

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
    setView({ name: 'invoices' });
    setLoggedOut(true);
  }, []);

  if (loggedOut) {
    return <Login onSuccess={() => void load()} />;
  }
  if (!ready) {
    return <div className="boot mono">LOADING…</div>;
  }

  const activeNav =
    view.name === 'invoice' || view.name === 'editor'
      ? 'invoices'
      : view.name === 'ledger'
        ? 'customers'
        : view.name;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand mono">
          <span className="sidebar__num">MOD-04</span>
          <span>INVOICE &amp; BILLING</span>
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
        {view.name === 'invoices' && (
          <InvoicesView
            initialStatus={view.status}
            onOpen={(id) => setView({ name: 'invoice', id })}
            onNew={() => setView({ name: 'editor', id: null })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'invoice' && (
          <InvoiceDetail
            id={view.id}
            onBack={() => setView({ name: 'invoices' })}
            onEdit={(id) => setView({ name: 'editor', id })}
            onOpenLedger={(id) => setView({ name: 'ledger', id })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'editor' && (
          <InvoiceEditor
            id={view.id}
            onDone={(id) => setView(id === null ? { name: 'invoices' } : { name: 'invoice', id })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'customers' && (
          <CustomersView onOpenLedger={(id) => setView({ name: 'ledger', id })} onAuthLost={onAuthLost} />
        )}
        {view.name === 'ledger' && (
          <CustomerLedger
            id={view.id}
            onBack={() => setView({ name: 'customers' })}
            onOpenInvoice={(id) => setView({ name: 'invoice', id })}
            onAuthLost={onAuthLost}
          />
        )}
      </main>
    </div>
  );
}
