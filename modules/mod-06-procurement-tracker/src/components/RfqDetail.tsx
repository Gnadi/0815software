import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { RfqDetail, SupplierRow } from '../../shared/types';
import { api, ApiError } from '../api';
import { centsToInput, fmtDate, fmtEur, fmtQty, parseEurToCents } from '../format';
import { RfqBadge } from './StatusBadge';

interface Props {
  id: number;
  onBack: () => void;
  onEdit: (id: number) => void;
  onOpenPo: (id: number) => void;
  onAuthLost: () => void;
}

interface QuoteForm {
  supplierId: number;
  supplierName: string;
  validUntil: string;
  note: string;
  /** rfq_line_id → euro text input */
  prices: Record<number, string>;
}

export function RfqDetailView({ id, onBack, onEdit, onOpenPo, onAuthLost }: Props) {
  const [rfq, setRfq] = useState<RfqDetail | null>(null);
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteId, setInviteId] = useState('');
  const [quoteForm, setQuoteForm] = useState<QuoteForm | null>(null);

  const load = useCallback(async () => {
    try {
      const [detail, { suppliers: all }] = await Promise.all([api.rfqDetail(id), api.suppliers()]);
      setRfq(detail);
      setSuppliers(all);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load RFQ');
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
      setActionError(
        err instanceof ApiError
          ? [err.message, ...err.details.map((d) => d.message)].join(' · ')
          : 'Request failed',
      );
    } finally {
      setBusy(false);
    }
  }

  function openQuoteForm(supplierId: number, supplierName: string) {
    if (!rfq) return;
    const existing = rfq.quotes.find((q) => q.supplier_id === supplierId);
    const prices: Record<number, string> = {};
    for (const line of rfq.lines) {
      const prior = existing?.lines.find((l) => l.rfq_line_id === line.id);
      prices[line.id] = prior ? centsToInput(prior.unit_price_cents) : '';
    }
    setQuoteForm({
      supplierId,
      supplierName,
      validUntil: existing?.valid_until ?? '',
      note: existing?.note ?? '',
      prices,
    });
  }

  function submitQuote(event: FormEvent) {
    event.preventDefault();
    if (!rfq || !quoteForm) return;
    const prices = rfq.lines.map((line) => ({
      rfq_line_id: line.id,
      unit_price_cents: parseEurToCents(quoteForm.prices[line.id] ?? '') ?? -1,
    }));
    void run(
      () =>
        api.upsertQuote(rfq.id, quoteForm.supplierId, {
          valid_until: quoteForm.validUntil || null,
          note: quoteForm.note.trim() || null,
          prices,
        }),
      () => setQuoteForm(null),
    );
  }

  if (error) return <div className="resource__error mono">{error}</div>;
  if (!rfq) return <div className="boot mono">LOADING…</div>;

  const isOpen = rfq.status === 'open' || rfq.status === 'quoted';
  const canEditLines = isOpen && rfq.quote_count === 0;
  const uninvited = suppliers.filter((s) => !rfq.invitations.some((i) => i.supplier_id === s.id));
  const bestTotal = rfq.quotes.length > 0 ? Math.min(...rfq.quotes.map((q) => q.total_cents)) : null;

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← ALL RFQS
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ PRC.01 · RFQ-{rfq.id}</div>
          <h1 className="resource__title">{rfq.title}</h1>
          <p className="resource__desc">
            {rfq.due_date && <>quotes due {fmtDate(rfq.due_date)} · </>}
            {rfq.invited_count} invited · {rfq.quote_count} quoted · <RfqBadge status={rfq.status} />
          </p>
        </div>
        <div className="resource__actions">
          {canEditLines && (
            <button className="btn btn--ghost" onClick={() => onEdit(rfq.id)}>
              EDIT
            </button>
          )}
          {canEditLines && (
            <button
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => {
                if (window.confirm('Delete this RFQ?')) {
                  void run(() => api.deleteRfq(rfq.id), onBack);
                }
              }}
            >
              DELETE
            </button>
          )}
          {isOpen && (
            <button
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => {
                if (window.confirm('Close without award? This is final — no more quotes, no winner.')) {
                  void run(() => api.closeRfq(rfq.id));
                }
              }}
            >
              CLOSE W/O AWARD
            </button>
          )}
        </div>
      </div>

      {actionError && <div className="resource__error mono">{actionError}</div>}

      {rfq.status === 'awarded' && (
        <div className="resource__desc" style={{ marginBottom: 20 }}>
          Awarded to <strong>{rfq.awarded_supplier_name}</strong>
          {rfq.awarded_at && <> on {fmtDate(rfq.awarded_at)}</>} —{' '}
          <button className="linklike" onClick={() => onOpenPo(rfq.awarded_po_id!)}>
            open the draft purchase order
          </button>
          .
        </div>
      )}
      {rfq.note && <p className="resource__desc" style={{ marginBottom: 20 }}>{rfq.note}</p>}

      <div className="section-title mono">INVITATIONS</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">SUPPLIER</th>
              <th className="mono">INVITED</th>
              <th className="mono">QUOTE</th>
              <th className="mono">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {rfq.invitations.map((inv) => (
              <tr key={inv.id}>
                <td>{inv.supplier_name}</td>
                <td className="mono table__id">{fmtDate(inv.created_at)}</td>
                <td className="mono table__id">{inv.has_quote ? 'RECEIVED' : 'PENDING'}</td>
                <td>
                  {isOpen && (
                    <button className="rowbtn mono" onClick={() => openQuoteForm(inv.supplier_id, inv.supplier_name)}>
                      {inv.has_quote ? 'EDIT QUOTE' : 'ENTER QUOTE'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rfq.invitations.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={4}>
                  NO SUPPLIERS INVITED YET
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {isOpen && uninvited.length > 0 && (
        <form
          className="receive-bar"
          onSubmit={(e) => {
            e.preventDefault();
            if (inviteId) void run(() => api.invite(rfq.id, Number(inviteId)), () => setInviteId(''));
          }}
        >
          <label className="field">
            <span className="field__label mono">INVITE SUPPLIER</span>
            <select className="field__input" value={inviteId} onChange={(e) => setInviteId(e.target.value)}>
              <option value="">— choose —</option>
              {uninvited.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn--primary" type="submit" disabled={busy || !inviteId}>
            INVITE →
          </button>
        </form>
      )}

      <div className="section-title mono">QUOTE COMPARISON</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">POS</th>
              <th className="mono">DESCRIPTION</th>
              <th className="mono" style={{ textAlign: 'right' }}>QTY</th>
              {rfq.quotes.map((q) => (
                <th
                  key={q.id}
                  className={`mono ${bestTotal !== null && q.total_cents === bestTotal ? 'is-best' : ''}`}
                  style={{ textAlign: 'right' }}
                >
                  {q.supplier_name}
                  <span className="quote-meta">
                    {q.valid_until ? `VALID UNTIL ${fmtDate(q.valid_until)}` : 'NO VALIDITY DATE'}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rfq.lines.map((line) => (
              <tr key={line.id}>
                <td className="mono table__id">{line.position}</td>
                <td>{line.description}</td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>
                  {fmtQty(line.quantity)} {line.unit}
                </td>
                {rfq.quotes.map((q) => {
                  const ql = q.lines.find((l) => l.rfq_line_id === line.id);
                  return (
                    <td
                      key={q.id}
                      className={`table__num mono ${bestTotal !== null && q.total_cents === bestTotal ? 'is-best' : ''}`}
                      style={{ textAlign: 'right' }}
                    >
                      {ql ? `${fmtEur(ql.unit_price_cents)} · ${fmtEur(ql.net_cents)}` : '—'}
                    </td>
                  );
                })}
              </tr>
            ))}
            {rfq.quotes.length === 0 && rfq.lines.length > 0 && (
              <tr>
                <td className="table__empty mono" colSpan={3 + rfq.quotes.length}>
                  NO QUOTES YET — ENTER THEM VIA THE INVITATIONS ABOVE
                </td>
              </tr>
            )}
          </tbody>
          {rfq.quotes.length > 0 && (
            <tfoot>
              <tr>
                <td className="mono table__id" colSpan={3}>
                  TOTAL / AWARD
                </td>
                {rfq.quotes.map((q) => (
                  <td
                    key={q.id}
                    className={`table__num mono ${bestTotal !== null && q.total_cents === bestTotal ? 'is-best' : ''}`}
                    style={{ textAlign: 'right' }}
                  >
                    {fmtEur(q.total_cents)}
                    {isOpen && (
                      <div style={{ marginTop: 8 }}>
                        <button
                          className="rowbtn mono"
                          disabled={busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Award to ${q.supplier_name} for ${fmtEur(q.total_cents)}? This creates a draft PO and is final.`,
                              )
                            ) {
                              void run(async () => {
                                const { po } = await api.award(rfq.id, q.supplier_id);
                                onOpenPo(po.id);
                              });
                            }
                          }}
                        >
                          AWARD →
                        </button>
                      </div>
                    )}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {rfq.quotes.some((q) => q.note) && (
        <>
          <div className="section-title mono">QUOTE NOTES</div>
          {rfq.quotes
            .filter((q) => q.note)
            .map((q) => (
              <p key={q.id} className="resource__desc">
                <strong>{q.supplier_name}:</strong> {q.note}
              </p>
            ))}
        </>
      )}

      {quoteForm && (
        <div className="modal">
          <div className="modal__backdrop" onClick={() => setQuoteForm(null)} />
          <form className="modal__card" onSubmit={submitQuote}>
            <div className="modal__eyebrow mono">QUOTE · {quoteForm.supplierName}</div>
            <h2 className="modal__title">Enter quote</h2>
            <p className="resource__desc" style={{ marginBottom: 16 }}>
              A quote must price every line — awarding copies it 1:1 into a draft PO.
            </p>
            <div className="modal__fields">
              {rfq.lines.map((line) => (
                <label key={line.id} className="field" style={{ gridColumn: '1 / -1' }}>
                  <span className="field__label mono">
                    {line.position} · {line.description} — {fmtQty(line.quantity)} {line.unit} · UNIT PRICE €{' '}
                    <span className="field__req">*</span>
                  </span>
                  <input
                    className="field__input"
                    placeholder="0,00"
                    value={quoteForm.prices[line.id] ?? ''}
                    onChange={(e) =>
                      setQuoteForm({
                        ...quoteForm,
                        prices: { ...quoteForm.prices, [line.id]: e.target.value },
                      })
                    }
                  />
                </label>
              ))}
              <label className="field">
                <span className="field__label mono">VALID UNTIL</span>
                <input
                  className="field__input"
                  type="date"
                  value={quoteForm.validUntil}
                  onChange={(e) => setQuoteForm({ ...quoteForm, validUntil: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field__label mono">NOTE</span>
                <input
                  className="field__input"
                  value={quoteForm.note}
                  onChange={(e) => setQuoteForm({ ...quoteForm, note: e.target.value })}
                />
              </label>
            </div>
            <div className="modal__actions">
              <button className="btn btn--ghost" type="button" onClick={() => setQuoteForm(null)}>
                CANCEL
              </button>
              <button className="btn btn--primary" type="submit" disabled={busy}>
                {busy ? 'SAVING…' : 'SAVE QUOTE →'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
