import { useEffect, useState, type FormEvent } from 'react';
import type { FieldError, Product, Warehouse } from '../../shared/types';
import { api, ApiError } from '../api';

export type MovementMode = 'receipt' | 'adjustment' | 'transfer';

const TITLES: Record<MovementMode, string> = {
  receipt: 'Record receipt',
  adjustment: 'Record adjustment',
  transfer: 'Transfer stock',
};

interface Props {
  mode: MovementMode;
  warehouses: Warehouse[];
  /** Preselect this product (from a product detail page). */
  productId?: number;
  onClose: () => void;
  onDone: () => void;
  onAuthLost: () => void;
}

export function MovementModal({ mode, warehouses, productId, onClose, onDone, onAuthLost }: Props) {
  const [products, setProducts] = useState<Product[]>([]);
  const [product, setProduct] = useState(productId ? String(productId) : '');
  const [warehouse, setWarehouse] = useState(String(warehouses[0]?.id ?? ''));
  const [toWarehouse, setToWarehouse] = useState(String(warehouses[1]?.id ?? ''));
  const [quantityStr, setQuantityStr] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.products().then(
      ({ products: list }) => {
        setProducts(list);
        setProduct((current) => current || String(list[0]?.id ?? ''));
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onAuthLost();
        else setError('Failed to load products');
      },
    );
  }, [onAuthLost]);

  function fieldError(field: string): string | undefined {
    return fieldErrors.find((e) => e.field === field)?.message;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setFieldErrors([]);
    try {
      const quantity = Number(quantityStr);
      if (mode === 'transfer') {
        await api.createTransfer({
          product_id: Number(product),
          from_warehouse_id: Number(warehouse),
          to_warehouse_id: Number(toWarehouse),
          quantity,
          reference: reference || undefined,
          note: note || undefined,
        });
      } else {
        await api.createMovement({
          type: mode,
          product_id: Number(product),
          warehouse_id: Number(warehouse),
          quantity,
          reference: reference || undefined,
          note: note || undefined,
        });
      }
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.details);
      } else {
        setError('Request failed');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal">
      <div className="modal__backdrop" onClick={onClose} />
      <form className="modal__card" onSubmit={(e) => void submit(e)}>
        <div className="modal__eyebrow mono">LEDGER MOVEMENT</div>
        <h2 className="modal__title">{TITLES[mode]}</h2>
        {error && <div className="modal__error mono">{error}</div>}
        <div className="modal__fields">
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field__label mono">
              PRODUCT <span className="field__req">*</span>
            </span>
            <select
              className="field__input"
              value={product}
              onChange={(e) => setProduct(e.target.value)}
              disabled={productId !== undefined}
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} — {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label mono">
              {mode === 'transfer' ? 'FROM WAREHOUSE' : 'WAREHOUSE'} <span className="field__req">*</span>
            </span>
            <select className="field__input" value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} — {w.name}
                </option>
              ))}
            </select>
          </label>
          {mode === 'transfer' && (
            <label className="field">
              <span className="field__label mono">
                TO WAREHOUSE <span className="field__req">*</span>
              </span>
              <select
                className="field__input"
                value={toWarehouse}
                onChange={(e) => setToWarehouse(e.target.value)}
              >
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} — {w.name}
                  </option>
                ))}
              </select>
              {fieldError('to_warehouse_id') && (
                <span className="field__error mono">{fieldError('to_warehouse_id')}</span>
              )}
            </label>
          )}
          <label className="field">
            <span className="field__label mono">
              QUANTITY <span className="field__req">*</span>
              {mode === 'adjustment' ? ' (± ALLOWED)' : ''}
            </span>
            <input
              className="field__input"
              type="number"
              step="any"
              value={quantityStr}
              onChange={(e) => setQuantityStr(e.target.value)}
              required
            />
            {fieldError('quantity') && <span className="field__error mono">{fieldError('quantity')}</span>}
          </label>
          <label className="field">
            <span className="field__label mono">REFERENCE</span>
            <input
              className="field__input"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={mode === 'transfer' ? 'auto: TRF-…' : 'e.g. DN-2026-0400'}
            />
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field__label mono">
              NOTE {mode === 'adjustment' && <span className="field__req">* REQUIRED</span>}
            </span>
            <input
              className="field__input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={mode === 'adjustment' ? 'Why is the level being corrected?' : ''}
            />
            {fieldError('note') && <span className="field__error mono">{fieldError('note')}</span>}
          </label>
        </div>
        <div className="modal__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>
            CANCEL
          </button>
          <button className="btn btn--primary" type="submit" disabled={busy || products.length === 0}>
            {busy ? 'SAVING…' : 'SAVE →'}
          </button>
        </div>
      </form>
    </div>
  );
}
