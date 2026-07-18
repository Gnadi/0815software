import { useEffect, useState } from 'react';
import type { ShopProduct } from '../../shared/types';
import { shop, type ShopCategory } from '../api';
import { fmtEur } from '../format';
import { ProductMark } from './ProductMark';

export function Catalogue({ onOpen }: { onOpen: (id: number) => void }) {
  const [categories, setCategories] = useState<ShopCategory[]>([]);
  const [products, setProducts] = useState<ShopProduct[]>([]);
  const [category, setCategory] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    shop
      .categories()
      .then((res) => setCategories(res.categories))
      .catch(() => setError('Could not load categories'));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (category !== null) params.set('category', String(category));
    if (search.trim()) params.set('search', search.trim());
    const timer = setTimeout(() => {
      shop
        .products(params)
        .then((res) => {
          setProducts(res.products);
          setError('');
        })
        .catch(() => setError('Could not load products'));
    }, 150);
    return () => clearTimeout(timer);
  }, [category, search]);

  return (
    <section>
      <div className="resource__head">
        <div>
          <p className="resource__eyebrow mono">CATALOGUE</p>
          <h1 className="resource__title">Everything in stock.</h1>
          <p className="resource__desc">Gross prices, VAT included. No account needed until you say so — never.</p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <div className="chips">
          <button
            className={`chip mono ${category === null ? 'is-active' : ''}`}
            onClick={() => setCategory(null)}
          >
            ALL
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              className={`chip mono ${category === c.id ? 'is-active' : ''}`}
              onClick={() => setCategory(category === c.id ? null : c.id)}
            >
              {c.name.toUpperCase()} · {c.product_count}
            </button>
          ))}
        </div>
        <input
          className="field__input toolbar__search"
          placeholder="Search products…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="toolbar__count mono">{products.length} PRODUCTS</span>
      </div>

      <div className="productgrid">
        {products.map((p) => (
          <button key={p.id} className="card" onClick={() => onOpen(p.id)}>
            <ProductMark name={p.name} accent={p.accent} size="card" />
            <div className="card__body">
              <span className="card__cat mono">{p.category_name.toUpperCase()}</span>
              <span className="card__name">{p.name}</span>
              <div className="card__meta">
                <span className="card__price mono">{fmtEur(p.unit_price_cents)}</span>
                {p.stock === 0 ? (
                  <span className="badge mono badge--out">OUT OF STOCK</span>
                ) : p.stock <= 5 ? (
                  <span className="badge mono badge--low">ONLY {p.stock} LEFT</span>
                ) : null}
              </div>
            </div>
          </button>
        ))}
        {products.length === 0 && !error && (
          <p className="table__empty mono">NOTHING MATCHES — TRY ANOTHER SEARCH</p>
        )}
      </div>
    </section>
  );
}
