import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { FieldError } from '../../shared/types';
import { api, ApiError, type CustomerRow } from '../api';
import { fmtDate } from '../format';

interface Props {
  onAuthLost: () => void;
}

interface FormState {
  id: number | null;
  name: string;
  contact_person: string;
  email: string;
  vat_id: string;
  address: string;
}

const EMPTY: FormState = { id: null, name: '', contact_person: '', email: '', vat_id: '', address: '' };

export function CustomersView({ onAuthLost }: Props) {
  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { customers } = await api.customers(search.trim() || undefined, showArchived);
      setRows(customers);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load customers');
    }
  }, [search, showArchived, onAuthLost]);

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
        contact_person: form.contact_person.trim() || null,
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

  async function act(action: () => Promise<unknown>) {
    try {
      await action();
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Request failed');
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ OFF.02 · MASTER DATA</div>
          <h1 className="resource__title">Customers</h1>
          <p className="resource__desc">Name, contact person, address, email, VAT id. Customers with offers are archived, never deleted.</p>
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
          placeholder="Search name, contact, email, VAT id…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          className="toolbar__clear mono"
          onClick={() => setShowArchived((v) => !v)}
          style={showArchived ? { color: 'var(--fg)', borderColor: 'var(--line-strong)' } : undefined}
        >
          {showArchived ? 'HIDE ARCHIVED' : 'SHOW ARCHIVED'}
        </button>
        <span className="toolbar__count mono">{rows ? `${rows.length} CUSTOMERS` : ''}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">NAME</th>
              <th className="mono">CONTACT</th>
              <th className="mono">EMAIL</th>
              <th className="mono">VAT ID</th>
              <th className="mono">OFFERS</th>
              <th className="mono">SINCE</th>
              <th className="mono">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((c) => (
              <tr key={c.id} className={c.archived_at ? 'is-superseded' : ''}>
                <td>
                  {c.name}
                  {c.archived_at && <span className="badge mono badge--withdrawn" style={{ marginLeft: 8 }}>ARCHIVED</span>}
                </td>
                <td className="table__id">{c.contact_person ?? '—'}</td>
                <td className="table__id">{c.email ?? '—'}</td>
                <td className="mono table__id">{c.vat_id ?? '—'}</td>
                <td className="table__num mono">{c.offer_count}</td>
                <td className="mono table__id">{fmtDate(c.created_at)}</td>
                <td>
                  <div className="table__rowactions">
                    <button
                      className="rowbtn mono"
                      onClick={() =>
                        setForm({
                          id: c.id,
                          name: c.name,
                          contact_person: c.contact_person ?? '',
                          email: c.email ?? '',
                          vat_id: c.vat_id ?? '',
                          address: c.address ?? '',
                        })
                      }
                    >
                      EDIT
                    </button>
                    {c.archived_at ? (
                      <button className="rowbtn mono" onClick={() => void act(() => api.unarchiveCustomer(c.id))}>
                        UNARCHIVE
                      </button>
                    ) : c.offer_count > 0 ? (
                      <button className="rowbtn mono" onClick={() => void act(() => api.archiveCustomer(c.id))}>
                        ARCHIVE
                      </button>
                    ) : (
                      <button
                        className="rowbtn rowbtn--danger mono"
                        onClick={() => {
                          if (window.confirm(`Delete ${c.name}?`)) void act(() => api.deleteCustomer(c.id));
                        }}
                      >
                        DELETE
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={7}>
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
                <span className="field__label mono">CONTACT PERSON</span>
                <input
                  className="field__input"
                  value={form.contact_person}
                  onChange={(e) => setForm({ ...form, contact_person: e.target.value })}
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
