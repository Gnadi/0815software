import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { FieldError } from '../../shared/types';
import { api, ApiError, type CustomerRow } from '../api';
import { fmtDate } from '../format';

interface Props {
  onOpenLedger: (id: number) => void;
  onAuthLost: () => void;
}

interface FormState {
  id: number | null;
  name: string;
  email: string;
  vat_id: string;
  address: string;
}

const EMPTY: FormState = { id: null, name: '', email: '', vat_id: '', address: '' };

export function CustomersView({ onOpenLedger, onAuthLost }: Props) {
  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { customers } = await api.customers(search.trim() || undefined);
      setRows(customers);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load customers');
    }
  }, [search, onAuthLost]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setFormError('');
    setFieldErrors([]);
    try {
      const values = {
        name: form.name,
        email: form.email.trim() || null,
        vat_id: form.vat_id.trim() || null,
        address: form.address.trim() || null,
      };
      if (form.id === null) await api.createCustomer(values);
      else await api.updateCustomer(form.id, values);
      setForm(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      if (err instanceof ApiError) {
        setFormError(err.message);
        setFieldErrors(err.details);
      } else {
        setFormError('Request failed');
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(customer: CustomerRow) {
    if (!window.confirm(`Delete ${customer.name}?`)) return;
    try {
      await api.deleteCustomer(customer.id);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.02 · MASTER DATA</div>
          <h1 className="resource__title">Customers</h1>
          <p className="resource__desc">Name, address, email, VAT id — and a full statement per customer.</p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--primary" onClick={() => setForm({ ...EMPTY })}>
            + NEW CUSTOMER
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <input
          className="field__input toolbar__search"
          placeholder="Search name, email, VAT id…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="toolbar__count mono">{rows ? `${rows.length} CUSTOMERS` : ''}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">NAME</th>
              <th className="mono">EMAIL</th>
              <th className="mono">VAT ID</th>
              <th className="mono">INVOICES</th>
              <th className="mono">SINCE</th>
              <th className="mono">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((c) => (
              <tr key={c.id}>
                <td>
                  <button className="linklike" onClick={() => onOpenLedger(c.id)}>
                    {c.name}
                  </button>
                </td>
                <td className="table__id">{c.email ?? '—'}</td>
                <td className="mono table__id">{c.vat_id ?? '—'}</td>
                <td className="table__num mono">{c.invoice_count}</td>
                <td className="mono table__id">{fmtDate(c.created_at)}</td>
                <td>
                  <div className="table__rowactions">
                    <button className="rowbtn mono" onClick={() => onOpenLedger(c.id)}>
                      LEDGER
                    </button>
                    <button
                      className="rowbtn mono"
                      onClick={() =>
                        setForm({
                          id: c.id,
                          name: c.name,
                          email: c.email ?? '',
                          vat_id: c.vat_id ?? '',
                          address: c.address ?? '',
                        })
                      }
                    >
                      EDIT
                    </button>
                    <button
                      className="rowbtn rowbtn--danger mono"
                      disabled={c.invoice_count > 0}
                      title={c.invoice_count > 0 ? 'Customers with invoices cannot be deleted' : undefined}
                      onClick={() => void remove(c)}
                    >
                      DELETE
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={6}>
                  NO CUSTOMERS MATCH
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {form && (
        <div className="modal">
          <div className="modal__backdrop" onClick={() => setForm(null)} />
          <form className="modal__card" onSubmit={(e) => void submit(e)}>
            <div className="modal__eyebrow mono">{form.id === null ? 'NEW CUSTOMER' : 'EDIT CUSTOMER'}</div>
            <h2 className="modal__title">{form.id === null ? 'Create customer' : form.name}</h2>
            {formError && <div className="modal__error mono">{formError}</div>}
            {fieldErrors.length > 0 && (
              <div className="modal__error mono">
                {fieldErrors.map((e) => `${e.field}: ${e.message}`).join(' · ')}
              </div>
            )}
            <div className="modal__fields">
              <label className="field" style={{ gridColumn: '1 / -1' }}>
                <span className="field__label mono">
                  NAME <span className="field__req">*</span>
                </span>
                <input
                  className="field__input"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  autoFocus
                />
              </label>
              <label className="field">
                <span className="field__label mono">EMAIL</span>
                <input
                  className="field__input"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field__label mono">VAT ID</span>
                <input
                  className="field__input"
                  value={form.vat_id}
                  onChange={(e) => setForm({ ...form, vat_id: e.target.value })}
                />
              </label>
              <label className="field" style={{ gridColumn: '1 / -1' }}>
                <span className="field__label mono">ADDRESS</span>
                <textarea
                  className="field__input"
                  rows={3}
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                />
              </label>
            </div>
            <div className="modal__actions">
              <button className="btn btn--ghost" type="button" onClick={() => setForm(null)}>
                CANCEL
              </button>
              <button className="btn btn--primary" type="submit" disabled={busy}>
                {busy ? 'SAVING…' : 'SAVE →'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
