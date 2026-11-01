import { useCallback, useEffect, useState } from 'react';
import type { ClaimDetail, ExpenseClaim } from '../../../shared/expense-types';
import { api, ApiError, expensesCsvUrl, receiptFileUrl } from '../../api';
import { fmtEur } from '../../format';
import { CATEGORY_LABEL, ClaimBadge, fmtKm, fmtLocal } from './common';

/**
 * Claims: one's own, and — for `manage` — the office's desk: what is to be
 * decided, what is approved and waits to be paid. Nobody is offered a
 * decision on their own claim; the server refuses it anyway (mayDecide).
 */

interface Props {
  scope: 'mine' | 'office';
  onAuthLost: () => void;
}

const EVENT_LABEL: Record<string, string> = {
  submitted: 'Submitted',
  approved: 'Approved',
  rejected: 'Returned',
  withdrawn: 'Withdrawn',
  handed_over: 'Handed to invoicing',
  paid: 'Paid',
};

export function ClaimsPanel({ scope, onAuthLost }: Props) {
  const [claims, setClaims] = useState<ExpenseClaim[]>([]);
  const [toDecide, setToDecide] = useState<ExpenseClaim[]>([]);
  const [status, setStatus] = useState(scope === 'office' ? 'approved' : '');
  const [open, setOpen] = useState<ClaimDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed');
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    try {
      const me = await api.me();
      if (scope === 'mine') {
        setClaims(me.employee_id ? (await api.claims({ employee_id: me.employee_id })).claims : []);
      } else {
        const [decide, list] = await Promise.all([api.claims({ to_decide: true }), api.claims({ status: status || undefined })]);
        setToDecide(decide.claims);
        setClaims(list.claims);
      }
      setError('');
    } catch (err) {
      handle(err);
    }
  }, [scope, status, handle]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(work: () => Promise<ClaimDetail>) {
    setBusy(true);
    try {
      const detail = await work();
      setOpen(detail);
      await load();
    } catch (err) {
      handle(err);
    } finally {
      setBusy(false);
    }
  }

  const row = (c: ExpenseClaim) => (
    <button key={c.id} type="button" className={`item item--button ${open?.claim.id === c.id ? 'is-open' : ''}`} onClick={() => void api.claim(c.id).then(setOpen, handle)}>
      <div className="item__main">
        <div>
          <span className="mono table__id">{c.number}</span> {c.title}
        </div>
        <div className="mono item__meta">
          {scope === 'office' ? `${c.employee_name} · ` : ''}
          {c.submitted_at.slice(0, 10)} · {c.counts.trips + c.counts.mileage + c.counts.receipts} ITEM(S)
          {c.handed_over_ref ? ` · ${c.handed_over_ref}` : ''}
        </div>
      </div>
      <ClaimBadge status={c.status} />
      <div className="item__amount mono">{fmtEur(c.totals.total_cents)}</div>
    </button>
  );

  return (
    <div className="claims">
      {error && <div className="resource__error mono">{error}</div>}
      <div className="claims__list">
        {scope === 'office' && (
          <>
            <div className="section-title mono">TO DECIDE · {toDecide.length}</div>
            {toDecide.length === 0 && <div className="table__empty mono">Nothing waits for a decision.</div>}
            {toDecide.map(row)}
            <div className="toolbar">
              <select className="field__input field__input--narrow" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="approved">Approved</option>
                <option value="paid">Paid</option>
                <option value="submitted">Submitted</option>
                <option value="rejected">Returned</option>
                <option value="withdrawn">Withdrawn</option>
                <option value="">All</option>
              </select>
              {status === 'approved' && (
                <a className="btn btn--sm" href={expensesCsvUrl('approved')}>
                  PAYROLL CSV ↓
                </a>
              )}
            </div>
          </>
        )}
        {scope === 'mine' && claims.length === 0 && <div className="table__empty mono">No claims yet.</div>}
        {claims.map(row)}
      </div>

      {open && (
        <div className="claims__detail">
          <div className="section-title mono">
            {open.claim.number} · <ClaimBadge status={open.claim.status} />
          </div>
          <h2 className="claims__title">{open.claim.title}</h2>
          <div className="mono item__meta">
            {open.claim.employee_name} · {open.claim.per_diem_mode === '24h' ? 'PER DIEM BY 24 HOURS' : 'PER DIEM BY CALENDAR DAY'}
            {open.claim.payout_mode ? ` · PAID ${open.claim.payout_mode === 'payroll' ? 'WITH THE SALARY' : 'BY TRANSFER'}` : ''}
          </div>
          <div className="stat-row">
            <div className="stat">
              <div className="stat__label mono">PER DIEM + NIGHTS</div>
              <div className="stat__value">{fmtEur(open.claim.totals.per_diem_cents + open.claim.totals.nights_cents)}</div>
            </div>
            <div className="stat">
              <div className="stat__label mono">MILEAGE</div>
              <div className="stat__value">{fmtEur(open.claim.totals.mileage_cents)}</div>
            </div>
            <div className="stat">
              <div className="stat__label mono">RECEIPTS</div>
              <div className="stat__value">{fmtEur(open.claim.totals.receipts_cents)}</div>
            </div>
            <div className="stat">
              <div className="stat__label mono">TOTAL</div>
              <div className="stat__value">{fmtEur(open.claim.totals.total_cents)}</div>
            </div>
          </div>

          <div className="itemlist">
            {open.trips.map((t) => (
              <div key={`t${t.id}`} className="item">
                <div className="item__main">
                  <div>
                    Trip · {t.destination}
                    {t.country ? ` (${t.country})` : ''} — {t.purpose}
                  </div>
                  <div className="mono item__meta">
                    {fmtLocal(t.start_local)} – {fmtLocal(t.end_local)} ·{' '}
                    {t.periods.map((p) => `${p.twelfths}/12${p.meals ? ` −${p.meals} meal` : ''}`).join(', ')}
                    {t.nights_flat ? ` · ${t.nights_flat} × ${fmtEur(t.night_rate_cents)}` : ''}
                  </div>
                </div>
                <div className="item__amount mono">{fmtEur(t.total_cents)}</div>
              </div>
            ))}
            {open.mileage.map((m) => (
              <div key={`m${m.id}`} className="item">
                <div className="item__main">
                  <div>
                    Drive · {m.from_place} – {m.to_place} — {m.purpose}
                  </div>
                  <div className="mono item__meta">
                    {m.travel_date} · {fmtKm(m.km_tenths)} × {fmtEur(m.rate_cents)}
                    {m.passengers ? ` + ${m.passengers} × ${fmtEur(m.passenger_rate_cents)}` : ''}
                  </div>
                </div>
                <div className="item__amount mono">{fmtEur(m.amount_cents)}</div>
              </div>
            ))}
            {open.receipts.map((r) => (
              <div key={`r${r.id}`} className="item">
                <div className="item__main">
                  <div>
                    {r.merchant} · {CATEGORY_LABEL[r.category]}
                  </div>
                  <div className="mono item__meta">
                    {r.receipt_date}
                    {r.rksv ? ` · TILL ${r.rksv.cashbox_id} NO. ${r.rksv.receipt_id}` : ''}
                    {r.rksv?.signature_failed ? ' · SIGNATURE DEVICE DOWN' : ''}
                    {r.vat_cents !== null ? ` · VAT ${fmtEur(r.vat_cents)}` : ''}
                    {r.paid_by === 'company' ? ' · COMPANY CARD' : ''}
                    {r.file && (
                      <>
                        {' · '}
                        <a href={receiptFileUrl(r.id)} target="_blank" rel="noreferrer">
                          PICTURE ↗
                        </a>
                      </>
                    )}
                  </div>
                </div>
                <div className="item__amount mono">{fmtEur(r.reimbursable_cents)}</div>
              </div>
            ))}
          </div>

          <div className="section-title mono">HISTORY</div>
          <div className="itemlist">
            {open.events.map((e, i) => (
              <div key={i} className="item">
                <div className="item__main">
                  <div>
                    {EVENT_LABEL[e.type] ?? e.type} · {e.actor}
                  </div>
                  <div className="mono item__meta">
                    {e.at.replace('T', ' ').slice(0, 16)}
                    {e.note ? ` · ${e.note}` : ''}
                  </div>
                </div>
                <div className="item__amount mono">{fmtEur(e.total_cents)}</div>
              </div>
            ))}
          </div>
          {scope === 'office' && (
            <div className="mono item__meta">
              PAID TO: {open.bank_account ? `${open.bank_account.holder} · ${open.bank_account.iban_masked}` : 'NO BANK ACCOUNT ON FILE'}
            </div>
          )}

          <div className="claims__actions">
            {open.claim.can_decide && (
              <>
                <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void act(() => api.approveClaim(open.claim.id, null))}>
                  APPROVE
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    const note = window.prompt('Why is it returned? The person reads this.');
                    if (note && note.trim()) void act(() => api.rejectClaim(open.claim.id, note.trim()));
                  }}
                >
                  RETURN
                </button>
              </>
            )}
            {open.claim.can_withdraw && (
              <button type="button" className="btn" disabled={busy} onClick={() => window.confirm('Withdraw this claim? Its items become free again.') && void act(() => api.withdrawClaim(open.claim.id))}>
                WITHDRAW
              </button>
            )}
            {open.claim.can_mark_paid && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                title={open.claim.payout_mode === 'invoicing' ? 'Normally the invoicing module says so; mark it here only if it was paid another way' : undefined}
                onClick={() => {
                  const reference = window.prompt('Paid with — e.g. "Payroll 10/2026" (optional)', '');
                  if (reference !== null) void act(() => api.markClaimPaid(open.claim.id, reference.trim() || null));
                }}
              >
                MARK PAID
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
