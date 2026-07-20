import { useCallback, useEffect, useState } from 'react';
import type { PublicOffer as Offer } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDate, fmtEur, fmtQty } from '../format';

interface Props {
  refId: string;
  token: string;
}

/**
 * The public acceptance page served on /offer/:ref?token=… — no login.
 * A valid token shows the offer read-only and, while it is still open,
 * lets the customer accept or reject it. A missing/wrong/foreign token
 * is a 404, exactly like an unknown offer.
 */
export function PublicOffer({ refId, token }: Props) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      setOffer(await api.publicOffer(refId, token));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else setError(err instanceof Error ? err.message : 'Failed to load offer');
    }
  }, [refId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(kind: 'accept' | 'reject') {
    setBusy(true);
    setError('');
    try {
      const result =
        kind === 'accept'
          ? await api.publicAccept(refId, token, note.trim())
          : await api.publicReject(refId, token, note.trim());
      setOffer(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  if (notFound) {
    return (
      <div className="public">
        <div className="public__brand">
          <span className="public__mono">0815</span>
        </div>
        <h1 className="public__title">Offer not found</h1>
        <p className="public__intro">
          This acceptance link is invalid or has expired. Please check the link in your email, or contact us for a
          fresh copy.
        </p>
      </div>
    );
  }
  if (error && !offer) return <div className="boot mono">{error}</div>;
  if (!offer) return <div className="boot mono">LOADING…</div>;

  return (
    <div className="public">
      <div className="public__brand">
        <span className="public__mono">0815</span>
        <span className="public__seller">{offer.seller_name.toUpperCase()}</span>
      </div>

      <h1 className="public__title">{offer.title}</h1>
      <div className="public__meta">
        {offer.number} · FOR {offer.customer_name.toUpperCase()} · VALID UNTIL {fmtDate(offer.valid_until)}
      </div>

      {offer.intro && <p className="public__intro">{offer.intro}</p>}

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

      <div className="totals">
        {offer.discount_cents > 0 && (
          <div className="totals__row totals__row--discount mono">
            <span>LINE DISCOUNTS</span>
            <span className="table__num">{fmtEur(-offer.discount_cents)}</span>
          </div>
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
                VAT {r.rate}% OF {fmtEur(r.base_cents)}
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
          <p className="public__intro">{offer.terms}</p>
        </>
      )}

      {error && <div className="resource__error mono" style={{ marginTop: 24 }}>{error}</div>}

      {offer.decidable ? (
        <div className="public__decision">
          <label className="field" style={{ flex: 1, minWidth: 220 }}>
            <span className="field__label mono">MESSAGE (OPTIONAL)</span>
            <input className="field__input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button className="btn btn--danger" disabled={busy} onClick={() => void decide('reject')}>
            DECLINE
          </button>
          <button className="btn btn--primary" disabled={busy} onClick={() => void decide('accept')}>
            ACCEPT OFFER →
          </button>
        </div>
      ) : (
        <div className="public__result mono">
          {offer.status === 'accepted' && 'You have accepted this offer. Thank you — we will be in touch shortly.'}
          {offer.status === 'rejected' && 'You have declined this offer. Thank you for letting us know.'}
          {offer.expired && `This offer expired on ${fmtDate(offer.valid_until)} and can no longer be accepted.`}
          {offer.status === 'withdrawn' && 'This offer has been withdrawn by the seller.'}
          {offer.status === 'superseded' && 'This offer has been replaced by a newer version.'}
        </div>
      )}
    </div>
  );
}
