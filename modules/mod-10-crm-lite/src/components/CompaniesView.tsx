import { useCallback, useEffect, useState } from 'react';
import type { Company, CompanyRow } from '../../shared/types';
import { api, ApiError } from '../api';
import { Field, Modal } from './ui';

export function CompaniesView({
  onOpen,
  onAuthLost,
}: {
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}) {
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setCompanies((await api.companies(search || undefined)).companies);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load companies');
    }
  }, [search, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">COMPANIES</div>
          <h1 className="resource__title">Accounts</h1>
        </div>
        <div className="resource__actions">
          <button className="btn btn--primary" onClick={() => setCreating(true)}>
            + NEW COMPANY
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <input
          className="field__input toolbar__search"
          placeholder="Search name or domain…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="toolbar__count mono">{companies.length} COMPANIES</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>NAME</th>
              <th>DOMAIN</th>
              <th>CONTACTS</th>
              <th>DEALS</th>
            </tr>
          </thead>
          <tbody>
            {companies.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={4}>
                  NO COMPANIES
                </td>
              </tr>
            )}
            {companies.map((c) => (
              <tr key={c.id}>
                <td>
                  <button className="linklike" onClick={() => onOpen(c.id)}>
                    {c.name}
                  </button>
                </td>
                <td className="note-cell">{c.domain ?? '—'}</td>
                <td className="table__num">{c.contact_count}</td>
                <td className="table__num">{c.deal_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && (
        <CompanyEditor
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            onOpen(id);
          }}
          onAuthLost={onAuthLost}
        />
      )}
    </div>
  );
}

export function CompanyEditor({
  company,
  onClose,
  onSaved,
  onAuthLost,
}: {
  company?: Company;
  onClose: () => void;
  onSaved: (id: number) => void;
  onAuthLost: () => void;
}) {
  const editing = company !== undefined;
  const [name, setName] = useState(company?.name ?? '');
  const [domain, setDomain] = useState(company?.domain ?? '');
  const [notes, setNotes] = useState(company?.notes ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError('');
    const payload = { name, domain: domain || null, notes: notes || null };
    try {
      const saved = editing ? await api.updateCompany(company!.id, payload) : await api.createCompany(payload);
      onSaved(saved.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Save failed');
      setBusy(false);
    }
  }

  return (
    <Modal
      eyebrow={editing ? 'EDIT COMPANY' : 'NEW COMPANY'}
      title={editing ? company!.name : 'Create a company'}
      error={error}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn--ghost" onClick={onClose} disabled={busy}>
            CANCEL
          </button>
          <button className="btn btn--primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'SAVING…' : 'SAVE'}
          </button>
        </>
      }
    >
      <div className="modal__fields">
        <Field label="NAME" required>
          <input className="field__input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="DOMAIN">
          <input className="field__input" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" />
        </Field>
      </div>
      <Field label="NOTES">
        <textarea className="field__input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </Modal>
  );
}
