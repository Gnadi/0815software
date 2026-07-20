import { useEffect, useState } from 'react';
import type { Cart, ShopProduct } from '../../shared/types';
import { ApiError, shop } from '../api';
import { fmtEur } from '../format';
import { ProductMark } from './ProductMark';

export function ProductView({
  id,
  cart,
  onCartChange,
  onBack,
  onGoToCart,
}: {
  id: number;
  cart: Cart;
  onCartChange: (cart: Cart) => void;
  onBack: () => void;
  onGoToCart: () => void;
}) {
  const [product, setProduct] = useState<ShopProduct | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState('');
  const [added, setAdded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    shop
      .product(id)
      .then(setProduct)
      .catch(() => setError('Product not found'));
  }, [id]);

  if (!product) {
    return (
      <section>
        <button className="backlink mono" onClick={onBack}>← BACK TO CATALOGUE</button>
        {error && <div className="resource__error mono">{error}</div>}
      </section>
    );
  }

  const inCart = cart.lines.find((l) => l.product_id === product.id)?.quantity ?? 0;

  async function add() {
    if (!product) return;
    setBusy(true);
    setError('');
    setAdded(false);
    try {
      onCartChange(await shop.addToCart(product.id, quantity));
      setAdded(true);
    } catch (err) {
      if (err instanceof ApiError && err.items.length > 0) {
        const item = err.items[0]!;
        setError(`Only ${item.available} available — you already have ${inCart} in the cart`);
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not add to cart');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <button className="backlink mono" onClick={onBack}>← BACK TO CATALOGUE</button>
      <div className="product">
        <ProductMark name={product.name} accent={product.accent} size="hero" />
        <div className="product__info">
          <p className="resource__eyebrow mono">
            {product.category_name.toUpperCase()} · {product.sku}
          </p>
          <h1 className="resource__title">{product.name}</h1>
          <p className="product__desc">{product.description}</p>
          <div className="product__price mono">
            {fmtEur(product.unit_price_cents)}
            <span className="product__vat"> incl. {product.vat_rate}% VAT</span>
          </div>
          <div className="product__stock mono">
            {product.stock === 0
              ? 'OUT OF STOCK'
              : `${product.stock} IN STOCK${inCart > 0 ? ` · ${inCart} IN YOUR CART` : ''}`}
          </div>
          {product.stock > 0 && (
            <div className="product__buy">
              <input
                className="field__input product__qty"
                type="number"
                min={1}
                max={product.stock}
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Math.floor(Number(e.target.value)) || 1))}
              />
              <button className="btn btn--primary" onClick={() => void add()} disabled={busy}>
                {busy ? 'ADDING…' : 'ADD TO CART →'}
              </button>
            </div>
          )}
          {error && <div className="resource__error mono">{error}</div>}
          {added && !error && (
            <div className="product__added mono">
              ADDED.{' '}
              <button className="linklike" onClick={onGoToCart}>
                GO TO CART →
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
