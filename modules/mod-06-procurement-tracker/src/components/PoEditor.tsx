import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { computeTotalCents } from '../../shared/money';
import type { AppConfig, SupplierRow } from '../../shared/types';
import { api, ApiError } from '../api';
import { centsToInput, fmtEur, parseEurToCents } from '../format';
import { ApprovalRules } from './ApprovalRules';

interface Props {
  id: number | null;
  config: AppConfig;
  onDone: (id: number | null) => void;
  onAuthLost: () => void;
}

interface LineForm {
  description: string;
  quantity: string;
  unit: string;
  price: string;
}

const EMPTY_LINE: LineForm = { description: '', quantity: '1', unit: 'pc', price: '' };

export function PoEditor({ id, config, onDone, onAuthLost }: Props) {
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<LineForm[]>([{ ...EMPTY_LINE }]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const { suppliers: all } = await api.suppliers();
      setSuppliers(all);
      if (id !== null) {
        const po = await api.poDetail(id);
        setSupplierId(String(po.supplier_id));
        setNote(po.note ?? '');
        setLines(
          po.lines.map((l) => ({
            description: l.description,
            quantity: String(l.quantity),
            unit: l.unit,
            price: centsToInput(l.unit_price_cents),
          })),
        );
      }
      setLoaded(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [id, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live preview: same shared money code as the server; the tiers the
  // total WOULD need come from the fetched config, not a copy.
  const totalCents = useMemo(
    () =>
      computeTotalCents(
        lines.map((l) => ({
          quantity: Number(l.quantity.replace(',', '.')) || 0,
          unit_price_cents: parseEurToCents(l.price) ?? 0,
        })),
      ),
    [lines],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const values = {
        supplier_id: Number(supplierId),
        note: note.trim() || null,
        lines: lines.map((l) => ({
          description: l.description,
          quantity: Number(l.quantity.replace(',', '.')),
          unit: l.unit,
          unit_price_cents: parseEurToCents(l.price) ?? -1,
        })),
      };
      const po = id === null ? await api.createPo(values) : await api.updatePo(id, values);
      onDone(po.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      setError(
        err instanceof ApiError
          ? [err.message, ...err.details.map((d) => `${d.field}: ${d.message}`)].join(' · ')
          : 'Request failed',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <div className="boot mono">LOADING…</div>;

  return (
    <div>
      <button className="backlink mono" onClick={() => onDone(id)}>
        ← BACK
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ PRC.02 · ORDERING</div>
          <h1 className="resource__title">{id === null ? 'New purchase order' : 'Edit draft'}</h1>
          <p className="resource__desc">Drafts only — submitting freezes the lines and derives the approval tiers.</p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <form className="editor" onSubmit={(e) => void submit(e)}>
        <div className="editor__meta">
          <label className="field">
            <span className="field__label mono">
              SUPPLIER <span className="field__req">*</span>
            </span>
            <select className="field__input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">— choose —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <div />
          <label className="field">
            <span className="field__label mono">NOTE</span>
            <input className="field__input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>

        <div className="section-title mono">LINES · NET PRICES</div>
        {lines.map((line, i) => (
          <div key={i} className="line-row">
            <label className="field">
              <span className="field__label mono">
                DESCRIPTION <span className="field__req">*</span>
              </span>
              <input
                className="field__input"
                value={line.description}
                onChange={(e) => setLines(lines.map((l, j) => (j === i ? { ...l, description: e.target.value } : l)))}
              />
            </label>
            <label className="field">
              <span className="field__label mono">QTY</span>
              <input
                className="field__input"
                value={line.quantity}
                onChange={(e) => setLines(lines.map((l, j) => (j === i ? { ...l, quantity: e.target.value } : l)))}
              />
            </label>
            <label className="field">
              <span className="field__label mono">UNIT</span>
              <input
                className="field__input"
                value={line.unit}
                onChange={(e) => setLines(lines.map((l, j) => (j === i ? { ...l, unit: e.target.value } : l)))}
              />
            </label>
            <label className="field">
              <span className="field__label mono">UNIT PRICE €</span>
              <input
                className="field__input"
                placeholder="0,00"
                value={line.price}
                onChange={(e) => setLines(lines.map((l, j) => (j === i ? { ...l, price: e.target.value } : l)))}
              />
            </label>
            <button
              className="rowbtn rowbtn--danger mono line-row__remove"
              type="button"
              disabled={lines.length === 1}
              onClick={() => setLines(lines.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}
        <button className="editor__addline mono" type="button" onClick={() => setLines([...lines, { ...EMPTY_LINE }])}>
          + ADD LINE
        </button>

        <div className="totals">
          <div className="totals__row totals__row--gross mono">
            <span>TOTAL (NET)</span>
            <span className="table__num">{fmtEur(totalCents)}</span>
          </div>
        </div>

        <div className="section-title mono">APPROVAL BRACKETS (SERVER CONFIG)</div>
        <ApprovalRules config={config} activeTotalCents={totalCents} />

        <div className="editor__actions">
          <button className="btn btn--ghost" type="button" onClick={() => onDone(id)}>
            CANCEL
          </button>
          <button className="btn btn--primary" type="submit" disabled={busy || !supplierId}>
            {busy ? 'SAVING…' : 'SAVE DRAFT →'}
          </button>
        </div>
      </form>
    </div>
  );
}
