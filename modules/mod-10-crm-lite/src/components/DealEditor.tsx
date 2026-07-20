import { useEffect, useState } from 'react';
import type { AppConfig, CompanyRow, ContactRow, DealDetail } from '../../shared/types';
import { api, ApiError } from '../api';
import { centsToInput, parseEurToCents } from '../format';
import { Field, Modal, activeStages } from './ui';

export function DealEditor({
  config,
  deal,
  onClose,
  onSaved,
  onAuthLost,
}: {
  config: AppConfig;
  deal?: DealDetail;
  onClose: () => void;
  onSaved: (id: number) => void;
  onAuthLost: () => void;
}) {
  const editing = deal !== undefined;
  const [title, setTitle] = useState(deal?.title ?? '');
  const [companyId, setCompanyId] = useState<string>(deal ? String(deal.company_id) : '');
  const [contactId, setContactId] = useState<string>(
    deal?.primary_contact_id ? String(deal.primary_contact_id) : '',
  );
  const [value, setValue] = useState(deal ? centsToInput(deal.value_cents) : '');
  const [stage, setStage] = useState(deal?.stage ?? activeStages(config.stages)[0]!.key);
  const [note, setNote] = useState(deal?.note ?? '');
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setCompanies((await api.companies()).companies);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onAuthLost();
      }
    })();
  }, [onAuthLost]);

  useEffect(() => {
    if (!companyId) {
      setContacts([]);
      return;
    }
    void (async () => {
      try {
        const params = new URLSearchParams({ company_id: companyId });
        setContacts((await api.contacts(params)).contacts);
      } catch {
        setContacts([]);
      }
    })();
  }, [companyId]);

  async function save() {
    const cents = value.trim() === '' ? 0 : parseEurToCents(value);
    if (cents === null) {
      setError('Value must be a plain amount like 12000 or 12000.00');
      return;
    }
    setBusy(true);
    setError('');
    const payload: Record<string, unknown> = {
      title,
      company_id: Number(companyId),
      primary_contact_id: contactId ? Number(contactId) : null,
      value_cents: cents,
      note,
    };
    if (!editing) payload.stage = stage;
    try {
      const saved = editing ? await api.updateDeal(deal!.id, payload) : await api.createDeal(payload);
      onSaved(saved.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Save failed');
      setBusy(false);
    }
  }

  return (
    <Modal
      eyebrow={editing ? 'EDIT DEAL' : 'NEW DEAL'}
      title={editing ? deal!.title : 'Create a deal'}
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
        <Field label="TITLE" required>
          <input className="field__input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <Field label="VALUE (EUR)">
          <input className="field__input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0.00" />
        </Field>
        <Field label="COMPANY" required>
          <select className="field__input" value={companyId} onChange={(e) => { setCompanyId(e.target.value); setContactId(''); }}>
            <option value="">— select —</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="PRIMARY CONTACT">
          <select className="field__input" value={contactId} onChange={(e) => setContactId(e.target.value)} disabled={!companyId}>
            <option value="">— none —</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        {!editing && (
          <Field label="STARTING STAGE">
            <select className="field__input" value={stage} onChange={(e) => setStage(e.target.value)}>
              {activeStages(config.stages).map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <Field label="NOTE">
        <textarea className="field__input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}
