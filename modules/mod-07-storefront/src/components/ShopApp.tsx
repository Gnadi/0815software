import { useCallback, useEffect, useState } from 'react';
import type { Cart } from '../../shared/types';
import { shop, type CheckoutResult } from '../api';
import { Catalogue } from './Catalogue';
import { CartView } from './CartView';
import { CheckoutView } from './CheckoutView';
import { OrderStatusView } from './OrderStatusView';
import { ProductView } from './ProductView';

export type ShopView =
  | { name: 'catalogue' }
  | { name: 'product'; id: number }
  | { name: 'cart' }
  | { name: 'checkout' }
  | { name: 'confirmation'; result: CheckoutResult }
  | { name: 'status'; ref: string; token: string };

const EMPTY_CART: Cart = {
  lines: [],
  totals: { net_cents: 0, vat_cents: 0, gross_cents: 0, by_rate: [] },
  item_count: 0,
};

export function ShopApp({ initialOrder }: { initialOrder?: { ref: string; token: string } }) {
  const [view, setView] = useState<ShopView>(
    initialOrder ? { name: 'status', ...initialOrder } : { name: 'catalogue' },
  );
  const [cart, setCart] = useState<Cart>(EMPTY_CART);

  const refreshCart = useCallback(async () => {
    setCart(await shop.cart());
  }, []);

  useEffect(() => {
    void refreshCart();
  }, [refreshCart]);

  return (
    <div className="shop">
      <header className="shopbar">
        <button className="shopbar__brand mono" onClick={() => setView({ name: 'catalogue' })}>
          <span className="shopbar__num">MOD-07</span>
          <span>STOREFRONT</span>
        </button>
        <nav className="shopbar__nav mono">
          <button
            className={`shopbar__item ${view.name === 'catalogue' || view.name === 'product' ? 'is-active' : ''}`}
            onClick={() => setView({ name: 'catalogue' })}
          >
            SHOP
          </button>
          <button
            className={`shopbar__item ${view.name === 'cart' ? 'is-active' : ''}`}
            onClick={() => setView({ name: 'cart' })}
          >
            CART{cart.item_count > 0 ? ` (${cart.item_count})` : ''}
          </button>
          <a className="shopbar__item shopbar__item--dim" href="/admin">
            ADMIN ↗
          </a>
        </nav>
      </header>
      <main className="shop__main">
        {view.name === 'catalogue' && (
          <Catalogue onOpen={(id) => setView({ name: 'product', id })} />
        )}
        {view.name === 'product' && (
          <ProductView
            id={view.id}
            cart={cart}
            onCartChange={setCart}
            onBack={() => setView({ name: 'catalogue' })}
            onGoToCart={() => setView({ name: 'cart' })}
          />
        )}
        {view.name === 'cart' && (
          <CartView
            cart={cart}
            onCartChange={setCart}
            onBrowse={() => setView({ name: 'catalogue' })}
            onCheckout={() => setView({ name: 'checkout' })}
          />
        )}
        {view.name === 'checkout' && (
          <CheckoutView
            cart={cart}
            onBack={() => setView({ name: 'cart' })}
            onPlaced={(result) => {
              setCart(EMPTY_CART);
              setView({ name: 'confirmation', result });
            }}
            onCartInvalid={() => {
              void refreshCart();
              setView({ name: 'cart' });
            }}
          />
        )}
        {view.name === 'confirmation' && (
          <OrderStatusView
            orderRef={view.result.ref}
            token={view.result.token}
            initial={view.result.order}
            confirmation
            onBrowse={() => setView({ name: 'catalogue' })}
          />
        )}
        {view.name === 'status' && (
          <OrderStatusView
            orderRef={view.ref}
            token={view.token}
            onBrowse={() => setView({ name: 'catalogue' })}
          />
        )}
      </main>
      <footer className="shop__foot mono">
        0815SOFTWARE · MOD-07 STOREFRONT · MIT — NO SAAS FEES, NO REVENUE CUT
      </footer>
    </div>
  );
}
