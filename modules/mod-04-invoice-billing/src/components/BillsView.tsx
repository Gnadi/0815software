import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { BillRow, BillStatus, CreditorRow, FieldError, PaymentConfig } from '../../shared/types';
import { api, ApiError, type PayablesTotals } from '../api';
import { centsToInput, fmtEur, parseEurToCents } from '../format';

/**
 * BILLS — what we owe, and the bank file that pays it.
 *
 * The screen is built around one action: tick the bills to pay, and get a
 * pain.001 file to upload in your online banking. Everything else on it exists
 * to make that action safe — the debtor banner (this installation's own IBAN
 * has to be real before anything can be paid), the status column (a scheduled
 * bill is already in a file and cannot be touched), and the selection total,
 * which is the number that will be on the bank's screen.
 */

interface Props {
  onOpenRun: (id: number) => void;
  onAuthLost: () => void;
}

interface BillForm {
  id: number | null;
  creditor_id: string;
  reference: string;
  remittance: string;
  amount: string;
  issue_date: string;
  due_date: string;
  note: string;
}

const EMPTY_BILL: BillForm = {
  id: null,
  creditor_id: '',
  reference: '',
  remittance: '',
  amount: '',
  issue_date: '',
  due_date: '',
  note: '',
};

const STATUS_LABEL: Record<BillStatus, string> = {
  open: 'OPEN',
  scheduled: 'SCHEDULED',
  paid: 'PAID',
  cancelled: 'CANCELLED',
};

const FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'ALL BILLS' },
  { value: 'open', label: 'OPEN' },
  { value: 'overdue', label: 'OVERDUE' },
  { value: 'scheduled', label: 'SCHEDULED' },
  { value: 'paid', label: 'PAID' },
  { value: 'cancelled', label: 'CANCELLED' },
];

