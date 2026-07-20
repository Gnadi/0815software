import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { UNITS, type FieldError, type StockRow } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtQty } from '../format';

interface Props {
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}

interface FormState {
  id?: number;
  sku: string;
  name: string;
  unit: string;
  reorder_point: string;
}

const EMPTY: FormState = { sku: '', name: '', unit: 'pcs', reorder_point: '0' };

export function ProductsView({ onOpen, onAuthLost }: Props) {
  const [rows, setRows] = useState<StockRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams();
      if (search.trim()) p.set('search', search.trim());
      const { rows: data } = await api.stock(p);
      setRows(data);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load products');
    }
  }, [search, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  function fieldError(field: string): string | undefined {
    return fieldErrors.find((e) => e.field === field)?.message;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setFormError('');
    setFieldErrors([]);
    const values = {
      sku: form.sku,
      name: form.name,
      unit: form.unit,
      reorder_point: form.reorder_point === '' ? 0 : Number(form.reorder_point),
    };
    try {
      if (form.id === undefined) await api.createProduct(values);
      else await api.updateProduct(form.id, values);
      setForm(null);
      void load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      if (err instanceof ApiError) {
        setFormError(err.message);
        setFieldErrors(err.details);
      } else {
        setFormError('Request failed');
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: StockRow) {
    if (!window.confirm(`Delete product ${row.sku}? Only possible without ledger history.`)) return;
    try {
      await api.deleteProduct(row.id);
      void load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.02 · PRODUCTS</div>
          <h1 className="resource__title">Products</h1>
          <p className="resource__desc">SKUs, units and reorder points. Levels come from the ledger.</p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--primary" onClick={() => setForm(EMPTY)}>
            + ADD PRODUCT
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <input
          className="field__input toolbar__search"
          placeholder="Search SKU or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="toolbar__count mono">{rows ? `${rows.length} PRODUCTS` : '…'}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">SKU</th>
              <th className="mono">NAME</th>
              <th className="mono">UNIT</th>
              <th className="mono">REORDER PT</th>
              <th className="mono">TOTAL STOCK</th>
              <th className="mono"></th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((row) => (
              <tr key={row.id} className={row.low ? 'is-low' : ''}>
                <td className="mono">
                  <button className="linklike mono" onClick={() => onOpen(row.id)}>
                    {row.sku}
                  </button>
                </td>
                <td>
                  {row.name}
                  {row.low && <span className="lowflag mono">LOW</span>}
                </td>
                <td className="mono table__id">{row.unit}</td>
                <td className="table__num mono">{fmtQty(row.reorder_point)}</td>
                <td className="table__num mono">{fmtQty(row.total)}</td>
                <td>
                  <div className="table__rowactions">
                    <button className="rowbtn mono" onClick={() => onOpen(row.id)}>
                      HISTORY
                    </button>
                    <button
                      className="rowbtn mono"
                      onClick={() =>
                        setForm({
                          id: row.id,
                          sku: row.sku,
                          name: row.name,
                          unit: row.unit,
                          reorder_point: String(row.reorder_point),
                        })
                      }
                    >
                      EDIT
                    </button>
                    <button className="rowbtn rowbtn--danger mono" onClick={() => void remove(row)}>
                      DELETE
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={6}>
                  NO PRODUCTS MATCH
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {form && (
        <div className="modal">
          <div className="modal__backdrop" onClick={() => setForm(null)} />
          <form className="modal__card" onSubmit={(e) => void submit(e)}>
            <div className="modal__eyebrow mono">{form.id === undefined ? 'NEW PRODUCT' : 'EDIT PRODUCT'}</div>
            <h2 className="modal__title">{form.id === undefined ? 'Add product' : form.sku}</h2>
            {formError && <div className="modal__error mono">{formError}</div>}
            <div className="modal__fields">
              <label className="field">
                <span className="field__label mono">
                  SKU <span className="field__req">*</span>
                </span>
                <input
                  className="field__input mono"
                  value={form.sku}
                  onChange={(e) => setForm({ ...form, sku: e.target.value.toUpperCase() })}
                  placeholder="HW-1004"
                  autoFocus
                />
                {fieldError('sku') && <span className="field__error mono">{fieldError('sku')}</span>}
              </label>
              <label className="field">
                <span className="field__label mono">UNIT</span>
                <select
                  className="field__input"
                  value={form.unit}
                  onChange={(e) => setForm({ ...form, unit: e.target.value })}
                >
                  {UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ gridColumn: '1 / -1' }}>
                <span className="field__label mono">
                  NAME <span className="field__req">*</span>
                </span>
                <input
                  className="field__input"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
                {fieldError('name') && <span className="field__error mono">{fieldError('name')}</span>}
              </label>
              <label className="field">
                <span className="field__label mono">REORDER POINT</span>
                <input
                  className="field__input"
                  type="number"
                  step="any"
                  min="0"
                  value={form.reorder_point}
                  onChange={(e) => setForm({ ...form, reorder_point: e.target.value })}
                />
                {fieldError('reorder_point') && (
                  <span className="field__error mono">{fieldError('reorder_point')}</span>
                )}
              </label>
            </div>
            <div className="modal__actions">
              <button className="btn btn--ghost" type="button" onClick={() => setForm(null)}>
                CANCEL
              </button>
              <button className="btn btn--primary" type="submit" disabled={busy}>
                {busy ? 'SAVING…' : 'SAVE →'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
