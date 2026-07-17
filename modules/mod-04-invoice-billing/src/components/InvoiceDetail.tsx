import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { InvoiceDetail as Detail } from '../../shared/types';
import { api, ApiError, invoicePdfUrl } from '../api';
import { fmtDate, fmtEur, fmtQty } from '../format';
import { PaymentBadge, StatusBadge } from './StatusBadge';

interface Props {
  id: number;
  onBack: () => void;
  onEdit: (id: number) => void;
  onOpenLedger: (customerId: number) => void;
  onAuthLost: () => void;
}

export function InvoiceDetail({ id, onBack, onEdit, onOpenLedger, onAuthLost }: Props) {
  const [invoice, setInvoice] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState('');
  const [payNote, setPayNote] = useState('');

  const load = useCallback(async () => {
    try {
      setInvoice(await api.invoiceDetail(id));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load invoice');
    }
  }, [id, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setActionError('');
    try {
      await action();
      after?.();
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      setActionError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  function submitPayment(event: FormEvent) {
    event.preventDefault();
    const cents = Math.round(Number(payAmount.replace(',', '.')) * 100);
    void run(
      () =>
        api.recordPayment(id, {
          amount_cents: cents,
          date: payDate || undefined,
          note: payNote.trim() || null,
        }),
      () => {
        setPayAmount('');
        setPayDate('');
        setPayNote('');
      },
    );
  }

  if (error) return <div className="resource__error mono">{error}</div>;
  if (!invoice) return <div className="boot mono">LOADING…</div>;

  const isDraft = invoice.status === 'draft';
  const canPay = invoice.status === 'sent';
  const canCancel = invoice.status === 'sent' || invoice.status === 'paid';

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← ALL INVOICES
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.01 · BILLING</div>
          <h1 className="resource__title">{invoice.number ?? `Draft #${invoice.id}`}</h1>
          <p className="resource__desc">
            <button className="linklike" onClick={() => onOpenLedger(invoice.customer_id)}>
              {invoice.customer_name}
            </button>
            {invoice.issue_date && <> · issued {fmtDate(invoice.issue_date)}</>}
            {invoice.due_date && <> · due {fmtDate(invoice.due_date)}</>}
            {' · '}
            <StatusBadge status={invoice.status} overdue={invoice.overdue} />
          </p>
        </div>
        <div className="resource__actions">
          <a className="btn btn--ghost" href={invoicePdfUrl(invoice.id)} target="_blank" rel="noreferrer">
            PDF ↓
          </a>
          {isDraft && (
            <>
              <button className="btn btn--ghost" onClick={() => onEdit(invoice.id)}>
                EDIT
              </button>
              <button
                className="btn btn--ghost"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Delete this draft? Drafts have no number, so nothing is lost.')) {
                    void run(() => api.deleteDraft(invoice.id), onBack);
                  }
                }}
              >
                DELETE
              </button>
              <button className="btn btn--primary" disabled={busy} onClick={() => void run(() => api.finalize(invoice.id))}>
                SEND — ASSIGN NUMBER →
              </button>
            </>
          )}
          {canCancel && (
            <button className="btn btn--ghost" disabled={busy} onClick={() => setCancelling(true)}>
              CANCEL INVOICE
            </button>
          )}
        </div>
      </div>

      {actionError && <div className="resource__error mono">{actionError}</div>}

      {invoice.status === 'cancelled' && (
        <div className="resource__error mono">
          CANCELLED {invoice.cancelled_at ? fmtDate(invoice.cancelled_at) : ''} — {invoice.cancellation_reason}
          {' · '}the number {invoice.number} is kept; issue a new invoice for corrections.
        </div>
      )}

      <div className="stat-row">
        <div className="stat">
          <div className="stat__label mono">NET</div>
          <div className="stat__value">{fmtEur(invoice.net_cents)}</div>
        </div>
        <div className="stat">
          <div className="stat__label mono">VAT</div>
          <div className="stat__value">{fmtEur(invoice.vat_cents)}</div>
        </div>
        <div className="stat stat--total">
          <div className="stat__label mono">GROSS</div>
          <div className="stat__value">{fmtEur(invoice.gross_cents)}</div>
        </div>
        <div className="stat">
          <div className="stat__label mono">PAID</div>
          <div className="stat__value">{fmtEur(invoice.paid_cents)}</div>
        </div>
        {canPay && (
          <div className="stat">
            <div className="stat__label mono">OPEN</div>
            <div className="stat__value">{fmtEur(invoice.open_cents)}</div>
          </div>
        )}
      </div>

      <div className="section-title mono">LINE ITEMS</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">POS</th>
              <th className="mono">DESCRIPTION</th>
              <th className="mono" style={{ textAlign: 'right' }}>QTY</th>
              <th className="mono" style={{ textAlign: 'right' }}>UNIT PRICE</th>
              <th className="mono" style={{ textAlign: 'right' }}>VAT</th>
              <th className="mono" style={{ textAlign: 'right' }}>NET</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line) => (
              <tr key={line.id}>
                <td className="mono table__id">{line.position}</td>
                <td>{line.description}</td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>{fmtQty(line.quantity)}</td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>{fmtEur(line.unit_price_cents)}</td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>{line.vat_rate}%</td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>{fmtEur(line.net_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-title mono">VAT SUMMARY</div>
      <div className="totals">
        {invoice.vat_breakdown.map((r) => (
          <div key={r.rate} className="totals__row mono">
            <span>
              {r.rate}% OF {fmtEur(r.base_cents)}
            </span>
            <span className="table__num">{fmtEur(r.vat_cents)}</span>
          </div>
        ))}
        <div className="totals__row totals__row--gross mono">
          <span>GROSS</span>
          <span className="table__num">{fmtEur(invoice.gross_cents)}</span>
        </div>
      </div>

      {invoice.note && (
        <>
          <div className="section-title mono">NOTE</div>
          <p className="resource__desc">{invoice.note}</p>
        </>
      )}

      {!isDraft && (
        <>
          <div className="section-title mono">
            PAYMENTS · <PaymentBadge status={invoice.payment_status} />
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="mono">DATE</th>
                  <th className="mono" style={{ textAlign: 'right' }}>AMOUNT</th>
                  <th className="mono">NOTE</th>
                </tr>
              </thead>
              <tbody>
                {invoice.payments.map((p) => (
                  <tr key={p.id}>
                    <td className="mono table__id">{p.date}</td>
                    <td className="table__num mono" style={{ textAlign: 'right' }}>{fmtEur(p.amount_cents)}</td>
                    <td className="note-cell">{p.note}</td>
                  </tr>
                ))}
                {invoice.payments.length === 0 && (
                  <tr>
                    <td className="table__empty mono" colSpan={3}>
                      NO PAYMENTS RECORDED
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {canPay && (
            <form className="receive-bar" onSubmit={submitPayment}>
              <label className="field">
                <span className="field__label mono">
                  AMOUNT € <span className="field__req">*</span>
                </span>
                <input
                  className="field__input receive-input"
                  placeholder="0,00"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="field__label mono">DATE</span>
                <input
                  className="field__input"
                  type="date"
                  value={payDate}
                  onChange={(e) => setPayDate(e.target.value)}
                />
              </label>
              <label className="field" style={{ minWidth: 220 }}>
                <span className="field__label mono">NOTE</span>
                <input className="field__input" value={payNote} onChange={(e) => setPayNote(e.target.value)} />
              </label>
              <button className="btn btn--primary" type="submit" disabled={busy || !payAmount}>
                RECORD PAYMENT →
              </button>
              <span className="receive-bar__hint mono">OVERPAYMENT IS REJECTED — {fmtEur(invoice.open_cents)} OPEN</span>
            </form>
          )}
        </>
      )}

      {cancelling && (
        <div className="modal">
          <div className="modal__backdrop" onClick={() => setCancelling(false)} />
          <form
            className="modal__card"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.cancel(invoice.id, cancelReason), () => setCancelling(false));
            }}
          >
            <div className="modal__eyebrow mono">CANCEL {invoice.number}</div>
            <h2 className="modal__title">Cancel invoice</h2>
            <p className="resource__desc" style={{ marginBottom: 16 }}>
              The number {invoice.number} is kept forever — cancellation is a status, not a deletion.
              Issue a new invoice for a correction.
            </p>
            <label className="field" style={{ marginBottom: 20 }}>
              <span className="field__label mono">
                REASON <span className="field__req">*</span>
              </span>
              <input
                className="field__input"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                autoFocus
              />
            </label>
            <div className="modal__actions">
              <button className="btn btn--ghost" type="button" onClick={() => setCancelling(false)}>
                KEEP INVOICE
              </button>
              <button className="btn btn--primary" type="submit" disabled={busy || !cancelReason.trim()}>
                CANCEL INVOICE →
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
