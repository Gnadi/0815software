import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AppConfig, PoDetail } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDate, fmtDateTime, fmtEur, fmtQty } from '../format';
import { ApprovalRules } from './ApprovalRules';
import { PoBadge, TierProgress } from './StatusBadge';
import { Can, useCan } from '../access';

const RECEIPT_LABEL = { none: 'NOTHING YET', partial: 'PARTLY', complete: 'COMPLETE' } as const;

interface Props {
  id: number;
  config: AppConfig;
  onBack: () => void;
  onEdit: (id: number) => void;
  onOpenRfq: (id: number) => void;
  onAuthLost: () => void;
}

export function PoDetailView({ id, config, onBack, onEdit, onOpenRfq, onAuthLost }: Props) {
  const [po, setPo] = useState<PoDetail | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [approver, setApprover] = useState('');
  const [decisionNote, setDecisionNote] = useState('');
  const [arriving, setArriving] = useState<Record<number, string>>({});
  const [receivedOn, setReceivedOn] = useState('');
  const [receiptNote, setReceiptNote] = useState('');
  const [correction, setCorrection] = useState(false);
  const canEdit = useCan('edit');

  const load = useCallback(async () => {
    try {
      setPo(await api.poDetail(id));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load purchase order');
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

  function decide(kind: 'approve' | 'reject', event: FormEvent) {
    event.preventDefault();
    if (!po || po.next_tier === null) return;
    const values = { tier: po.next_tier, approver, note: decisionNote.trim() || null };
    void run(
      () => (kind === 'approve' ? api.approvePo(po.id, values) : api.rejectPo(po.id, values)),
      () => {
        setApprover('');
        setDecisionNote('');
      },
    );
  }

  function receive(event: FormEvent) {
    event.preventDefault();
    if (!po) return;
    const lines = Object.entries(arriving)
      .filter(([, q]) => q.trim() !== '' && Number(q.replace(',', '.')) !== 0)
      .map(([lineId, q]) => ({ po_line_id: Number(lineId), quantity: Number(q.replace(',', '.')) * (correction ? -1 : 1) }));
    void run(
      () => api.receive(po.id, { kind: correction ? 'correction' : 'receipt', received_on: receivedOn || undefined, note: receiptNote.trim() || null, lines }),
      () => {
        setArriving({});
        setReceiptNote('');
        setCorrection(false);
      },
    );
  }

  if (error) return <div className="resource__error mono">{error}</div>;
  if (!po) return <div className="boot mono">LOADING…</div>;

  const isDraft = po.status === 'draft';
  const isSubmitted = po.status === 'submitted';
  const isApproved = po.status === 'approved';
  const tierLabel = (tier: number) => config.tiers.find((t) => t.tier === tier)?.label ?? `Tier ${tier}`;
  const wasRejected = isDraft && po.approvals.some((a) => a.decision === 'rejected');
  const receiving = po.status === 'ordered';

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← ALL PURCHASE ORDERS
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ PRC.02 · ORDERING</div>
          <h1 className="resource__title">{po.number}</h1>
          <p className="resource__desc">
            {po.supplier_name}
            {po.rfq_id && (
              <>
                {' · '}
                <button className="linklike" onClick={() => onOpenRfq(po.rfq_id!)}>
                  from RFQ-{po.rfq_id}
                </button>
              </>
            )}
            {' · '}
            <PoBadge status={po.status} />
          </p>
        </div>
        <div className="resource__actions">
          {isDraft && (
            <>
              <Can>
                <button className="btn btn--ghost" onClick={() => onEdit(po.id)}>
                  EDIT
                </button>
              </Can>
              {po.submission_no === 0 && (
                <Can>
                  <button
                    className="btn btn--ghost"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm('Delete this draft PO?')) {
                        void run(() => api.deletePo(po.id), onBack);
                      }
                    }}
                  >
                    DELETE
                  </button>
                </Can>
              )}
              <Can>
                <button className="btn btn--primary" disabled={busy} onClick={() => void run(() => api.submitPo(po.id))}>
                  SUBMIT FOR APPROVAL →
                </button>
              </Can>
            </>
          )}
          {isSubmitted && (
            <Can>
              <button
                className="btn btn--ghost"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Return to draft? All approvals of this submission become void (history is kept).')) {
                    void run(() => api.returnToDraft(po.id));
                  }
                }}
              >
                RETURN TO DRAFT
              </button>
            </Can>
          )}
          {isApproved && (
            <>
              <Can>
                <button
                  className="btn btn--ghost"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm('Return to draft? All approvals become void (history is kept).')) {
                      void run(() => api.returnToDraft(po.id));
                    }
                  }}
                >
                  RETURN TO DRAFT
                </button>
              </Can>
              <Can>
                <button className="btn btn--primary" disabled={busy} onClick={() => void run(() => api.markOrdered(po.id))}>
                  MARK ORDERED →
                </button>
              </Can>
            </>
          )}
          {po.status === 'ordered' && (
            <Can>
              <button className="btn btn--primary" disabled={busy} onClick={() => void run(() => api.closePo(po.id))}>
                CLOSE PO →
              </button>
            </Can>
          )}
        </div>
      </div>

      {actionError && <div className="resource__error mono">{actionError}</div>}

      {wasRejected && (
        <div className="resource__error mono">
          REJECTED — BACK IN DRAFT. Fix the order and submit again; the voided approvals stay in the timeline below.
        </div>
      )}

      <div className="stat-row">
        <div className="stat stat--total">
          <div className="stat__label mono">TOTAL (NET)</div>
          <div className="stat__value">{fmtEur(po.total_cents)}</div>
        </div>
        <div className="stat">
          <div className="stat__label mono">APPROVAL PROGRESS</div>
          <div className="stat__value">
            {po.required_tiers.length > 0 ? (
              <TierProgress required={po.required_tiers} approved={po.approved_tiers} />
            ) : (
              <span className="table__id mono">NOT SUBMITTED</span>
            )}
          </div>
        </div>
        <div className="stat">
          <div className="stat__label mono">SUBMISSIONS</div>
          <div className="stat__value">{po.submission_no}</div>
        </div>
        {po.ordered_at && (
          <div className="stat">
            <div className="stat__label mono">ORDERED</div>
            <div className="stat__value" style={{ fontSize: 16 }}>{fmtDate(po.ordered_at)}</div>
          </div>
        )}
        {po.ordered_at && (
          <div className="stat">
            <div className="stat__label mono">RECEIVED (NET) · {RECEIPT_LABEL[po.receipt_status]}</div>
            <div className="stat__value">{fmtEur(po.received_cents)}</div>
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
              <th className="mono">UNIT</th>
              <th className="mono" style={{ textAlign: 'right' }}>UNIT PRICE</th>
              <th className="mono" style={{ textAlign: 'right' }}>NET</th>
              <th className="mono">SKU</th>
              {po.ordered_at && <th className="mono" style={{ textAlign: 'right' }}>RECEIVED</th>}
              {receiving && canEdit && <th className="mono" style={{ textAlign: 'right' }}>{correction ? 'TAKE BACK' : 'ARRIVED NOW'}</th>}
            </tr>
          </thead>
          <tbody>
            {po.lines.map((line) => (
              <tr key={line.id}>
                <td className="mono table__id">{line.position}</td>
                <td>{line.description}</td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>{fmtQty(line.quantity)}</td>
                <td className="mono table__id">{line.unit}</td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>{fmtEur(line.unit_price_cents)}</td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>{fmtEur(line.net_cents)}</td>
                <td className="mono">
                  {!isDraft && po.status !== 'closed' && canEdit ? (
                    <button
                      type="button"
                      className="linklike mono"
                      title="MOD-03 article number — received goods on this line are booked into its stock"
                      onClick={() => {
                        const next = window.prompt(`Article number (SKU) for line ${line.position} — empty for a service:`, line.sku ?? '');
                        if (next !== null) void run(() => api.setSku(po.id, line.id, next.trim() || null));
                      }}
                    >
                      {line.sku ?? 'set…'}
                    </button>
                  ) : (
                    (line.sku ?? '—')
                  )}
                </td>
                {po.ordered_at && (
                  <td className={`table__num mono ${line.received_quantity >= line.quantity ? '' : 'table__id'}`} style={{ textAlign: 'right' }}>
                    {fmtQty(line.received_quantity)} / {fmtQty(line.quantity)}
                  </td>
                )}
                {receiving && canEdit && (
                  <td className="table__num">
                    {(correction ? line.received_quantity > 0 : line.received_quantity < line.quantity) && (
                      <input
                        className="field__input receive-input"
                        value={arriving[line.id] ?? ''}
                        onChange={(e) => setArriving({ ...arriving, [line.id]: e.target.value })}
                      />
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {receiving && (
        <Can>
          <form className="receive-bar" onSubmit={receive}>
            <label className="field">
              <span className="field__label mono">RECEIVED ON</span>
              <input className="field__input" type="date" value={receivedOn} title="Empty → today" onChange={(e) => setReceivedOn(e.target.value)} />
            </label>
            <label className="field" style={{ minWidth: 220 }}>
              <span className="field__label mono">
                {correction ? 'WHY' : 'NOTE'} {correction && <span className="field__req">*</span>}
              </span>
              <input className="field__input" value={receiptNote} placeholder={correction ? 'e.g. counted twice' : 'e.g. delivery note number'} onChange={(e) => setReceiptNote(e.target.value)} />
            </label>
            <label className="mono receive-bar__hint">
              <input type="checkbox" checked={correction} onChange={(e) => setCorrection(e.target.checked)} /> CORRECTION
            </label>
            <button className="btn btn--primary" type="submit" disabled={busy || (correction && receiptNote.trim() === '')}>
              {correction ? 'BOOK CORRECTION →' : 'RECEIVE GOODS →'}
            </button>
            <span className="receive-bar__hint mono">NEVER MORE THAN ORDERED</span>
          </form>
        </Can>
      )}

      {po.receipts.length > 0 && (
        <>
          <div className="section-title mono">GOODS RECEIPTS · APPEND-ONLY</div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="mono">NUMBER</th>
                  <th className="mono">RECEIVED</th>
                  <th className="mono">LINES</th>
                  <th className="mono">BY</th>
                  <th className="mono">STOCK (MOD-03)</th>
                </tr>
              </thead>
              <tbody>
                {po.receipts.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">
                      {r.number}
                      {r.kind === 'correction' && <span className="badge mono badge--voided">CORRECTION</span>}
                    </td>
                    <td className="mono table__id">{r.received_on}</td>
                    <td className="note-cell">
                      {r.lines.map((l) => `${fmtQty(l.quantity)} × ${l.description}`).join(' · ')}
                      {r.note && <div className="table__id">{r.note}</div>}
                    </td>
                    <td className="table__id">{r.actor}</td>
                    <td className="mono">
                      {r.stock_status === 'booked' && `BOOKED · ${r.stock_warehouse}`}
                      {r.stock_status === 'not_booked' && <span className="table__id">NOT BOOKED — {r.stock_error}</span>}
                      {r.stock_status === 'failed' && <span className="badge--rejected" title={r.stock_error ?? ''}>FAILED — {r.stock_error}</span>}
                      {r.stock_status === null && '—'}
                      {(r.stock_status === 'failed' || r.stock_status === 'not_booked') && r.kind === 'receipt' && (
                        <Can>
                          {' '}
                          <button type="button" className="linklike mono" disabled={busy} onClick={() => void run(() => api.bookStock(r.id))}>
                            BOOK AGAIN
                          </button>
                        </Can>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {po.note && (
        <>
          <div className="section-title mono">NOTE</div>
          <p className="resource__desc">{po.note}</p>
        </>
      )}

      <div className="section-title mono">APPROVAL RULES (SERVER CONFIG)</div>
      <ApprovalRules config={config} activeTotalCents={po.total_cents} />

      {(isSubmitted || isApproved) && (
        <>
          <div className="section-title mono">
            REQUIRED FOR THIS SUBMISSION — FROZEN AT {fmtEur(po.submissions.find((s) => s.active)?.total_cents ?? po.total_cents)}
          </div>
          <p className="resource__desc">
            {po.required_tiers
              .map((t) => `${t} · ${tierLabel(t)}${po.approved_tiers.includes(t) ? ' ✓' : ''}`)
              .join('   →   ')}
          </p>
        </>
      )}

      {isSubmitted && po.next_tier !== null && (
        <Can level="manage">
          <form className="receive-bar" onSubmit={(e) => decide('approve', e)}>
            <span className="receive-bar__hint mono">
              NEXT: TIER {po.next_tier} · {tierLabel(po.next_tier).toUpperCase()}
            </span>
            <label className="field">
              <span className="field__label mono">
                APPROVER NAME <span className="field__req">*</span>
              </span>
              <input
                className="field__input receive-input"
                value={approver}
                onChange={(e) => setApprover(e.target.value)}
              />
            </label>
            <label className="field" style={{ minWidth: 220 }}>
              <span className="field__label mono">NOTE</span>
              <input className="field__input" value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} />
            </label>
            <button className="btn btn--primary" type="submit" disabled={busy || !approver.trim()}>
              APPROVE TIER {po.next_tier} →
            </button>
            <button
              className="btn btn--danger"
              type="button"
              disabled={busy || !approver.trim()}
              onClick={(e) => decide('reject', e)}
            >
              REJECT
            </button>
            <span className="receive-bar__hint mono">REJECTION RETURNS THE PO TO DRAFT AND VOIDS ALL APPROVALS</span>
          </form>
        </Can>
      )}

      <div className="section-title mono">APPROVAL TIMELINE · APPEND-ONLY</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">WHEN</th>
              <th className="mono">SUB#</th>
              <th className="mono">EVENT</th>
              <th className="mono">TIER</th>
              <th className="mono">WHO</th>
              <th className="mono">NOTE</th>
            </tr>
          </thead>
          <tbody>
            {po.submissions.flatMap((sub) => [
              <tr key={`sub-${sub.submission_no}`}>
                <td className="mono table__id">{fmtDateTime(sub.created_at)}</td>
                <td className="mono table__id">{sub.submission_no}</td>
                <td>
                  <span className={`badge mono ${sub.active ? 'badge--submitted' : 'badge--closed'}`}>SUBMITTED</span>
                  {!sub.active && <span className="badge mono badge--voided">SUPERSEDED</span>}
                </td>
                <td className="mono table__id">req. {sub.required_tiers.join('+')}</td>
                <td className="table__id">—</td>
                <td className="note-cell mono table__id">TOTAL {fmtEur(sub.total_cents)}</td>
              </tr>,
              ...po.approvals
                .filter((a) => a.submission_no === sub.submission_no)
                .map((a) => (
                  <tr key={`app-${a.id}`}>
                    <td className="mono table__id">{fmtDateTime(a.created_at)}</td>
                    <td className="mono table__id">{a.submission_no}</td>
                    <td>
                      <span className={`badge mono badge--${a.decision === 'approved' ? 'approved' : 'rejected'}`}>
                        {a.decision.toUpperCase()}
                      </span>
                      {a.voided && a.decision === 'approved' && <span className="badge mono badge--voided">VOIDED</span>}
                    </td>
                    <td className="mono table__id">
                      {a.tier} · {a.tier_label}
                    </td>
                    <td>{a.approver}</td>
                    <td className="note-cell">{a.note ?? '—'}</td>
                  </tr>
                )),
            ])}
            {po.submissions.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={6}>
                  NOT SUBMITTED YET — NO HISTORY
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
