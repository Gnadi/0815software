import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { FieldError, SupplierRow } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDate } from '../format';

interface Props {
  onAuthLost: () => void;
}

interface FormState {
  id: number | null;
  name: string;
  contact: string;
  email: string;
  notes: string;
}

const EMPTY: FormState = { id: null, name: '', contact: '', email: '', notes: '' };

export function SuppliersView({ onAuthLost }: Props) {
  const [rows, setRows] = useState<SupplierRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { suppliers } = await api.suppliers(search.trim() || undefined);
      setRows(suppliers);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load suppliers');
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
        contact: form.contact.trim() || null,
        email: form.email.trim() || null,
        notes: form.notes.trim() || null,
      };
      if (form.id === null) await api.createSupplier(values);
      else await api.updateSupplier(form.id, values);
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

  async function remove(supplier: SupplierRow) {
    if (!window.confirm(`Delete ${supplier.name}?`)) return;
    try {
      await api.deleteSupplier(supplier.id);
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
          <div className="resource__eyebrow mono">§ PRC.03 · MASTER DATA</div>
          <h1 className="resource__title">Suppliers</h1>
          <p className="resource__desc">Who you invite to RFQs and order from — name, contact, email, notes.</p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--primary" onClick={() => setForm({ ...EMPTY })}>
            + NEW SUPPLIER
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <input
          className="field__input toolbar__search"
          placeholder="Search name, contact, email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="toolbar__count mono">{rows ? `${rows.length} SUPPLIERS` : ''}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">NAME</th>
              <th className="mono">CONTACT</th>
              <th className="mono">EMAIL</th>
              <th className="mono">RFQS</th>
              <th className="mono">POS</th>
              <th className="mono">SINCE</th>
              <th className="mono">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td className="table__id">{s.contact ?? '—'}</td>
                <td className="table__id">{s.email ?? '—'}</td>
                <td className="table__num mono">{s.rfq_count}</td>
                <td className="table__num mono">{s.po_count}</td>
                <td className="mono table__id">{fmtDate(s.created_at)}</td>
                <td>
                  <div className="table__rowactions">
                    <button
                      className="rowbtn mono"
                      onClick={() =>
                        setForm({
                          id: s.id,
                          name: s.name,
                          contact: s.contact ?? '',
                          email: s.email ?? '',
                          notes: s.notes ?? '',
                        })
                      }
                    >
                      EDIT
                    </button>
                    <button
                      className="rowbtn rowbtn--danger mono"
                      disabled={s.rfq_count > 0 || s.po_count > 0}
                      title={
                        s.rfq_count > 0 || s.po_count > 0
                          ? 'Suppliers referenced by RFQs or POs cannot be deleted'
                          : undefined
                      }
                      onClick={() => void remove(s)}
                    >
                      DELETE
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={7}>
                  NO SUPPLIERS MATCH
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
            <div className="modal__eyebrow mono">{form.id === null ? 'NEW SUPPLIER' : 'EDIT SUPPLIER'}</div>
            <h2 className="modal__title">{form.id === null ? 'Create supplier' : form.name}</h2>
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
                <span className="field__label mono">CONTACT</span>
                <input
                  className="field__input"
                  value={form.contact}
                  onChange={(e) => setForm({ ...form, contact: e.target.value })}
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
              <label className="field" style={{ gridColumn: '1 / -1' }}>
                <span className="field__label mono">NOTES</span>
                <textarea
                  className="field__input"
                  rows={3}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
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
