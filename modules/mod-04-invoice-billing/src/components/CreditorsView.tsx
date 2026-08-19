import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { CreditorRow, FieldError } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtEur } from '../format';

/**
 * CREDITORS — the people we pay, and the accounts we pay them into.
 *
 * The IBAN is the whole point of the screen, so the server checks its country,
 * length and check digits before it is ever stored and the message comes back
 * onto the field. It is the last moment a typo is free: after a payment file
 * has been uploaded, a wrong IBAN is a recall request and a lawyer.
 */

interface Props {
  onAuthLost: () => void;
}

interface FormState {
  id: number | null;
  name: string;
  iban: string;
  bic: string;
  note: string;
}

const EMPTY: FormState = { id: null, name: '', iban: '', bic: '', note: '' };

export function CreditorsView({ onAuthLost }: Props) {
  const [rows, setRows] = useState<CreditorRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { creditors } = await api.creditors(search.trim() || undefined);
      setRows(creditors);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load creditors');
    }
  }, [search, onAuthLost]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
  }, [load]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setFormError('');
    setFieldErrors([]);
    try {
      const values = {
        name: form.name,
        iban: form.iban,
        bic: form.bic.trim() || null,
        note: form.note.trim() || null,
      };
      if (form.id === null) await api.createCreditor(values);
      else await api.updateCreditor(form.id, values);
      setForm(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      setFormError(err instanceof Error ? err.message : 'Request failed');
      if (err instanceof ApiError) setFieldErrors(err.details);
    } finally {
      setBusy(false);
    }
  }

  async function remove(creditor: CreditorRow): Promise<void> {
    if (!window.confirm(`Delete ${creditor.name}?`)) return;
    try {
      await api.deleteCreditor(creditor.id);
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
          <div className="resource__eyebrow mono">§ INV.05 · MASTER DATA</div>
          <h1 className="resource__title">Creditors</h1>
          <p className="resource__desc">
            Who we pay, and into which account. IBANs are validated on entry — country, length and check
            digits.
          </p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--primary" onClick={() => setForm({ ...EMPTY })}>
            + NEW CREDITOR
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <input
          className="field__input toolbar__search"
          placeholder="Search name or IBAN…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="toolbar__count mono">{rows ? `${rows.length} CREDITORS` : ''}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">NAME</th>
              <th className="mono">IBAN</th>
              <th className="mono">BIC</th>
              <th className="mono">BILLS</th>
              <th className="mono table__num">STILL OWED</th>
              <th className="mono">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="mono table__id">{c.iban}</td>
                <td className="mono table__id">{c.bic ?? '—'}</td>
                <td className="table__num mono">{c.bill_count}</td>
                <td className="table__num">{fmtEur(c.open_cents)}</td>
                <td>
                  <div className="table__rowactions">
                    <button
                      className="rowbtn mono"
                      onClick={() =>
                        setForm({
                          id: c.id,
                          name: c.name,
                          iban: c.iban,
                          bic: c.bic ?? '',
                          note: c.note ?? '',
                        })
                      }
                    >
                      EDIT
                    </button>
                    <button
                      className="rowbtn rowbtn--danger mono"
                      disabled={c.bill_count > 0}
                      title={c.bill_count > 0 ? 'Creditors with bills cannot be deleted' : undefined}
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
                  NO CREDITORS MATCH
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
            <div className="modal__eyebrow mono">{form.id === null ? 'NEW CREDITOR' : 'EDIT CREDITOR'}</div>
            <h2 className="modal__title">{form.id === null ? 'Create creditor' : form.name}</h2>
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
                <span className="field__label mono">
                  IBAN <span className="field__req">*</span>
                </span>
                <input
                  className="field__input mono"
                  placeholder="AT61 1904 3002 3457 3201"
                  value={form.iban}
                  onChange={(e) => setForm({ ...form, iban: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field__label mono">BIC</span>
                <input
                  className="field__input mono"
                  placeholder="optional inside the EEA"
                  value={form.bic}
                  onChange={(e) => setForm({ ...form, bic: e.target.value })}
                />
              </label>
              <label className="field" style={{ gridColumn: '1 / -1' }}>
                <span className="field__label mono">NOTE</span>
                <textarea
                  className="field__input"
                  rows={2}
                  value={form.note}
                  onChange={(e) => setForm({ ...form, note: e.target.value })}
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
