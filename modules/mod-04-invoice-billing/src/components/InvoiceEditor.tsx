import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { EXEMPTION_DEFAULT_REASON } from '../../shared/einvoice';
import { computeTotals, LINE_ROUNDING, VAT_RATES, vatRatesFor, type LineAmounts } from '../../shared/money';
import { TAX_EXEMPTION_CATEGORIES, type FieldError, type TaxExemptionCategory } from '../../shared/types';
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

/** What each VAT category of the 0 % lines means, in the words an invoice uses. */
const CATEGORY_LABEL: Record<TaxExemptionCategory, string> = {
  E: 'Exempt (steuerfrei) — state the legal ground',
  AE: 'Reverse charge (Steuerschuldnerschaft des Leistungsempfängers)',
  K: 'Intra-EU supply of goods (innergemeinschaftliche Lieferung)',
  G: 'Export outside the EU (Ausfuhrlieferung)',
  Z: 'Zero-rated (Nullsatz)',
  O: 'Not subject to VAT (nicht steuerbar)',
};

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
  const [buyerReference, setBuyerReference] = useState('');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [exemption, setExemption] = useState('');
  const [exemptionReason, setExemptionReason] = useState('');
  // The rates the seller's country charges; all of them until it is known.
  const [rates, setRates] = useState<readonly number[]>(VAT_RATES);
  const [loaded, setLoaded] = useState(id === null);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { customers: list } = await api.customers();
      setCustomers(list);
      const config = await api.einvoiceConfig().catch(() => null);
      const sellerRates = config?.seller.country ? vatRatesFor(config.seller.country) : VAT_RATES;
      setRates(sellerRates);
      if (id === null) {
        const standard = Math.max(...sellerRates);
        setLines((prev) => prev.map((l) => (l.description === '' && l.unitPrice === '' ? { ...l, vatRate: String(standard) } : l)));
      }
      setCustomerId((c) => c || String(list[0]?.id ?? ''));
      if (id !== null) {
        const detail = await api.invoiceDetail(id);
        setCustomerId(String(detail.customer_id));
        setTerms(String(detail.payment_terms_days));
        setNote(detail.note ?? '');
        setBuyerReference(detail.buyer_reference ?? '');
        setDeliveryDate(detail.delivery_date ?? '');
        setPeriodStart(detail.period_start ?? '');
        setPeriodEnd(detail.period_end ?? '');
        setExemption(detail.tax_exemption_category ?? '');
        setExemptionReason(detail.tax_exemption_reason ?? '');
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

  const totals = useMemo(() => computeTotals(parsedLines(lines), LINE_ROUNDING), [lines]);

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
        buyer_reference: buyerReference.trim() || null,
        delivery_date: deliveryDate || null,
        period_start: periodStart || null,
        period_end: periodEnd || null,
        tax_exemption_category: exemption || null,
        tax_exemption_reason: exemptionReason.trim() || null,
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
          <label className="field">
            <span className="field__label mono">SERVICE DATE</span>
            <input
              className="field__input"
              type="date"
              value={deliveryDate}
              title="Leistungsdatum — empty means the issue date, or the service period when there is one"
              onChange={(e) => setDeliveryDate(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label mono">SERVICE PERIOD FROM</span>
            <input
              className="field__input"
              type="date"
              value={periodStart}
              title="Leistungszeitraum — a monthly fee, a maintenance contract: the first day billed"
              onChange={(e) => setPeriodStart(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label mono">SERVICE PERIOD TO</span>
            <input
              className="field__input"
              type="date"
              value={periodEnd}
              title="Leistungszeitraum — the last day billed, inclusive"
              onChange={(e) => setPeriodEnd(e.target.value)}
            />
          </label>
          <label className="field editor__note">
            <span className="field__label mono">BUYER REFERENCE · LEITWEG-ID</span>
            <input
              className="field__input"
              value={buyerReference}
              placeholder="Empty → the customer's default"
              onChange={(e) => setBuyerReference(e.target.value)}
            />
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
                {(rates.includes(Number(line.vatRate)) ? rates : [...rates, Number(line.vatRate)]).map((r) => (
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
          onClick={() => setLines([...lines, { ...EMPTY_LINE, vatRate: String(Math.max(...rates)) }])}
        >
          + ADD LINE
        </button>

        {lines.some((l) => Number(l.vatRate) === 0) && (
          <div className="editor__meta">
            <label className="field editor__note">
              <span className="field__label mono">
                WHY 0 % VAT <span className="field__req">*</span>
              </span>
              <select className="field__input" value={exemption} onChange={(e) => setExemption(e.target.value)}>
                <option value="">— choose (required for an e-invoice) —</option>
                {TAX_EXEMPTION_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c} · {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field editor__note">
              <span className="field__label mono">EXEMPTION TEXT ON THE INVOICE</span>
              <input
                className="field__input"
                value={exemptionReason}
                placeholder={
                  (exemption && EXEMPTION_DEFAULT_REASON[exemption as TaxExemptionCategory]) ||
                  'e.g. Steuerfrei nach § 4 Nr. 14 UStG'
                }
                onChange={(e) => setExemptionReason(e.target.value)}
              />
            </label>
          </div>
        )}

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
