import { useState, type FormEvent } from 'react';
import type { Cart } from '../../shared/types';
import { ApiError, shop, type CheckoutResult } from '../api';
import { fmtEur } from '../format';

export function CheckoutView({
  cart,
  onBack,
  onPlaced,
  onCartInvalid,
}: {
  cart: Cart;
  onBack: () => void;
  onPlaced: (result: CheckoutResult) => void;
  onCartInvalid: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onPlaced(await shop.checkout({ name, email, address }));
    } catch (err) {
      if (err instanceof ApiError && err.items.length > 0) {
        // Stock moved under us — nothing was charged or decremented.
        setError(
          `Stock changed while you were shopping: ${err.items
            .map((i) => `${i.name} (only ${i.available} left)`)
            .join(', ')}. Your cart was not touched — please adjust it.`,
        );
        onCartInvalid();
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Checkout failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <button className="backlink mono" onClick={onBack}>← BACK TO CART</button>
      <div className="resource__head">
        <div>
          <p className="resource__eyebrow mono">CHECKOUT</p>
          <h1 className="resource__title">Where should it go?</h1>
          <p className="resource__desc">
            {cart.item_count} item(s) · {fmtEur(cart.totals.gross_cents)} incl. VAT. Payment on
            invoice — the order is placed as unpaid.
          </p>
        </div>
      </div>

      <form className="checkout" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span className="field__label mono">FULL NAME <span className="field__req">*</span></span>
          <input
            className="field__input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            autoFocus
          />
        </label>
        <label className="field">
          <span className="field__label mono">EMAIL <span className="field__req">*</span></span>
          <input
            className="field__input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>
        <label className="field">
          <span className="field__label mono">SHIPPING ADDRESS <span className="field__req">*</span></span>
          <textarea
            className="field__input"
            rows={4}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            autoComplete="street-address"
            placeholder={'Street and number\nPostal code, city\nCountry'}
          />
        </label>
        {error && <div className="resource__error mono">{error}</div>}
        <div className="cart__actions">
          <button className="btn btn--primary" type="submit" disabled={busy || cart.lines.length === 0}>
            {busy ? 'PLACING ORDER…' : `PLACE ORDER · ${fmtEur(cart.totals.gross_cents)}`}
          </button>
        </div>
        <p className="checkout__note mono">
          NO PAYMENT IS TAKEN HERE — SEE THE README FOR WHERE A PSP WOULD HOOK IN.
        </p>
      </form>
    </section>
  );
}
