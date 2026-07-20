import { useCallback, useEffect, useState } from 'react';
import type { Ledger } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtEur } from '../format';

interface Props {
  id: number;
  onBack: () => void;
  onOpenInvoice: (id: number) => void;
  onAuthLost: () => void;
}

const TYPE_LABELS = { invoice: 'INVOICE', cancellation: 'CANCELLATION', payment: 'PAYMENT' } as const;

export function CustomerLedger({ id, onBack, onOpenInvoice, onAuthLost }: Props) {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setLedger(await api.customerLedger(id));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load ledger');
    }
  }, [id, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <div className="resource__error mono">{error}</div>;
  if (!ledger) return <div className="boot mono">LOADING…</div>;

  const { customer } = ledger;

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← ALL CUSTOMERS
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.02 · STATEMENT</div>
          <h1 className="resource__title">{customer.name}</h1>
          <p className="resource__desc">
            {[customer.vat_id, customer.email, customer.address?.split('\n').join(', ')]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="stat__label mono">INVOICED</div>
          <div className="stat__value">{fmtEur(ledger.invoiced_cents)}</div>
        </div>
        <div className="stat">
          <div className="stat__label mono">PAID</div>
          <div className="stat__value">{fmtEur(ledger.paid_cents)}</div>
        </div>
        <div className="stat stat--total">
          <div className="stat__label mono">OPEN BALANCE</div>
          <div className="stat__value">{fmtEur(ledger.balance_cents)}</div>
        </div>
      </div>

      <div className="section-title mono">STATEMENT · CHRONOLOGICAL, RUNNING BALANCE</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">DATE</th>
              <th className="mono">TYPE</th>
              <th className="mono">INVOICE</th>
              <th className="mono" style={{ textAlign: 'right' }}>AMOUNT</th>
              <th className="mono" style={{ textAlign: 'right' }}>BALANCE</th>
            </tr>
          </thead>
          <tbody>
            {ledger.entries.map((entry, i) => (
              <tr key={i}>
                <td className="mono table__id">{entry.date}</td>
                <td>
                  <span className={`movetype mono movetype--${entry.type}`}>{TYPE_LABELS[entry.type]}</span>
                </td>
                <td className="mono">
                  <button className="linklike mono" onClick={() => onOpenInvoice(entry.invoice_id)}>
                    {entry.number}
                  </button>
                </td>
                <td
                  className={`table__num mono ${entry.amount_cents < 0 ? 'qty-neg' : 'qty-pos'}`}
                  style={{ textAlign: 'right' }}
                >
                  {fmtEur(entry.amount_cents)}
                </td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>
                  {fmtEur(entry.balance_cents)}
                </td>
              </tr>
            ))}
            {ledger.entries.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={5}>
                  NO FINALIZED INVOICES YET
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
