import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { VAT_RATES } from '../../shared/money';
import { admin, ApiError, type AdminCategory, type AdminProduct } from '../api';
import { centsToInput, fmtEur, parseEurToCents } from '../format';
import { ProductMark } from './ProductMark';

interface EditorState {
  id: number | null;
  sku: string;
  name: string;
  description: string;
  price: string;
  vat_rate: number;
  stock: string;
  category_id: number | '';
  accent: string;
  archived: boolean;
}

const EMPTY: EditorState = {
  id: null,
  sku: '',
  name: '',
  description: '',
  price: '',
  vat_rate: 20,
  stock: '0',
  category_id: '',
  accent: '',
  archived: false,
};

export function ProductsAdmin({ onAuthLost }: { onAuthLost: () => void }) {
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState('');
  const [busy, setBusy] = useState(false);

  const guard = useCallback(
    (err: unknown, fallback: string): string => {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return '';
      }
      return err instanceof ApiError ? err.message : fallback;
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      const [prods, cats] = await Promise.all([admin.products(params), admin.categories()]);
      setProducts(prods.products);
      setCategories(cats.categories);
      setError('');
    } catch (err) {
      setError(guard(err, 'Could not load products'));
    }
  }, [search, guard]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 150);
    return () => clearTimeout(timer);
  }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    const price = parseEurToCents(editor.price);
    if (price === null) {
      setEditorError('Price must be a plain amount like 12,90');
      return;
    }
    setBusy(true);
    setEditorError('');
    const values = {
      sku: editor.sku,
      name: editor.name,
      description: editor.description,
      unit_price_cents: price,
      vat_rate: editor.vat_rate,
      stock: Number(editor.stock),
      category_id: editor.category_id,
      accent: editor.accent || null,
      archived: editor.archived,
    };
    try {
      if (editor.id === null) await admin.createProduct(values);
      else await admin.updateProduct(editor.id, values);
      setEditor(null);
      await load();
    } catch (err) {
      setEditorError(guard(err, 'Could not save the product'));
    } finally {
      setBusy(false);
    }
  }

  async function adjustStock(product: AdminProduct) {
    const raw = window.prompt(`Stock delta for ${product.sku} (current ${product.stock}, e.g. +10 or -3):`);
    if (raw === null) return;
    const delta = Number(raw);
    if (!Number.isInteger(delta) || delta === 0) return;
    try {
      await admin.adjustStock(product.id, delta);
      await load();
    } catch (err) {
      setError(guard(err, 'Could not adjust stock'));
    }
  }

  async function remove(product: AdminProduct) {
    if (!window.confirm(`Delete ${product.sku} — ${product.name}?`)) return;
    try {
      await admin.deleteProduct(product.id);
      await load();
    } catch (err) {
      setError(guard(err, 'Could not delete the product'));
    }
  }

  function openEditor(product: AdminProduct | null) {
    setEditorError('');
    setEditor(
      product
        ? {
            id: product.id,
            sku: product.sku,
            name: product.name,
            description: product.description,
            price: centsToInput(product.unit_price_cents),
            vat_rate: product.vat_rate,
            stock: String(product.stock),
            category_id: product.category_id,
            accent: product.accent ?? '',
            archived: product.archived === 1,
          }
        : { ...EMPTY, category_id: categories[0]?.id ?? '' },
    );
  }

  return (
    <section>
      <div className="resource__head">
        <div>
          <p className="resource__eyebrow mono">PRODUCTS</p>
          <h1 className="resource__title">Products</h1>
          <p className="resource__desc">
            Prices are gross (VAT included). Editing a price never touches existing orders.
          </p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--primary" onClick={() => openEditor(null)}>
            NEW PRODUCT +
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <input
          className="field__input toolbar__search"
          placeholder="Search SKU / name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="toolbar__count mono">{products.length} PRODUCTS</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono" />
              <th className="mono">SKU</th>
              <th className="mono">NAME</th>
              <th className="mono">CATEGORY</th>
              <th className="mono">PRICE</th>
              <th className="mono">VAT</th>
              <th className="mono">STOCK</th>
              <th className="mono">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td>
                  <ProductMark name={p.name} accent={p.accent} size="thumb" />
                </td>
                <td className="table__id mono">{p.sku}</td>
                <td>
                  {p.name}
                  {p.archived === 1 && <span className="badge mono badge--cancelled"> ARCHIVED</span>}
                </td>
                <td className="table__id">{p.category_name}</td>
                <td className="table__num mono">{fmtEur(p.unit_price_cents)}</td>
                <td className="table__num mono">{p.vat_rate}%</td>
                <td className={`table__num mono ${p.stock === 0 ? 'qty-neg' : ''}`}>{p.stock}</td>
                <td>
                  <div className="table__rowactions">
                    <button className="rowbtn mono" onClick={() => openEditor(p)}>EDIT</button>
                    <button className="rowbtn mono" onClick={() => void adjustStock(p)}>STOCK ±</button>
                    <button
                      className="rowbtn rowbtn--danger mono"
                      onClick={() => void remove(p)}
                      disabled={p.order_line_count > 0}
                      title={p.order_line_count > 0 ? 'Referenced by orders — archive instead' : undefined}
                    >
                      DELETE
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {products.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={8}>NO PRODUCTS</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editor && (
        <div className="modal">
          <div className="modal__backdrop" onClick={() => setEditor(null)} />
          <form className="modal__card" onSubmit={(e) => void save(e)}>
            <p className="modal__eyebrow mono">{editor.id === null ? 'NEW PRODUCT' : 'EDIT PRODUCT'}</p>
            <h2 className="modal__title">{editor.id === null ? 'Add a product' : editor.name}</h2>
            <div className="modal__fields">
              <label className="field">
                <span className="field__label mono">SKU <span className="field__req">*</span></span>
                <input
                  className="field__input mono"
                  value={editor.sku}
                  onChange={(e) => setEditor({ ...editor, sku: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field__label mono">NAME <span className="field__req">*</span></span>
                <input
                  className="field__input"
                  value={editor.name}
                  onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field__label mono">GROSS PRICE € <span className="field__req">*</span></span>
                <input
                  className="field__input mono"
                  value={editor.price}
                  onChange={(e) => setEditor({ ...editor, price: e.target.value })}
                  placeholder="12,90"
                />
              </label>
              <label className="field">
                <span className="field__label mono">VAT RATE</span>
                <select
                  className="field__input"
                  value={editor.vat_rate}
                  onChange={(e) => setEditor({ ...editor, vat_rate: Number(e.target.value) })}
                >
                  {VAT_RATES.map((r) => (
                    <option key={r} value={r}>{r}%</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field__label mono">STOCK</span>
                <input
                  className="field__input mono"
                  type="number"
                  min={0}
                  value={editor.stock}
                  onChange={(e) => setEditor({ ...editor, stock: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field__label mono">CATEGORY <span className="field__req">*</span></span>
                <select
                  className="field__input"
                  value={editor.category_id}
                  onChange={(e) => setEditor({ ...editor, category_id: Number(e.target.value) })}
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field__label mono">ACCENT (HEX, FOR THE PLACEHOLDER MARK)</span>
                <input
                  className="field__input mono"
                  value={editor.accent}
                  onChange={(e) => setEditor({ ...editor, accent: e.target.value })}
                  placeholder="#7A9E8F"
                />
              </label>
              <label className="field">
                <span className="field__label mono">ARCHIVED (HIDDEN FROM SHOP)</span>
                <select
                  className="field__input"
                  value={editor.archived ? '1' : '0'}
                  onChange={(e) => setEditor({ ...editor, archived: e.target.value === '1' })}
                >
                  <option value="0">No — visible in the shop</option>
                  <option value="1">Yes — archived</option>
                </select>
              </label>
            </div>
            <label className="field" style={{ marginBottom: 24 }}>
              <span className="field__label mono">DESCRIPTION</span>
              <textarea
                className="field__input"
                rows={3}
                value={editor.description}
                onChange={(e) => setEditor({ ...editor, description: e.target.value })}
              />
            </label>
            {editorError && <div className="modal__error mono">{editorError}</div>}
            <div className="modal__actions">
              <button className="btn btn--ghost" type="button" onClick={() => setEditor(null)}>
                CANCEL
              </button>
              <button className="btn btn--primary" type="submit" disabled={busy}>
                {busy ? 'SAVING…' : 'SAVE'}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
