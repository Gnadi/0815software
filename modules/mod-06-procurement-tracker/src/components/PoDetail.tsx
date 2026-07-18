import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AppConfig, PoDetail } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDate, fmtDateTime, fmtEur, fmtQty } from '../format';
import { ApprovalRules } from './ApprovalRules';
import { PoBadge, TierProgress } from './StatusBadge';

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

  if (error) return <div className="resource__error mono">{error}</div>;
  if (!po) return <div className="boot mono">LOADING…</div>;

  const isDraft = po.status === 'draft';
  const isSubmitted = po.status === 'submitted';
  const isApproved = po.status === 'approved';
  const tierLabel = (tier: number) => config.tiers.find((t) => t.tier === tier)?.label ?? `Tier ${tier}`;
  const wasRejected = isDraft && po.approvals.some((a) => a.decision === 'rejected');

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
              <button className="btn btn--ghost" onClick={() => onEdit(po.id)}>
                EDIT
              </button>
              {po.submission_no === 0 && (
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
              )}
              <button className="btn btn--primary" disabled={busy} onClick={() => void run(() => api.submitPo(po.id))}>
                SUBMIT FOR APPROVAL →
              </button>
            </>
          )}
          {isSubmitted && (
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
          )}
          {isApproved && (
            <>
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
              <button className="btn btn--primary" disabled={busy} onClick={() => void run(() => api.markOrdered(po.id))}>
                MARK ORDERED →
              </button>
            </>
          )}
          {po.status === 'ordered' && (
            <button className="btn btn--primary" disabled={busy} onClick={() => void run(() => api.closePo(po.id))}>
              CLOSE PO →
            </button>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
