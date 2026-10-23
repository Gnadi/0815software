import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { computeTotals, LINE_ROUNDING, VAT_RATES, vatRatesFor } from '../../shared/money';
import {
  RECURRING_INTERVALS,
  TAX_EXEMPTION_CATEGORIES,
  type FieldError,
  type RecurringInterval,
  type RecurringTemplate,
  type TaxExemptionCategory,
} from '../../shared/types';
import { Can, useCan } from '../access';
import { api, ApiError, type CustomerRow, type RecurringPayload } from '../api';
import { centsToInput, fmtDate, fmtEur, parseEurToCents } from '../format';

/**
 * RECURRING — the same invoice every month, quarter or year.
 *
 * A template never sends anything: generating turns each period that has
 * begun into a DRAFT, which is checked and sent like any other. Which periods
 * are due is derived by the server on every load; what is stored is only the
 * template and which period produced which draft.
 */

interface Props {
  onOpenInvoice: (id: number) => void;
  onAuthLost: () => void;
}

const INTERVAL_LABEL: Record<RecurringInterval, string> = { monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };

export function RecurringView({ onOpenInvoice, onAuthLost }: Props) {
  const [templates, setTemplates] = useState<RecurringTemplate[] | null>(null);
  const [editing, setEditing] = useState<RecurringTemplate | 'new' | null>(null);
  const [error, setError] = useState('');
  const [details, setDetails] = useState<FieldError[]>([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const canEdit = useCan('edit');

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      setError(err instanceof Error ? err.message : 'Request failed');
      setDetails(err instanceof ApiError ? err.details : []);
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    try {
      setTemplates((await api.recurring()).templates);
    } catch (err) {
      handle(err);
    }
  }, [handle]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: () => Promise<string>) {
    setBusy(true);
    setError('');
    setDetails([]);
    setNotice('');
    try {
      setNotice(await action());
      await load();
    } catch (err) {
      handle(err);
    } finally {
      setBusy(false);
    }
  }

  const drafts = (n: number) => `${n} draft${n === 1 ? '' : 's'} created`;
  const due = templates?.reduce((sum, t) => sum + t.due_periods, 0) ?? 0;

  if (editing !== null) {
    return (
      <TemplateForm
        template={editing === 'new' ? null : editing}
        onDone={() => {
          setEditing(null);
          void load();
        }}
        onAuthLost={onAuthLost}
      />
    );
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.06 · BILLING</div>
          <h1 className="resource__title">Recurring</h1>
          <p className="resource__desc">
            Templates that become a draft for every period that has begun — at most one per period, however often
            you generate. Drafts are checked and sent like any other; editing a template changes future periods only.
          </p>
        </div>
        <div className="resource__actions">
          <Can>
            <button className="btn btn--ghost" onClick={() => setEditing('new')}>
              + NEW TEMPLATE
            </button>
          </Can>
          <Can level="manage">
            <button
              className="btn btn--primary"
              disabled={busy || due === 0}
              onClick={() => void act(async () => drafts((await api.recurringRun()).created.length))}
            >
              GENERATE ALL — {due} DUE
            </button>
          </Can>
        </div>
      </div>

      {error && (
        <div className="resource__error mono">
          {error}
          {details.map((d) => (
            <div key={d.field + d.message}>
              {d.field}: {d.message}
            </div>
          ))}
        </div>
      )}
      {notice && <div className="totals__row mono">{notice}</div>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Template</th>
              <th>Customer</th>
              <th>Rhythm</th>
              <th className="table__num">Net / period</th>
              <th>Next period</th>
              <th>Generated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {templates?.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={7}>
                  NO TEMPLATES YET
                </td>
              </tr>
            )}
            {templates?.map((t) => (
              <tr key={t.id}>
                <td>
                  {canEdit ? (
                    <button className="linklike" onClick={() => setEditing(t)}>
                      {t.name}
                    </button>
                  ) : (
                    t.name
                  )}
                  {!t.active && <span className="mono table__id"> · PAUSED</span>}
                </td>
                <td>{t.customer_name}</td>
                <td className="mono">
                  {INTERVAL_LABEL[t.interval]} from {fmtDate(t.start_date)}
                  {t.end_date && ` to ${fmtDate(t.end_date)}`}
                </td>
                <td className="table__num mono">
                  {fmtEur(computeTotals(t.lines, LINE_ROUNDING).net_cents)}
                </td>
                <td className="mono">
                  {t.next_period_start === null ? '—' : fmtDate(t.next_period_start)}
                  {t.due_periods > 0 && ` · ${t.due_periods} DUE`}
                </td>
                <td>
                  {t.recent.length === 0
                    ? '—'
                    : t.recent.slice(0, 3).map((r) => (
                        <div key={r.period_start} className="mono">
                          {fmtDate(r.period_start)} ·{' '}
                          {r.invoice_id === null ? (
                            'draft deleted'
                          ) : (
                            <button className="linklike mono" onClick={() => onOpenInvoice(r.invoice_id!)}>
                              {r.number ?? `draft #${r.invoice_id}`}
                            </button>
                          )}
                        </div>
                      ))}
                </td>
                <td className="table__rowactions">
                  {t.due_periods > 0 && (
                    <Can>
                      <button
                        className="rowbtn mono"
                        disabled={busy}
                        onClick={() => void act(async () => drafts((await api.generateRecurring(t.id)).created.length))}
                      >
                        GENERATE
                      </button>
                    </Can>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface EditableLine {
  description: string;
  quantity: string;
  unitPrice: string;
  vatRate: string;
}

/** Create or change a template — the schedule, plus the lines a draft gets. */
function TemplateForm({
  template,
  onDone,
  onAuthLost,
}: {
  template: RecurringTemplate | null;
  onDone: () => void;
  onAuthLost: () => void;
}) {
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [rates, setRates] = useState<readonly number[]>(VAT_RATES);
  const [name, setName] = useState(template?.name ?? '');
  const [customerId, setCustomerId] = useState(template ? String(template.customer_id) : '');
  const [interval, setRhythm] = useState<RecurringInterval>(template?.interval ?? 'monthly');
  const [startDate, setStartDate] = useState(template?.start_date ?? '');
  const [endDate, setEndDate] = useState(template?.end_date ?? '');
  const [active, setActive] = useState(template?.active ?? true);
  const [terms, setTerms] = useState(String(template?.payment_terms_days ?? 14));
  const [note, setNote] = useState(template?.note ?? '');
  const [buyerReference, setBuyerReference] = useState(template?.buyer_reference ?? '');
  const [exemption, setExemption] = useState(template?.tax_exemption_category ?? '');
  const [exemptionReason, setExemptionReason] = useState(template?.tax_exemption_reason ?? '');
  const [lines, setLines] = useState<EditableLine[]>(
    template?.lines.map((l) => ({
      description: l.description,
      quantity: String(l.quantity),
      unitPrice: centsToInput(l.unit_price_cents),
      vatRate: String(l.vat_rate),
    })) ?? [{ description: '', quantity: '1', unitPrice: '', vatRate: '20' }],
  );
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const { customers: list } = await api.customers();
        setCustomers(list);
        setCustomerId((c) => c || String(list[0]?.id ?? ''));
        const config = await api.einvoiceConfig().catch(() => null);
        if (config?.seller.country) setRates(vatRatesFor(config.seller.country));
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onAuthLost();
        else setError(err instanceof Error ? err.message : 'Failed to load');
      }
    })();
  }, [onAuthLost]);

  const setLine = (i: number, patch: Partial<EditableLine>) =>
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    setFieldErrors([]);
    try {
      await action();
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      setError(err instanceof Error ? err.message : 'Request failed');
      setFieldErrors(err instanceof ApiError ? err.details : []);
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const payload: RecurringPayload = {
      name,
      customer_id: Number(customerId),
      interval,
      start_date: startDate,
      end_date: endDate || null,
      active,
      payment_terms_days: Number(terms),
      note: note.trim() || null,
      buyer_reference: buyerReference.trim() || null,
      tax_exemption_category: (exemption || null) as TaxExemptionCategory | null,
      tax_exemption_reason: exemptionReason.trim() || null,
      lines: lines.map((l) => ({
        description: l.description,
        quantity: Number(l.quantity.replace(',', '.')),
        unit_price_cents: parseEurToCents(l.unitPrice) ?? -1,
        vat_rate: Number(l.vatRate),
      })),
    };
    void run(() => (template === null ? api.createRecurring(payload) : api.updateRecurring(template.id, payload)));
  }

  return (
    <div>
      <button className="backlink mono" onClick={onDone}>
        ← BACK
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.06 · BILLING</div>
          <h1 className="resource__title">{template === null ? 'New recurring invoice' : template.name}</h1>
          <p className="resource__desc">
            Each period becomes a draft dated to the period's first day, with the service period in its note. The
            start date is fixed once a period has been generated.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}
      {fieldErrors.length > 0 && (
        <div className="resource__error mono">{fieldErrors.map((e) => `${e.field}: ${e.message}`).join(' · ')}</div>
      )}

      <form className="editor" onSubmit={submit}>
        <div className="editor__meta">
          <label className="field editor__note">
            <span className="field__label mono">
              NAME <span className="field__req">*</span>
            </span>
            <input className="field__input" value={name} placeholder="e.g. Wartungsvertrag Kunde GmbH" onChange={(e) => setName(e.target.value)} />
          </label>
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
            <span className="field__label mono">RHYTHM</span>
            <select className="field__input" value={interval} onChange={(e) => setRhythm(e.target.value as RecurringInterval)}>
              {RECURRING_INTERVALS.map((i) => (
                <option key={i} value={i}>
                  {INTERVAL_LABEL[i]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label mono">
              FIRST PERIOD STARTS <span className="field__req">*</span>
            </span>
            <input className="field__input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label mono">LAST PERIOD STARTS BY</span>
            <input className="field__input" type="date" value={endDate} title="Empty → open-ended" onChange={(e) => setEndDate(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label mono">PAYMENT TERMS (DAYS)</span>
            <input className="field__input" type="number" min="0" max="365" value={terms} onChange={(e) => setTerms(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label mono">ACTIVE</span>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          </label>
          <label className="field editor__note">
            <span className="field__label mono">NOTE</span>
            <input className="field__input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <label className="field editor__note">
            <span className="field__label mono">BUYER REFERENCE · LEITWEG-ID</span>
            <input className="field__input" value={buyerReference} placeholder="Empty → the customer's default" onChange={(e) => setBuyerReference(e.target.value)} />
          </label>
        </div>

        <div className="section-title mono">LINE ITEMS</div>
        {lines.map((line, i) => (
          <div key={i} className="inv-line">
            <label className="field">
              <span className="field__label mono">
                {i + 1} · DESCRIPTION <span className="field__req">*</span>
              </span>
              <input className="field__input" value={line.description} onChange={(e) => setLine(i, { description: e.target.value })} />
            </label>
            <label className="field">
              <span className="field__label mono">QTY</span>
              <input className="field__input" type="number" step="any" min="0" value={line.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
            </label>
            <label className="field">
              <span className="field__label mono">UNIT PRICE €</span>
              <input className="field__input" placeholder="0,00" value={line.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
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
          onClick={() => setLines([...lines, { description: '', quantity: '1', unitPrice: '', vatRate: String(Math.max(...rates)) }])}
        >
          + ADD LINE
        </button>

        {lines.some((l) => Number(l.vatRate) === 0) && (
          <div className="editor__meta">
            <label className="field">
              <span className="field__label mono">WHY 0 % VAT</span>
              <select className="field__input" value={exemption} onChange={(e) => setExemption(e.target.value)}>
                <option value="">— choose (required for an e-invoice) —</option>
                {TAX_EXEMPTION_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="field editor__note">
              <span className="field__label mono">EXEMPTION TEXT ON THE INVOICE</span>
              <input className="field__input" value={exemptionReason} onChange={(e) => setExemptionReason(e.target.value)} />
            </label>
          </div>
        )}

        <div className="editor__actions">
          {template !== null && template.recent.length === 0 && (
            <button
              className="btn btn--ghost"
              type="button"
              disabled={busy}
              onClick={() => void run(() => api.deleteRecurring(template.id))}
            >
              DELETE
            </button>
          )}
          <button className="btn btn--ghost" type="button" onClick={onDone}>
            CANCEL
          </button>
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? 'SAVING…' : 'SAVE TEMPLATE →'}
          </button>
        </div>
      </form>
    </div>
  );
}
