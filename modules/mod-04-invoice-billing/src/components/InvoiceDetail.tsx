import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { computeTotals } from '../../shared/money';
import type { CreditNote, InvoiceDetail as Detail } from '../../shared/types';
import { api, ApiError, creditNotePdfUrl, ebInterfaceUrl, invoicePdfUrl, xrechnungUrl, zugferdUrl, type EInvoiceStatus } from '../api';
import { centsToInput, fmtDate, fmtEur, fmtQty, parseEurToCents } from '../format';
import { PaymentBadge, StatusBadge } from './StatusBadge';
import { Can } from '../access';

interface Props {
  id: number;
  onBack: () => void;
  onEdit: (id: number) => void;
  onOpenLedger: (customerId: number) => void;
  onAuthLost: () => void;
}

export function InvoiceDetail({ id, onBack, onEdit, onOpenLedger, onAuthLost }: Props) {
  const [invoice, setInvoice] = useState<Detail | null>(null);
  const [einvoice, setEinvoice] = useState<EInvoiceStatus | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [crediting, setCrediting] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState('');
  const [payNote, setPayNote] = useState('');

  const load = useCallback(async () => {
    try {
      const detail = await api.invoiceDetail(id);
      setInvoice(detail);
      // Drafts too: what is missing has to be filled in before sending.
      setEinvoice(await api.einvoiceStatus(id).catch(() => null));
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
  // A credited invoice is corrected further by credit notes, never cancelled
  // on top of them (the server refuses it too).
  const canCredit = invoice.status === 'sent' || invoice.status === 'paid';
  const canCancel = canCredit && invoice.credit_notes.length === 0;

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
              <Can>
                <button className="btn btn--ghost" onClick={() => onEdit(invoice.id)}>
                  EDIT
                </button>
              </Can>
              <Can>
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
              </Can>
              <Can>
                <button className="btn btn--primary" disabled={busy} onClick={() => void run(() => api.finalize(invoice.id))}>
                  SEND — ASSIGN NUMBER →
                </button>
              </Can>
            </>
          )}
          {canCredit && invoice.creditable.some((r) => r.base_cents > 0) && (
            <Can>
              <button className="btn btn--ghost" disabled={busy} onClick={() => setCrediting(true)}>
                CREDIT NOTE
              </button>
            </Can>
          )}
          {canCancel && (
            <Can>
              <button className="btn btn--ghost" disabled={busy} onClick={() => setCancelling(true)}>
                CANCEL INVOICE
              </button>
            </Can>
          )}
        </div>
      </div>

      {actionError && <div className="resource__error mono">{actionError}</div>}

      {invoice.status === 'cancelled' && (
        <div className="resource__error mono">
          CANCELLED {invoice.cancelled_on ? fmtDate(invoice.cancelled_on) : ''} — {invoice.cancellation_reason}
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
        {invoice.credited_cents > 0 && (
          <div className="stat">
            <div className="stat__label mono">CREDITED</div>
            <div className="stat__value">{fmtEur(-invoice.credited_cents)}</div>
          </div>
        )}
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

      {(invoice.delivery_date || invoice.period_start || invoice.buyer_reference || invoice.tax_exemption_category) && (
        <p className="resource__desc mono">
          {invoice.period_start && invoice.period_end && (
            <>SERVICE PERIOD {fmtDate(invoice.period_start)} – {fmtDate(invoice.period_end)} · </>
          )}
          {invoice.delivery_date && <>SERVICE DATE {fmtDate(invoice.delivery_date)} · </>}
          {invoice.buyer_reference && <>BUYER REF {invoice.buyer_reference} · </>}
          {invoice.tax_exemption_category && (
            <>0 % VAT: {invoice.tax_exemption_category}{invoice.tax_exemption_reason ? ` — ${invoice.tax_exemption_reason}` : ''}</>
          )}
        </p>
      )}

      {einvoice && !einvoice.available && (
        <>
          <div className="section-title mono">E-INVOICE · BEFORE SENDING</div>
          <DraftEInvoicePanel status={einvoice} />
        </>
      )}

      {einvoice?.available && (
        <>
          <div className="section-title mono">E-INVOICE · XRECHNUNG / ZUGFERD / EBINTERFACE</div>
          <EInvoicePanel id={invoice.id} status={einvoice} creditNotes={invoice.credit_notes} />
        </>
      )}

      {invoice.credit_notes.length > 0 && (
        <>
          <div className="section-title mono">CREDIT NOTES</div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="mono">NUMBER</th>
                  <th className="mono">DATE</th>
                  <th className="mono">REASON</th>
                  <th className="mono" style={{ textAlign: 'right' }}>GROSS</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {invoice.credit_notes.map((n) => (
                  <tr key={n.id}>
                    <td className="mono">{n.number}</td>
                    <td className="mono table__id">{fmtDate(n.issue_date)}</td>
                    <td className="note-cell">
                      {n.reason} <span className="table__id">· {n.actor}</span>
                    </td>
                    <td className="table__num mono" style={{ textAlign: 'right' }}>{fmtEur(n.gross_cents)}</td>
                    <td className="table__rowactions">
                      <a className="rowbtn mono" href={creditNotePdfUrl(invoice.id, n.id)} target="_blank" rel="noreferrer">
                        PDF ↓
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
            <Can>
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
            </Can>
          )}
        </>
      )}

      {crediting && (
        <CreditNoteForm
          invoice={invoice}
          busy={busy}
          onClose={() => setCrediting(false)}
          onSubmit={(payload) => void run(() => api.issueCreditNote(invoice.id, payload), () => setCrediting(false))}
        />
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

const FORMAT_LABELS = {
  xrechnung: 'XRECHNUNG (XML)',
  zugferd: 'ZUGFERD (PDF/A-3)',
  ebinterface: 'EBINTERFACE 6.1 (XML)',
} as const;

function ProblemList({ problems }: { problems: { term: string; field: string; message: string }[] }) {
  return (
    <ul className="note-cell" style={{ margin: '6px 0 0', paddingLeft: 18, textTransform: 'none' }}>
      {problems.map((p) => (
        <li key={`${p.term}-${p.field}`}>
          {p.term}: {p.message} <span className="table__id">({p.field})</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What each e-invoice format would still refuse if this draft were sent now.
 * Once it is sent, its parties and lines are frozen and a missing field can
 * only be supplied by cancelling and issuing again — so this is the moment.
 * The customer's own format is the one sending is refused for.
 */
function DraftEInvoicePanel({ status }: { status: Extract<EInvoiceStatus, { available: false }> }) {
  const required = status.format && status.format !== 'none' ? status.format : null;
  return (
    <div className="totals">
      <div className="totals__row mono">
        <span className="table__id" style={{ textTransform: 'none' }}>
          {required
            ? `This customer receives ${FORMAT_LABELS[required]}: sending is refused until it is complete.`
            : status.format === 'none'
              ? 'This customer receives no e-invoice; nothing is checked when sending.'
              : 'No e-invoice format is set for this customer, so nothing is checked when sending. Set one on the customer if they need an e-invoice.'}
        </span>
      </div>
      {(Object.keys(FORMAT_LABELS) as (keyof typeof FORMAT_LABELS)[]).map((key) => {
        const problems = status.problems[key];
        return (
          <div key={key} className="totals__row mono" style={{ alignItems: 'flex-start', gap: 16 }}>
            <span>
              {FORMAT_LABELS[key]}
              {key === required && ' · REQUIRED'}
              {problems.length > 0 && <ProblemList problems={problems} />}
            </span>
            <span className="table__id">{problems.length === 0 ? 'READY' : `${problems.length} MISSING`}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The e-invoice downloads of an issued invoice. Each format is offered only
 * when it would validate; otherwise the missing fields are listed with their
 * business terms (EN 16931 numbering, also for ebInterface), which is what
 * the server would refuse with. A file is stored at its first download and
 * served unchanged afterwards; the ones that went out are listed with their
 * SHA-256.
 */
function EInvoicePanel({
  id,
  status,
  creditNotes,
}: {
  id: number;
  status: Extract<EInvoiceStatus, { available: true }>;
  creditNotes: CreditNote[];
}) {
  const urls = { xrechnung: xrechnungUrl, zugferd: zugferdUrl, ebinterface: ebInterfaceUrl };
  return (
    <div className="totals">
      {(Object.keys(FORMAT_LABELS) as (keyof typeof FORMAT_LABELS)[]).map((key) => {
        const problems = status.problems[key];
        // A file that went out is served as stored, whatever today's check says
        // (an invoice from before frozen parties reads today's master data).
        const delivered = status.issued.some((d) => d.document === 'invoice' && d.format === key);
        const url = urls[key];
        return (
          <div key={key} className="totals__row mono" style={{ alignItems: 'flex-start', gap: 16 }}>
            <span>
              {FORMAT_LABELS[key]}
              {key === status.format && ' · CUSTOMER FORMAT'}
              {problems.length > 0 && !delivered && <ProblemList problems={problems} />}
            </span>
            {problems.length === 0 || delivered ? (
              <span style={{ display: 'flex', gap: 8 }}>
                <a className="btn btn--ghost" href={url(id)}>
                  INVOICE ↓
                </a>
                {status.cancellation && (
                  <a className="btn btn--ghost" href={url(id, 'cancellation')}>
                    CANCELLATION ↓
                  </a>
                )}
                {creditNotes.map((n) => (
                  <a key={n.id} className="btn btn--ghost" href={url(id, n.id)}>
                    {n.number.split('-').at(-1)} ↓
                  </a>
                ))}
              </span>
            ) : (
              <span className="table__id">{problems.length} MISSING</span>
            )}
          </div>
        );
      })}
      {status.parties_frozen &&
        (Object.keys(FORMAT_LABELS) as (keyof typeof FORMAT_LABELS)[]).some((k) => status.problems[k].length > 0) && (
          <div className="totals__row mono">
            <span className="table__id" style={{ textTransform: 'none' }}>
              Frozen at issue: the missing fields cannot be added to this invoice any more. If the customer needs that
              format, cancel the invoice and send a new one once the master data is complete.
            </span>
          </div>
        )}
      {!status.parties_frozen && (
        <div className="totals__row mono">
          <span className="table__id">
            Issued before e-invoicing existed: seller and customer are read from today’s master data.
          </span>
        </div>
      )}
      {status.issued.length > 0 && (
        <div className="totals__row mono" style={{ alignItems: 'flex-start' }}>
          <span className="table__id" style={{ textTransform: 'none' }}>
            Sent as stored — each file is kept as first downloaded:
            <ul className="note-cell" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {status.issued.map((d) => (
                <li key={`${d.document}-${d.format}`}>
                  {d.filename} · {fmtDate(d.created_at)} · {d.created_by} · SHA-256 {d.sha256.slice(0, 16)}…
                </li>
              ))}
            </ul>
          </span>
        </div>
      )}
    </div>
  );
}

interface CreditLine {
  description: string;
  quantity: string;
  unitPrice: string;
  vatRate: number;
  include: boolean;
}

/**
 * The partial credit note: the invoice's lines as a starting point, each
 * switched on and adjusted — a returned item is its quantity, a price
 * reduction its amount. Issued at once with its own number; the server
 * refuses more than is left per VAT rate.
 */
function CreditNoteForm({
  invoice,
  busy,
  onClose,
  onSubmit,
}: {
  invoice: Detail;
  busy: boolean;
  onClose: () => void;
  onSubmit: (payload: { reason: string; issue_date?: string; lines: { description: string; quantity: number; unit_price_cents: number; vat_rate: number }[] }) => void;
}) {
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');
  const [lines, setLines] = useState<CreditLine[]>(
    invoice.lines.map((l) => ({
      description: l.description,
      quantity: String(l.quantity),
      unitPrice: centsToInput(l.unit_price_cents),
      vatRate: l.vat_rate,
      include: false,
    })),
  );
  const setLine = (i: number, patch: Partial<CreditLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const chosen = lines.filter((l) => l.include);
  const totals = computeTotals(
    chosen.map((l) => ({
      quantity: Number(l.quantity.replace(',', '.')) || 0,
      unit_price_cents: parseEurToCents(l.unitPrice) ?? 0,
      vat_rate: l.vatRate,
    })),
    // The server rounds the credit note as its invoice; so does the preview.
    invoice.line_rounding,
  );

  return (
    <div className="modal">
      <div className="modal__backdrop" onClick={onClose} />
      <form
        className="modal__card"
        style={{ maxWidth: 760 }}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({
            reason: reason.trim(),
            issue_date: date || undefined,
            lines: chosen.map((l) => ({
              description: l.description,
              quantity: Number(l.quantity.replace(',', '.')),
              unit_price_cents: parseEurToCents(l.unitPrice) ?? -1,
              vat_rate: l.vatRate,
            })),
          });
        }}
      >
        <div className="modal__eyebrow mono">CREDIT NOTE ON {invoice.number}</div>
        <h2 className="modal__title">Partial credit note</h2>
        <p className="resource__desc" style={{ marginBottom: 16 }}>
          Its own document with its own number, issued at once and never changed. Still creditable:{' '}
          {invoice.creditable
            .filter((r) => r.base_cents > 0)
            .map((r) => `${fmtEur(r.base_cents)} net at ${r.rate} %`)
            .join(' · ')}
          .
        </p>
        {lines.map((line, i) => (
          <div key={i} className="inv-line">
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={line.include} onChange={(e) => setLine(i, { include: e.target.checked })} />
              <input className="field__input" value={line.description} disabled={!line.include} onChange={(e) => setLine(i, { description: e.target.value })} />
            </label>
            <label className="field">
              <span className="field__label mono">QTY</span>
              <input className="field__input" type="number" step="any" min="0" value={line.quantity} disabled={!line.include} onChange={(e) => setLine(i, { quantity: e.target.value })} />
            </label>
            <label className="field">
              <span className="field__label mono">UNIT PRICE €</span>
              <input className="field__input" value={line.unitPrice} disabled={!line.include} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
            </label>
            <span className="mono table__id">{line.vatRate}%</span>
          </div>
        ))}
        <div className="editor__meta" style={{ marginTop: 12 }}>
          <label className="field editor__note">
            <span className="field__label mono">
              REASON <span className="field__req">*</span>
            </span>
            <input className="field__input" value={reason} placeholder="e.g. 2 units returned" onChange={(e) => setReason(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label mono">DATE</span>
            <input className="field__input" type="date" value={date} title="Empty → today" onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        <div className="totals__row totals__row--gross mono">
          <span>CREDIT GROSS</span>
          <span className="table__num">{fmtEur(totals.gross_cents)}</span>
        </div>
        <div className="modal__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>
            CANCEL
          </button>
          <button className="btn btn--primary" type="submit" disabled={busy || !reason.trim() || chosen.length === 0}>
            ISSUE CREDIT NOTE →
          </button>
        </div>
      </form>
    </div>
  );
}
