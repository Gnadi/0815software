import { useCallback, useEffect, useState } from 'react';
import type { CompanyRow, ContactRow } from '../../shared/types';
import { api, ApiError } from '../api';
import { Field, Modal } from './ui';

export function ContactsView({
  onOpen,
  onAuthLost,
}: {
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}) {
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      setContacts((await api.contacts(params)).contacts);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load contacts');
    }
  }, [search, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">CONTACTS</div>
          <h1 className="resource__title">People</h1>
        </div>
        <div className="resource__actions">
          <button className="btn btn--primary" onClick={() => setCreating(true)}>
            + NEW CONTACT
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <input
          className="field__input toolbar__search"
          placeholder="Search name, email, title…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="toolbar__count mono">{contacts.length} CONTACTS</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>NAME</th>
              <th>TITLE</th>
              <th>COMPANY</th>
              <th>EMAIL</th>
              <th>DEALS</th>
              <th>OPEN FOLLOW-UPS</th>
            </tr>
          </thead>
          <tbody>
            {contacts.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={6}>
                  NO CONTACTS
                </td>
              </tr>
            )}
            {contacts.map((c) => (
              <tr key={c.id}>
                <td>
                  <button className="linklike" onClick={() => onOpen(c.id)}>
                    {c.name}
                  </button>
                </td>
                <td className="note-cell">{c.title ?? '—'}</td>
                <td>{c.company_name ?? '—'}</td>
                <td className="note-cell">{c.email ?? '—'}</td>
                <td className="table__num">{c.deal_count}</td>
                <td className="table__num">{c.open_followup_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && (
        <ContactEditor
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

export function ContactEditor({
  contact,
  onClose,
  onSaved,
  onAuthLost,
}: {
  contact?: { id: number; name: string; email: string | null; phone: string | null; title: string | null; company_id: number | null };
  onClose: () => void;
  onSaved: (id: number) => void;
  onAuthLost: () => void;
}) {
  const editing = contact !== undefined;
  const [name, setName] = useState(contact?.name ?? '');
  const [email, setEmail] = useState(contact?.email ?? '');
  const [phone, setPhone] = useState(contact?.phone ?? '');
  const [title, setTitle] = useState(contact?.title ?? '');
  const [companyId, setCompanyId] = useState(contact?.company_id ? String(contact.company_id) : '');
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setCompanies((await api.companies()).companies);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  async function save() {
    setBusy(true);
    setError('');
    const payload = {
      name,
      email: email || null,
      phone: phone || null,
      title: title || null,
      company_id: companyId ? Number(companyId) : null,
    };
    try {
      const saved = editing ? await api.updateContact(contact!.id, payload) : await api.createContact(payload);
      onSaved(saved.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Save failed');
      setBusy(false);
    }
  }

  return (
    <Modal
      eyebrow={editing ? 'EDIT CONTACT' : 'NEW CONTACT'}
      title={editing ? contact!.name : 'Create a contact'}
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
        <Field label="TITLE">
          <input className="field__input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="EMAIL">
          <input className="field__input" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="PHONE">
          <input className="field__input" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="COMPANY">
          <select className="field__input" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">— none —</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}
