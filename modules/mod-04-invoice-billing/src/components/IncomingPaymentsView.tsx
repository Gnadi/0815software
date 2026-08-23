import { useCallback, useEffect, useState } from 'react';
import type { ReceivableProposal, ReceivableSuggestions, UnmatchedReceivable } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtEur } from '../format';

/**
 * INCOMING PAYMENTS — money that arrived, against invoices that are open.
 *
 * **This screen is a convenience, and the module works without it.** Recording
 * a payment on the invoice itself is the primary path and always will be; a
 * deployment with no bank connection simply never sees this list, and nothing
 * about getting paid depends on having one.
 *
 * What it removes is the typing. The bank knows exactly what arrived; matching
 * it to an invoice is guesswork of varying quality, so every row says HOW it
 * was matched and nothing is recorded until a person ticks it. A payment
 * booked against the wrong invoice is two wrong balances and a customer chased
 * for money they already paid — which is worse than typing.
 */

const REASON_LABEL: Record<ReceivableProposal['reason'], string> = {
  creditor_reference: 'Payer used the structured reference',
  end_to_end_id: 'Reference from the payment instruction',
  remittance_number: 'Invoice number in the payment text',
  customer_and_amount: 'Customer name and amount match',
  amount_only: 'Only open invoice for this amount',
};

/** How much attention a row deserves. The last two are worth reading. */
const REASON_WEAK: Record<ReceivableProposal['reason'], boolean> = {
  creditor_reference: false,
  end_to_end_id: false,
  remittance_number: false,
  customer_and_amount: true,
  amount_only: true,
};

const UNMATCHED_LABEL: Record<UnmatchedReceivable['why'], string> = {
  debit: 'Money out — not a receivable',
  reversal: 'A reversal of an earlier booking',
  already_applied: 'Already recorded',
  no_candidate: 'No open invoice fits',
  ambiguous: 'Several invoices fit — needs a decision',
};

/** The two that are an operator's problem; the rest are just noise. */
function needsAttention(why: UnmatchedReceivable['why']): boolean {
  return why === 'no_candidate' || why === 'ambiguous';
}

export function IncomingPaymentsView({ onAuthLost }: { onAuthLost: () => void }) {
  const [data, setData] = useState<ReceivableSuggestions | null>(null);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  const load = useCallback(async () => {
    setError('');
    setUnavailable('');
    try {
      const result = await api.receivableSuggestions();
      setData(result);
      // Everything a rule was confident about starts ticked; the weak matches
      // do not, so confirming the lot cannot silently accept a guess.
      setChosen(new Set(result.proposals.filter((p) => !REASON_WEAK[p.reason]).map(keyOf)));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      // 501 is the standalone posture, not a failure — say so in those words.
      if (err instanceof ApiError && err.status === 501) return setUnavailable(err.message);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (key: string): void => {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const confirm = async (): Promise<void> => {
    if (data === null || chosen.size === 0) return;
    setBusy(true);
    setError('');
    try {
      const { outcomes } = await api.applyReceivables(
        data.proposals
          .filter((p) => chosen.has(keyOf(p)))
          .map((p) => ({
            booking_key: p.booking.key,
            invoice_id: p.invoice.id,
            amount_cents: p.amount_cents,
            date: p.booking.booking_date ?? new Date().toISOString().slice(0, 10),
            note: p.booking.counterparty_name ?? undefined,
          })),
      );
      const recorded = outcomes.filter((o) => o.status === 'recorded').length;
      const refused = outcomes.filter((o) => o.status === 'refused');
      setDone(
        `${recorded} payment${recorded === 1 ? '' : 's'} recorded` +
          (refused.length > 0 ? ` — ${refused.length} refused: ${refused[0]!.message ?? ''}` : ''),
      );
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (unavailable !== '') {
    return (
      <section>
        <h2>Incoming payments</h2>
        <p className="muted">{unavailable}</p>
        <p className="muted">
          Nothing is missing — a bank connection only saves the typing. Open an invoice and record the payment
          there, exactly as usual.
        </p>
      </section>
    );
  }

  if (error !== '') return <p className="error">{error}</p>;
  if (data === null) return <p className="muted">Loading…</p>;

  const attention = data.unmatched.filter((u) => needsAttention(u.why));

  return (
    <section>
      <h2>Incoming payments</h2>
      {done !== '' && <p className="notice">{done}</p>}

      {data.proposals.length === 0 ? (
        <p className="muted">Nothing to place — every arrival is either recorded or has no open invoice.</p>
      ) : (
        <>
          <p className="muted">
            Nothing here is recorded until you confirm it. The two weakest kinds of match start unticked.
          </p>
          <table>
            <thead>
              <tr>
                <th />
                <th>Received</th>
                <th>From</th>
                <th>Invoice</th>
                <th>Matched on</th>
                <th className="num">Apply</th>
              </tr>
            </thead>
            <tbody>
              {data.proposals.map((p) => (
                <tr key={keyOf(p)} className={REASON_WEAK[p.reason] ? 'weak' : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      checked={chosen.has(keyOf(p))}
                      onChange={() => toggle(keyOf(p))}
                      aria-label={`Record ${fmtEur(p.amount_cents)} against ${p.invoice.number}`}
                    />
                  </td>
                  <td>
                    {fmtEur(p.booking.amount_cents)}
                    <br />
                    <span className="muted">{p.booking.booking_date ?? ''}</span>
                  </td>
                  <td>
                    {p.booking.counterparty_name ?? '—'}
                    {p.booking.remittance !== null && (
                      <>
                        <br />
                        <span className="muted">{p.booking.remittance}</span>
                      </>
                    )}
                  </td>
                  <td>
                    {p.invoice.number}
                    <br />
                    <span className="muted">
                      {p.invoice.customer_name} · {fmtEur(p.invoice.open_cents)} open
                    </span>
                  </td>
                  <td>{REASON_LABEL[p.reason]}</td>
                  <td className="num">
                    {fmtEur(p.amount_cents)}
                    {!p.settles_invoice && <div className="muted">part payment</div>}
                    {!p.uses_whole_booking && <div className="muted">rest of the transfer stays open</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" onClick={() => void confirm()} disabled={busy || chosen.size === 0}>
            {busy ? 'Recording…' : `Record ${chosen.size} payment${chosen.size === 1 ? '' : 's'}`}
          </button>
        </>
      )}

      {attention.length > 0 && (
        <>
          <h3>Needs a decision ({attention.length})</h3>
          <p className="muted">
            These arrived and nothing could be proposed. Record them on the invoice by hand.
          </p>
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>From</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {attention.map((u) => (
                <tr key={u.booking.key}>
                  <td>
                    {fmtEur(u.booking.amount_cents)}
                    <br />
                    <span className="muted">{u.booking.booking_date ?? ''}</span>
                  </td>
                  <td>
                    {u.booking.counterparty_name ?? '—'}
                    {u.booking.remittance !== null && (
                      <>
                        <br />
                        <span className="muted">{u.booking.remittance}</span>
                      </>
                    )}
                  </td>
                  <td>{UNMATCHED_LABEL[u.why]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

/** One booking may propose against several invoices, so the pair is the key. */
function keyOf(p: ReceivableProposal): string {
  return `${p.booking.key}::${p.invoice.id}`;
}