export function BillsView({ onOpenRun, onAuthLost }: Props) {
  const [rows, setRows] = useState<BillRow[] | null>(null);
  const [totals, setTotals] = useState<PayablesTotals | null>(null);
  const [creditors, setCreditors] = useState<CreditorRow[]>([]);
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [executionDate, setExecutionDate] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<BillForm | null>(null);
  const [formError, setFormError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);

  const handle = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : fallback);
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filter === 'overdue') params.set('overdue', '1');
      else if (filter) params.set('status', filter);
      if (search.trim()) params.set('search', search.trim());
      const [bills, creditorList, paymentConfig] = await Promise.all([
        api.bills(params),
        api.creditors(),
        api.paymentConfig(),
      ]);
      setRows(bills.bills);
      setTotals(bills.totals);
      setCreditors(creditorList.creditors);
      setConfig(paymentConfig);
      if (executionDate === '') setExecutionDate(bills.today);
      // Drop anything that is no longer payable — a bill someone else settled
      // must not stay ticked on this screen.
      setSelected((current) => {
        const payable = new Set(bills.bills.filter((b) => b.status === 'open').map((b) => b.id));
        return new Set([...current].filter((id) => payable.has(id)));
      });
      setError('');
    } catch (err) {
      handle(err, 'Failed to load bills');
    }
  }, [filter, search, executionDate, handle]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
  }, [load]);

  const selectable = (rows ?? []).filter((b) => b.status === 'open');
  const chosen = (rows ?? []).filter((b) => selected.has(b.id));
  const selectedCents = chosen.reduce((sum, b) => sum + b.amount_cents, 0);

  function toggle(id: number): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setFormError('');
    setFieldErrors([]);
    try {
      const cents = parseEurToCents(form.amount);
      if (cents === null || cents <= 0) {
        setFormError('Amount must be a positive number, e.g. 384,20');
        return;
      }
      const values = {
        creditor_id: Number(form.creditor_id),
        reference: form.reference.trim(),
        remittance: form.remittance.trim() || null,
        amount_cents: cents,
        issue_date: form.issue_date || null,
        due_date: form.due_date,
        note: form.note.trim() || null,
      };
      if (form.id === null) await api.createBill(values);
      else await api.updateBill(form.id, values);
      setForm(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      setFormError(err instanceof Error ? err.message : 'Request failed');
      if (err instanceof ApiError) setFieldErrors(err.details);
    } finally {
      setBusy(false);
    }
  }

  async function act(run: () => Promise<unknown>, fallback: string): Promise<void> {
    setBusy(true);
    try {
      await run();
      await load();
      setError('');
    } catch (err) {
      handle(err, fallback);
    } finally {
      setBusy(false);
    }
  }

  async function pay(): Promise<void> {
    setBusy(true);
    try {
      const run = await api.createPaymentRun([...selected], executionDate || null);
      setSelected(new Set());
      await load();
      onOpenRun(run.id);
    } catch (err) {
      handle(err, 'Could not produce the payment file');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.04 · PAYABLES</div>
          <h1 className="resource__title">Bills</h1>
          <p className="resource__desc">
            What we owe, and the SEPA credit transfer file that pays it — pain.001, for upload in your
            online banking.
          </p>
        </div>
        <div className="resource__actions">
          <button
            className="btn btn--primary"
            disabled={creditors.length === 0}
            title={creditors.length === 0 ? 'Add a creditor first' : undefined}
            onClick={() => setForm({ ...EMPTY_BILL, creditor_id: String(creditors[0]?.id ?? '') })}
          >
            + NEW BILL
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      {/* The debtor account. Unusable, and nothing can be paid at all — so it
          says so here, before anyone selects a single bill. */}
      {config && !config.ready && (
        <div className="resource__error mono">
          {config.problem} · set SELLER_IBAN to your own account and restart.
        </div>
      )}

      {totals && (
        <div className="stat-row">
          <div className="stat">
            <div className="stat__label mono">OPEN</div>
            <div className="stat__value">{fmtEur(totals.open_cents)}</div>
            <div className="stat__sub mono">{totals.open_count} BILLS</div>
          </div>
          <div className="stat">
            <div className="stat__label mono">OVERDUE</div>
            <div className="stat__value">{fmtEur(totals.overdue_cents)}</div>
            <div className="stat__sub mono">{totals.overdue_count} BILLS</div>
          </div>
          <div className="stat">
            <div className="stat__label mono">SCHEDULED</div>
            <div className="stat__value">{fmtEur(totals.scheduled_cents)}</div>
            <div className="stat__sub mono">{totals.scheduled_count} IN A RUN</div>
          </div>
          <div className="stat">
            <div className="stat__label mono">PAYING FROM</div>
            <div className="stat__value stat__value--small mono">{config?.debtor_iban || '—'}</div>
            <div className="stat__sub mono">{config?.pain_version.toUpperCase()}</div>
          </div>
        </div>
      )}

      <div className="toolbar">
        <input
          className="field__input toolbar__search"
          placeholder="Search reference or creditor…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="field__input toolbar__filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <span className="toolbar__count mono">{rows ? `${rows.length} BILLS` : ''}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">
                <input
                  type="checkbox"
                  aria-label="Select all payable bills"
                  checked={selectable.length > 0 && selected.size === selectable.length}
                  disabled={selectable.length === 0}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(selectable.map((b) => b.id)) : new Set())
                  }
                />
              </th>
              <th className="mono">CREDITOR</th>
              <th className="mono">REFERENCE</th>
              <th className="mono">DUE</th>
              <th className="mono">STATUS</th>
              <th className="mono table__num">AMOUNT</th>
              <th className="mono">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((b) => (
              <tr key={b.id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Pay ${b.reference}`}
                    disabled={b.status !== 'open'}
                    checked={selected.has(b.id)}
                    onChange={() => toggle(b.id)}
                  />
                </td>
                <td>
                  <div>{b.creditor_name}</div>
                  <div className="mono table__id">{b.creditor_iban}</div>
                </td>
                <td>
                  <div className="mono">{b.reference}</div>
                  {b.payment_reference !== b.reference && (
                    <div className="mono table__id">→ {b.payment_reference}</div>
                  )}
                </td>
                <td className="mono table__id">{b.due_date}</td>
                <td>
                  <span className={`badge mono badge--bill-${b.status}`}>{STATUS_LABEL[b.status]}</span>
                  {b.overdue && <span className="badge mono badge--overdue">OVERDUE</span>}
                </td>
                <td className="table__num">{fmtEur(b.amount_cents)}</td>
                <td>
                  <div className="table__rowactions">
                    {b.status === 'scheduled' && b.payment_run_id !== null && (
                      <button className="rowbtn mono" onClick={() => onOpenRun(b.payment_run_id!)}>
                        RUN →
                      </button>
                    )}
                    {b.status === 'open' && (
                      <>
                        <button
                          className="rowbtn mono"
                          onClick={() =>
                            setForm({
                              id: b.id,
                              creditor_id: String(b.creditor_id),
                              reference: b.reference,
                              remittance: b.remittance ?? '',
                              amount: centsToInput(b.amount_cents),
                              issue_date: b.issue_date ?? '',
                              due_date: b.due_date,
                              note: b.note ?? '',
                            })
                          }
                        >
                          EDIT
                        </button>
                        <button
                          className="rowbtn mono"
                          disabled={busy}
                          title="Settled outside this app — cash, card, standing order"
                          onClick={() => void act(() => api.markBillPaid(b.id), 'Could not settle the bill')}
                        >
                          MARK PAID
                        </button>
                        <button
                          className="rowbtn rowbtn--danger mono"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(`Cancel ${b.reference}? It stays on file, unpaid.`)) {
                              void act(() => api.cancelBill(b.id), 'Could not cancel the bill');
                            }
                          }}
                        >
                          CANCEL
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={7}>
                  NO BILLS MATCH
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* The action the screen exists for. */}
      <div className="payrun">
        <div className="payrun__figure">
          <div className="mono payrun__label">SELECTED</div>
          <div className="payrun__total">{fmtEur(selectedCents)}</div>
          <div className="mono payrun__label">{selected.size} TRANSFER(S)</div>
        </div>
        <label className="field payrun__date">
          <span className="field__label mono">EXECUTION DATE</span>
          <input
            className="field__input"
            type="date"
            value={executionDate}
            onChange={(e) => setExecutionDate(e.target.value)}
          />
        </label>
        <button
          className="btn btn--primary"
          disabled={busy || selected.size === 0 || !(config?.ready ?? false)}
          title={config?.ready ? undefined : config?.problem ?? undefined}
          onClick={() => void pay()}
        >
          {busy ? 'WORKING…' : 'CREATE PAYMENT FILE →'}
        </button>
      </div>

      {form && (
        <div className="modal">
          <div className="modal__backdrop" onClick={() => setForm(null)} />
          <form className="modal__card" onSubmit={(e) => void submit(e)}>
            <div className="modal__eyebrow mono">{form.id === null ? 'NEW BILL' : 'EDIT BILL'}</div>
            <h2 className="modal__title">{form.id === null ? 'Record a bill' : form.reference}</h2>
            {formError && <div className="modal__error mono">{formError}</div>}
            {fieldErrors.length > 0 && (
              <div className="modal__error mono">
                {fieldErrors.map((e) => `${e.field}: ${e.message}`).join(' · ')}
              </div>
            )}
            <div className="modal__fields">
              <label className="field" style={{ gridColumn: '1 / -1' }}>
                <span className="field__label mono">
                  CREDITOR <span className="field__req">*</span>
                </span>
                <select
                  className="field__input"
                  value={form.creditor_id}
                  onChange={(e) => setForm({ ...form, creditor_id: e.target.value })}
                >
                  {creditors.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} — {c.iban}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field__label mono">
                  THEIR INVOICE NO. <span className="field__req">*</span>
                </span>
                <input
                  className="field__input"
                  value={form.reference}
                  onChange={(e) => setForm({ ...form, reference: e.target.value })}
                  autoFocus
                />
              </label>
              <label className="field">
                <span className="field__label mono">
                  AMOUNT (GROSS) <span className="field__req">*</span>
                </span>
                <input
                  className="field__input"
                  inputMode="decimal"
                  placeholder="384,20"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field__label mono">BILL DATE</span>
                <input
                  className="field__input"
                  type="date"
                  value={form.issue_date}
                  onChange={(e) => setForm({ ...form, issue_date: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field__label mono">
                  DUE <span className="field__req">*</span>
                </span>
                <input
                  className="field__input"
                  type="date"
                  value={form.due_date}
                  onChange={(e) => setForm({ ...form, due_date: e.target.value })}
                />
              </label>
              <label className="field" style={{ gridColumn: '1 / -1' }}>
                <span className="field__label mono">PAYMENT REFERENCE</span>
                <input
                  className="field__input"
                  placeholder="Leave blank to use their invoice number"
                  value={form.remittance}
                  onChange={(e) => setForm({ ...form, remittance: e.target.value })}
                />
              </label>
              <label className="field" style={{ gridColumn: '1 / -1' }}>
                <span className="field__label mono">NOTE</span>
                <textarea
                  className="field__input"
                  rows={2}
                  value={form.note}
                  onChange={(e) => setForm({ ...form, note: e.target.value })}
                />
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
