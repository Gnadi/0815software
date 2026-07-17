import { useCallback, useEffect, useState } from 'react';
import type { InvoiceRow } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDate, fmtEur } from '../format';
import { PaymentBadge, StatusBadge } from './StatusBadge';

interface Props {
  onOpen: (id: number) => void;
  onNew: () => void;
  onAuthLost: () => void;
}

const FILTERS = [
  { value: '', label: 'ALL' },
  { value: 'draft', label: 'DRAFT' },
  { value: 'sent', label: 'SENT' },
  { value: 'paid', label: 'PAID' },
  { value: 'cancelled', label: 'CANCELLED' },
  { value: 'overdue', label: 'OVERDUE' },
];

export function InvoicesView({ onOpen, onNew, onAuthLost }: Props) {
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (filter === 'overdue') params.set('overdue', '1');
      else if (filter) params.set('status', filter);
      const { invoices } = await api.invoices(params);
      setRows(invoices);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load invoices');
    }
  }, [search, filter, onAuthLost]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.01 · BILLING</div>
          <h1 className="resource__title">Invoices</h1>
          <p className="resource__desc">draft → sent → paid; cancellations keep their number.</p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--primary" onClick={onNew}>
            + NEW DRAFT
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <input
          className="field__input toolbar__search"
          placeholder="Search number or customer…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="field__input toolbar__filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <span className="toolbar__count mono">{rows ? `${rows.length} INVOICES` : ''}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">NUMBER</th>
              <th className="mono">CUSTOMER</th>
              <th className="mono">STATUS</th>
              <th className="mono">ISSUED</th>
              <th className="mono">DUE</th>
              <th className="mono" style={{ textAlign: 'right' }}>NET</th>
              <th className="mono" style={{ textAlign: 'right' }}>GROSS</th>
              <th className="mono" style={{ textAlign: 'right' }}>PAID</th>
              <th className="mono">PAYMENT</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((inv) => (
              <tr key={inv.id} className={inv.overdue ? 'is-overdue' : ''} onClick={() => onOpen(inv.id)}>
                <td className="mono">
                  <button className="linklike mono" onClick={() => onOpen(inv.id)}>
                    {inv.number ?? `DRAFT #${inv.id}`}
                  </button>
                </td>
                <td>{inv.customer_name}</td>
                <td>
                  <StatusBadge status={inv.status} overdue={inv.overdue} />
                </td>
                <td className="mono table__id">{inv.issue_date ? fmtDate(inv.issue_date) : '—'}</td>
                <td className="mono table__id">{inv.due_date ? fmtDate(inv.due_date) : '—'}</td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>{fmtEur(inv.net_cents)}</td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>{fmtEur(inv.gross_cents)}</td>
                <td className="table__num mono" style={{ textAlign: 'right' }}>{fmtEur(inv.paid_cents)}</td>
                <td>{inv.status === 'sent' || inv.status === 'paid' ? <PaymentBadge status={inv.payment_status} /> : '—'}</td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={9}>
                  NO INVOICES MATCH
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
