import { useCallback, useEffect, useState } from 'react';
import type { OfferDetail as Detail } from '../../shared/types';
import { api, ApiError, offerPdfUrl } from '../api';
import { fmtDate, fmtDateTime, fmtEur, fmtQty } from '../format';
import { StatusBadge } from './StatusBadge';

interface Props {
  id: number;
  onBack: () => void;
  onEdit: (id: number) => void;
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}

const EVENT_LABELS: Record<string, string> = {
  created: 'CREATED',
  sent: 'SENT',
  accepted: 'ACCEPTED',
  rejected: 'REJECTED',
  withdrawn: 'WITHDRAWN',
  superseded: 'SUPERSEDED',
  revised: 'REVISED',
};

export function OfferDetail({ id, onBack, onEdit, onOpen, onAuthLost }: Props) {
  const [offer, setOffer] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setOffer(await api.offerDetail(id));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load offer');
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

  if (error) return <div className="resource__error mono">{error}</div>;
  if (!offer) return <div className="boot mono">LOADING…</div>;

  const isDraft = offer.status === 'draft';
  const canDecide = offer.status === 'sent'; // not expired (derived), not decided
  const canWithdraw = offer.status === 'sent';
  const canRevise = ['sent', 'accepted', 'rejected', 'expired'].includes(offer.status);
  const publicUrl =
    offer.public_path !== null ? `${window.location.origin}${offer.public_path}` : null;

  async function copyLink() {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setActionError('Could not copy — select the link and copy it manually.');
    }
  }

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← ALL OFFERS
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ OFF.01 · SALES</div>
          <h1 className="resource__title">{offer.number ?? `Draft #${offer.id}`}</h1>
          <p className="resource__desc">
            {offer.title} · {offer.customer_name}
            {offer.valid_until && <> · valid until {fmtDate(offer.valid_until)}</>}
            {' · '}
            <StatusBadge status={offer.status} />
          </p>
        </div>
        <div className="resource__actions">
          <a className="btn btn--ghost" href={offerPdfUrl(offer.id)} target="_blank" rel="noreferrer">
            PDF ↓
          </a>
          {isDraft && (
            <>
              <button className="btn btn--ghost" onClick={() => onEdit(offer.id)}>
                EDIT
              </button>
              <button
                className="btn btn--ghost"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Delete this draft? Drafts have no number, so nothing is lost.')) {
                    void run(() => api.deleteDraft(offer.id), onBack);
                  }
                }}
              >
                DELETE
              </button>
              <button className="btn btn--primary" disabled={busy} onClick={() => void run(() => api.send(offer.id))}>
                SEND — ASSIGN NUMBER →
              </button>
            </>
          )}
          {canWithdraw && (
            <button className="btn btn--ghost" disabled={busy} onClick={() => setWithdrawing(true)}>
              WITHDRAW
            </button>
          )}
          {canRevise && (
            <button
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setActionError('');
                api
                  .revise(offer.id)
                  .then((rev) => onOpen(rev.id))
                  .catch((err: unknown) => {
                    if (err instanceof ApiError && err.status === 401) onAuthLost();
                    else setActionError(err instanceof Error ? err.message : 'Request failed');
                  })
                  .finally(() => setBusy(false));
              }}
            >
              CREATE REVISION
            </button>
          )}
          {canDecide && (
            <>
              <button
                className="btn btn--danger"
                disabled={busy}
                onClick={() => void run(() => api.reject(offer.id, 'Recorded by staff'))}
              >
                MARK REJECTED
              </button>
              <button
                className="btn btn--primary"
                disabled={busy}
                onClick={() => void run(() => api.accept(offer.id, 'Recorded by staff'))}
              >
                MARK ACCEPTED
              </button>
            </>
          )}
        </div>
      </div>

      {actionError && <div className="resource__error mono">{actionError}</div>}

      {offer.supersedes_number && (
        <div className="resource__notice mono">
          REVISION OF{' '}
          <button className="linklike" onClick={() => offer.supersedes_id && onOpen(offer.supersedes_id)}>
            {offer.supersedes_number}
          </button>
        </div>
      )}
      {offer.superseded_by_number && (
        <div className="resource__notice mono">
          SUPERSEDED BY{' '}
          <button className="linklike" onClick={() => offer.superseded_by_id && onOpen(offer.superseded_by_id)}>
            {offer.superseded_by_number}
          </button>
          {' '}— this offer keeps its number for the record.
        </div>
      )}

      {publicUrl && (offer.status === 'sent' || offer.status === 'expired') && (
        <>
          <div className="section-title mono">CUSTOMER ACCEPTANCE LINK</div>
          <p className="resource__desc" style={{ marginTop: 0 }}>
            This is the link you email the customer. It lets them view the offer and accept or reject it — no login.
          </p>
          <div className="linkbox">
            <span className="linkbox__url">{publicUrl}</span>
            <button className="rowbtn mono" onClick={() => void copyLink()}>
              {copied ? 'COPIED' : 'COPY'}
            </button>
            <a className="rowbtn mono" href={publicUrl} target="_blank" rel="noreferrer">
              OPEN ↗
            </a>
          </div>
        </>
      )}

      <div className="stat-row" style={{ marginTop: 24 }}>
        <div className="stat">
          <div className="stat__label mono">NET</div>
          <div className="stat__value">{fmtEur(offer.net_cents)}</div>
        </div>
        <div className="stat">
          <div className="stat__label mono">VAT</div>
          <div className="stat__value">{fmtEur(offer.vat_cents)}</div>
        </div>
        <div className="stat stat--total">
          <div className="stat__label mono">GROSS</div>
          <div className="stat__value">{fmtEur(offer.gross_cents)}</div>
        </div>
        {offer.discount_cents > 0 && (
          <div className="stat">
            <div className="stat__label mono">DISCOUNTS</div>
            <div className="stat__value">{fmtEur(offer.discount_cents)}</div>
          </div>
        )}
      </div>

      {offer.intro && (
        <>
          <div className="section-title mono">INTRODUCTION</div>
          <p className="resource__desc" style={{ marginTop: 0 }}>{offer.intro}</p>
        </>
      )}

      <div className="section-title mono">LINE ITEMS</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">POS</th>
              <th className="mono">DESCRIPTION</th>
              <th className="mono" style={{ textAlign: 'right' }}>QTY</th>
              <th className="mono" style={{ textAlign: 'right' }}>UNIT PRICE</th>
              <th className="mono" style={{ textAlign: 'right' }}>DISC</th>
              <th className="mono" style={{ textAlign: 'right' }}>VAT</th>
              <th className="mono" style={{ textAlign: 'right' }}>NET</th>
            </tr>
          </thead>
          <tbody>
            {offer.lines.map((line) => (
              <tr key={line.id}>
                <td className="mono table__id">{line.position}</td>
                <td>{line.description}</td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>{fmtQty(line.quantity)}</td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>{fmtEur(line.unit_price_cents)}</td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>
                  {line.discount_percent > 0 ? `${fmtQty(line.discount_percent)}%` : '—'}
                </td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>{line.vat_rate}%</td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>{fmtEur(line.net_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-title mono">VAT SUMMARY</div>
      <div className="totals">
        {offer.discount_cents > 0 && (
          <>
            <div className="totals__row mono">
              <span>SUBTOTAL</span>
              <span className="table__num">{fmtEur(offer.net_cents + offer.discount_cents)}</span>
            </div>
            <div className="totals__row totals__row--discount mono">
              <span>LINE DISCOUNTS</span>
              <span className="table__num">{fmtEur(-offer.discount_cents)}</span>
            </div>
          </>
        )}
        <div className="totals__row mono">
          <span>NET</span>
          <span className="table__num">{fmtEur(offer.net_cents)}</span>
        </div>
        {offer.vat_breakdown
          .filter((r) => r.rate > 0)
          .map((r) => (
            <div key={r.rate} className="totals__row mono">
              <span>
                {r.rate}% OF {fmtEur(r.base_cents)}
              </span>
              <span className="table__num">{fmtEur(r.vat_cents)}</span>
            </div>
          ))}
        <div className="totals__row totals__row--gross mono">
          <span>GROSS</span>
          <span className="table__num">{fmtEur(offer.gross_cents)}</span>
        </div>
      </div>

      {offer.terms && (
        <>
          <div className="section-title mono">TERMS</div>
          <p className="resource__desc" style={{ marginTop: 0 }}>{offer.terms}</p>
        </>
      )}

      <div className="section-title mono">STATUS TIMELINE</div>
      <div className="timeline">
        {offer.events.map((ev) => (
          <div key={ev.id} className="timeline__row">
            <span className="timeline__event">{EVENT_LABELS[ev.event] ?? ev.event.toUpperCase()}</span>
            <span className="timeline__actor">{ev.actor.toUpperCase()}</span>
            <span className="timeline__note">{ev.note ?? ''}</span>
            <span className="timeline__when">{fmtDateTime(ev.created_at)}</span>
          </div>
        ))}
      </div>

      {withdrawing && (
        <div className="modal">
          <div className="modal__backdrop" onClick={() => setWithdrawing(false)} />
          <form
            className="modal__card"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.withdraw(offer.id, reason), () => setWithdrawing(false));
            }}
          >
            <div className="modal__eyebrow mono">WITHDRAW {offer.number}</div>
            <h2 className="modal__title">Withdraw offer</h2>
            <p className="resource__desc" style={{ marginBottom: 16 }}>
              The number {offer.number} is kept forever — withdrawal is a status plus an audit event.
              To send a changed version, create a revision instead.
            </p>
            <label className="field" style={{ marginBottom: 20 }}>
              <span className="field__label mono">REASON</span>
              <input className="field__input" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            </label>
            <div className="modal__actions">
              <button className="btn btn--ghost" type="button" onClick={() => setWithdrawing(false)}>
                KEEP OFFER
              </button>
              <button className="btn btn--primary" type="submit" disabled={busy}>
                WITHDRAW OFFER →
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
