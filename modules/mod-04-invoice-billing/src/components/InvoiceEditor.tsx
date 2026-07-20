import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { computeTotals, VAT_RATES, type LineAmounts } from '../../shared/money';
import type { FieldError } from '../../shared/types';
import { api, ApiError, type CustomerRow } from '../api';
import { centsToInput, fmtEur, parseEurToCents } from '../format';

interface Props {
  /** null → create a new draft; number → edit an existing draft. */
  id: number | null;
  onDone: (id: number | null) => void;
  onAuthLost: () => void;
}

interface EditableLine {
  description: string;
  quantity: string;
  unitPrice: string; // EUR text, e.g. "12,50"
  vatRate: string;
}

const EMPTY_LINE: EditableLine = { description: '', quantity: '1', unitPrice: '', vatRate: '20' };

function parsedLines(lines: EditableLine[]): LineAmounts[] {
  return lines.map((l) => ({
    quantity: Number(l.quantity.replace(',', '.')) || 0,
    unit_price_cents: parseEurToCents(l.unitPrice) ?? 0,
    vat_rate: Number(l.vatRate),
  }));
}

export function InvoiceEditor({ id, onDone, onAuthLost }: Props) {
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [terms, setTerms] = useState('14');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<EditableLine[]>([{ ...EMPTY_LINE }]);
  const [loaded, setLoaded] = useState(id === null);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { customers: list } = await api.customers();
      setCustomers(list);
      setCustomerId((c) => c || String(list[0]?.id ?? ''));
      if (id !== null) {
        const detail = await api.invoiceDetail(id);
        setCustomerId(String(detail.customer_id));
        setTerms(String(detail.payment_terms_days));
        setNote(detail.note ?? '');
        setLines(
          detail.lines.map((l) => ({
            description: l.description,
            quantity: String(l.quantity),
            unitPrice: centsToInput(l.unit_price_cents),
            vatRate: String(l.vat_rate),
          })),
        );
        setLoaded(true);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [id, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => computeTotals(parsedLines(lines)), [lines]);

  function setLine(i: number, patch: Partial<EditableLine>) {
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setFieldErrors([]);
    try {
      const payload = {
        customer_id: Number(customerId),
        payment_terms_days: Number(terms),
        note: note.trim() || null,
        lines: lines.map((l) => ({
          description: l.description,
          quantity: Number(l.quantity.replace(',', '.')),
          unit_price_cents: parseEurToCents(l.unitPrice) ?? -1,
          vat_rate: Number(l.vatRate),
        })),
      };
      const saved = id === null ? await api.createDraft(payload) : await api.updateDraft(id, payload);
      onDone(saved.id);
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

  if (!loaded && !error) return <div className="boot mono">LOADING…</div>;

  return (
    <div>
      <button className="backlink mono" onClick={() => onDone(id)}>
        ← BACK
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.01 · BILLING</div>
          <h1 className="resource__title">{id === null ? 'New draft' : `Edit draft #${id}`}</h1>
          <p className="resource__desc">Drafts have no number — one is assigned when you send.</p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}
      {fieldErrors.length > 0 && (
        <div className="resource__error mono">
          {fieldErrors.map((e) => `${e.field}: ${e.message}`).join(' · ')}
        </div>
      )}

      <form className="editor" onSubmit={(e) => void submit(e)}>
        <div className="editor__meta">
          <label className="field">
            <span className="field__label mono">
              CUSTOMER <span className="field__req">*</span>
            </span>
            <select className="field__input" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label mono">PAYMENT TERMS (DAYS)</span>
            <input
              className="field__input"
              type="number"
              min="0"
              max="365"
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
            />
          </label>
          <label className="field editor__note">
            <span className="field__label mono">NOTE</span>
            <input className="field__input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>

        <div className="section-title mono">LINE ITEMS</div>
        {lines.map((line, i) => (
          <div key={i} className="inv-line">
            <label className="field">
              <span className="field__label mono">
                {i + 1} · DESCRIPTION <span className="field__req">*</span>
              </span>
              <input
                className="field__input"
                value={line.description}
                onChange={(e) => setLine(i, { description: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label mono">QTY</span>
              <input
                className="field__input"
                type="number"
                step="any"
                min="0"
                value={line.quantity}
                onChange={(e) => setLine(i, { quantity: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label mono">UNIT PRICE €</span>
              <input
                className="field__input"
                placeholder="0,00"
                value={line.unitPrice}
                onChange={(e) => setLine(i, { unitPrice: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label mono">VAT</span>
              <select className="field__input" value={line.vatRate} onChange={(e) => setLine(i, { vatRate: e.target.value })}>
                {VAT_RATES.map((r) => (
                  <option key={r} value={r}>
                    {r}%
                  </option>
                ))}
              </select>
            </label>
            <button
              className="rowbtn rowbtn--danger mono inv-line__remove"
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
          onClick={() => setLines([...lines, { ...EMPTY_LINE }])}
        >
          + ADD LINE
        </button>

        <div className="totals">
          <div className="totals__row mono">
            <span>NET</span>
            <span className="table__num">{fmtEur(totals.net_cents)}</span>
          </div>
          {totals.by_rate
            .filter((r) => r.rate > 0)
            .map((r) => (
              <div key={r.rate} className="totals__row mono">
                <span>
                  VAT {r.rate}% OF {fmtEur(r.base_cents)}
                </span>
                <span className="table__num">{fmtEur(r.vat_cents)}</span>
              </div>
            ))}
          <div className="totals__row totals__row--gross mono">
            <span>GROSS</span>
            <span className="table__num">{fmtEur(totals.gross_cents)}</span>
          </div>
        </div>

        <div className="editor__actions">
          <button className="btn btn--ghost" type="button" onClick={() => onDone(id)}>
            CANCEL
          </button>
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? 'SAVING…' : id === null ? 'CREATE DRAFT →' : 'SAVE DRAFT →'}
          </button>
        </div>
      </form>
    </div>
  );
}
