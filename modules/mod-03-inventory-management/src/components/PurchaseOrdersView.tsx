import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { FieldError, Product, Supplier } from '../../shared/types';
import { api, ApiError, type PoListRow } from '../api';
import { fmtDate, fmtQty } from '../format';
import { StatusBadge } from './StatusBadge';

interface Props {
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}

interface DraftLine {
  product_id: string;
  quantity: string;
}

export function PurchaseOrdersView({ onOpen, onAuthLost }: Props) {
  const [rows, setRows] = useState<PoListRow[] | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [creating, setCreating] = useState(false);
  const [supplier, setSupplier] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ product_id: '', quantity: '' }]);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ purchase_orders }, { suppliers: sups }, { products: prods }] = await Promise.all([
        api.purchaseOrders(),
        api.suppliers(),
        api.products(),
      ]);
      setRows(purchase_orders);
      setSuppliers(sups);
      setProducts(prods);
      setSupplier((s) => s || String(sups[0]?.id ?? ''));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load purchase orders');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError('');
    setFieldErrors([]);
    try {
      const created = await api.createPurchaseOrder({
        supplier_id: Number(supplier),
        lines: lines
          .filter((l) => l.product_id !== '' && l.quantity !== '')
          .map((l) => ({ product_id: Number(l.product_id), quantity: Number(l.quantity) })),
      });
      setCreating(false);
      setLines([{ product_id: '', quantity: '' }]);
      onOpen(created.id);
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

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.03 · PURCHASING</div>
          <h1 className="resource__title">Purchase orders</h1>
          <p className="resource__desc">draft → ordered → partially received → received.</p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--primary" onClick={() => setCreating(true)}>
            + NEW PO
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">PO NO.</th>
              <th className="mono">SUPPLIER</th>
              <th className="mono">STATUS</th>
              <th className="mono">LINES</th>
              <th className="mono">ORDERED</th>
              <th className="mono">RECEIVED</th>
              <th className="mono">CREATED</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((po) => (
              <tr key={po.id} onClick={() => onOpen(po.id)}>
                <td className="mono">
                  <button className="linklike mono" onClick={() => onOpen(po.id)}>
                    {po.po_number}
                  </button>
                </td>
                <td>{po.supplier_name}</td>
                <td>
                  <StatusBadge status={po.status} />
                </td>
                <td className="table__num mono">{po.line_count}</td>
                <td className="table__num mono">{fmtQty(po.qty_ordered)}</td>
                <td className="table__num mono">{fmtQty(po.qty_received)}</td>
                <td className="mono table__id">{fmtDate(po.created_at)}</td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={7}>
                  NO PURCHASE ORDERS YET
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {creating && (
        <div className="modal">
          <div className="modal__backdrop" onClick={() => setCreating(false)} />
          <form className="modal__card" onSubmit={(e) => void submit(e)}>
            <div className="modal__eyebrow mono">NEW PURCHASE ORDER</div>
            <h2 className="modal__title">Draft PO</h2>
            {formError && <div className="modal__error mono">{formError}</div>}
            {fieldErrors.length > 0 && (
              <div className="modal__error mono">
                {fieldErrors.map((e) => `${e.field}: ${e.message}`).join(' · ')}
              </div>
            )}
            <div className="modal__fields">
              <label className="field" style={{ gridColumn: '1 / -1' }}>
                <span className="field__label mono">
                  SUPPLIER <span className="field__req">*</span>
                </span>
                <select className="field__input" value={supplier} onChange={(e) => setSupplier(e.target.value)}>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              {lines.map((line, i) => (
                <div key={i} className="po-line" style={{ gridColumn: '1 / -1' }}>
                  <label className="field po-line__product">
                    <span className="field__label mono">LINE {i + 1} · PRODUCT</span>
                    <select
                      className="field__input"
                      value={line.product_id}
                      onChange={(e) => {
                        const next = [...lines];
                        next[i] = { ...line, product_id: e.target.value };
                        setLines(next);
                      }}
                    >
                      <option value="">— select —</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.sku} — {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field po-line__qty">
                    <span className="field__label mono">QTY</span>
                    <input
                      className="field__input"
                      type="number"
                      step="any"
                      min="0"
                      value={line.quantity}
                      onChange={(e) => {
                        const next = [...lines];
                        next[i] = { ...line, quantity: e.target.value };
                        setLines(next);
                      }}
                    />
                  </label>
                  <button
                    className="rowbtn rowbtn--danger mono po-line__remove"
                    type="button"
                    disabled={lines.length === 1}
                    onClick={() => setLines(lines.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                className="toolbar__clear mono"
                type="button"
                style={{ justifySelf: 'start' }}
                onClick={() => setLines([...lines, { product_id: '', quantity: '' }])}
              >
                + ADD LINE
              </button>
            </div>
            <div className="modal__actions">
              <button className="btn btn--ghost" type="button" onClick={() => setCreating(false)}>
                CANCEL
              </button>
              <button className="btn btn--primary" type="submit" disabled={busy}>
                {busy ? 'SAVING…' : 'CREATE DRAFT →'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
