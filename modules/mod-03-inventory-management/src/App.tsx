import { useCallback, useEffect, useState } from 'react';
import type { Warehouse } from '../shared/types';
import { api, ApiError } from './api';
import { Login } from './components/Login';
import { ProductDetail } from './components/ProductDetail';
import { ProductsView } from './components/ProductsView';
import { PurchaseOrderView } from './components/PurchaseOrderView';
import { PurchaseOrdersView } from './components/PurchaseOrdersView';
import { StockOverview } from './components/StockOverview';

export type View =
  | { name: 'stock' }
  | { name: 'products' }
  | { name: 'product'; id: number }
  | { name: 'pos' }
  | { name: 'po'; id: number };

const NAV: { view: View; label: string }[] = [
  { view: { name: 'stock' }, label: 'Stock' },
  { view: { name: 'products' }, label: 'Products' },
  { view: { name: 'pos' }, label: 'Purchase Orders' },
];

export function App() {
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);
  const [view, setView] = useState<View>({ name: 'stock' });

  const load = useCallback(async () => {
    try {
      const { warehouses: list } = await api.warehouses();
      setWarehouses(list);
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
    setWarehouses(null);
    setView({ name: 'stock' });
    setLoggedOut(true);
  }, []);

  if (loggedOut) {
    return <Login onSuccess={() => void load()} />;
  }
  if (!warehouses) {
    return <div className="boot mono">LOADING…</div>;
  }

  const activeNav = view.name === 'product' ? 'products' : view.name === 'po' ? 'pos' : view.name;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand mono">
          <span className="sidebar__num">MOD-03</span>
          <span>INVENTORY MANAGEMENT</span>
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
        {view.name === 'stock' && (
          <StockOverview
            warehouses={warehouses}
            onOpenProduct={(id) => setView({ name: 'product', id })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'products' && (
          <ProductsView onOpen={(id) => setView({ name: 'product', id })} onAuthLost={onAuthLost} />
        )}
        {view.name === 'product' && (
          <ProductDetail
            id={view.id}
            onBack={() => setView({ name: 'products' })}
            onAuthLost={onAuthLost}
          />
        )}
        {view.name === 'pos' && (
          <PurchaseOrdersView onOpen={(id) => setView({ name: 'po', id })} onAuthLost={onAuthLost} />
        )}
        {view.name === 'po' && (
          <PurchaseOrderView
            id={view.id}
            warehouses={warehouses}
            onBack={() => setView({ name: 'pos' })}
            onAuthLost={onAuthLost}
          />
        )}
      </main>
    </div>
  );
}
