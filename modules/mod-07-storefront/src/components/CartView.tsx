import { useState } from 'react';
import type { Cart } from '../../shared/types';
import { ApiError, shop } from '../api';
import { fmtEur } from '../format';
import { ProductMark } from './ProductMark';

export function CartView({
  cart,
  onCartChange,
  onBrowse,
  onCheckout,
}: {
  cart: Cart;
  onCartChange: (cart: Cart) => void;
  onBrowse: () => void;
  onCheckout: () => void;
}) {
  const [error, setError] = useState('');

  async function setQuantity(productId: number, quantity: number) {
    setError('');
    try {
      onCartChange(await shop.setQuantity(productId, quantity));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the cart');
    }
  }

  const blocked = cart.lines.some((l) => l.quantity > l.available);

  if (cart.lines.length === 0) {
    return (
      <section>
        <div className="resource__head">
          <div>
            <p className="resource__eyebrow mono">CART</p>
            <h1 className="resource__title">Nothing here yet.</h1>
          </div>
        </div>
        <button className="btn btn--ghost" onClick={onBrowse}>BROWSE THE CATALOGUE →</button>
      </section>
    );
  }

  return (
    <section>
      <div className="resource__head">
        <div>
          <p className="resource__eyebrow mono">CART</p>
          <h1 className="resource__title">Your cart.</h1>
          <p className="resource__desc">Prices are live until checkout — then they are locked into the order.</p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">PRODUCT</th>
              <th className="mono">UNIT PRICE</th>
              <th className="mono">QTY</th>
              <th className="mono">LINE TOTAL</th>
              <th className="mono" />
            </tr>
          </thead>
          <tbody>
            {cart.lines.map((line) => (
              <tr key={line.product_id}>
                <td>
                  <div className="cartline">
                    <ProductMark name={line.name} accent={line.accent} size="thumb" />
                    <div>
                      <div>{line.name}</div>
                      <div className="table__id mono">{line.sku}</div>
                      {line.quantity > line.available && (
                        <div className="field__error mono">
                          ONLY {line.available} AVAILABLE — REDUCE THE QUANTITY
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="table__num mono">{fmtEur(line.unit_price_cents)}</td>
                <td>
                  <input
                    className="field__input cartline__qty"
                    type="number"
                    min={0}
                    value={line.quantity}
                    onChange={(e) => {
                      const q = Math.max(0, Math.floor(Number(e.target.value)) || 0);
                      void setQuantity(line.product_id, q);
                    }}
                  />
                </td>
                <td className="table__num mono">{fmtEur(line.line_gross_cents)}</td>
                <td>
                  <button
                    className="rowbtn rowbtn--danger mono"
                    onClick={() => void setQuantity(line.product_id, 0)}
                  >
                    REMOVE
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="totals">
        {cart.totals.by_rate.map((r) => (
          <div key={r.rate} className="totals__row mono">
            <span>INCL. {r.rate}% VAT</span>
            <span>{fmtEur(r.vat_cents)}</span>
          </div>
        ))}
        <div className="totals__row mono">
          <span>NET</span>
          <span>{fmtEur(cart.totals.net_cents)}</span>
        </div>
        <div className="totals__row totals__row--gross mono">
          <span>TOTAL</span>
          <span>{fmtEur(cart.totals.gross_cents)}</span>
        </div>
      </div>

      <div className="cart__actions">
        <button className="btn btn--ghost" onClick={onBrowse}>← KEEP BROWSING</button>
        <button className="btn btn--primary" onClick={onCheckout} disabled={blocked}>
          CHECKOUT →
        </button>
      </div>
    </section>
  );
}
