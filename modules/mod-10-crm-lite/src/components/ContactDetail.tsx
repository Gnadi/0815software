import { useCallback, useEffect, useState } from 'react';
import type { AppConfig } from '../../shared/types';
import { api, ApiError, type ContactDetail } from '../api';
import { fmtDateTime, fmtEur } from '../format';
import { ActivityBadge, StageBadge } from './ui';
import { ActivityForm } from './ActivityForm';
import { ContactEditor } from './ContactsView';

export function ContactDetailView({
  id,
  config,
  onBack,
  onOpenDeal,
  onOpenCompany,
  onAuthLost,
}: {
  id: number;
  config: AppConfig;
  onBack: () => void;
  onOpenDeal: (id: number) => void;
  onOpenCompany: (id: number) => void;
  onAuthLost: () => void;
}) {
  const [contact, setContact] = useState<ContactDetail | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setContact(await api.contact(id));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load contact');
    }
  }, [id, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!contact) {
    return <div className="boot mono">{error || 'LOADING…'}</div>;
  }

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← BACK TO CONTACTS
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">CONTACT #{contact.id}</div>
          <h1 className="resource__title">{contact.name}</h1>
          <p className="resource__desc">
            {contact.title ?? 'No title'}
            {contact.company_id && contact.company_name && (
              <>
                {' · '}
                <button className="linklike" onClick={() => onOpenCompany(contact.company_id!)}>
                  {contact.company_name}
                </button>
              </>
            )}
          </p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--ghost" onClick={() => setEditing(true)}>
            EDIT
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="detail-grid">
        <div>
          <div className="section-title mono">LINKED DEALS</div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>DEAL</th>
                  <th>STAGE</th>
                  <th>VALUE</th>
                  <th>EXPECTED</th>
                </tr>
              </thead>
              <tbody>
                {contact.deals.length === 0 && (
                  <tr>
                    <td className="table__empty mono" colSpan={4}>
                      NO DEALS
                    </td>
                  </tr>
                )}
                {contact.deals.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <button className="linklike" onClick={() => onOpenDeal(d.id)}>
                        {d.title}
                      </button>
                    </td>
                    <td>
                      <StageBadge stageKey={d.stage} label={d.stage_label} />
                    </td>
                    <td className="table__num">{fmtEur(d.value_cents)}</td>
                    <td className="table__num">{fmtEur(d.expected_value_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="section-title mono">ACTIVITY TIMELINE</div>
          <ActivityForm config={config} contactId={contact.id} onLogged={() => void load()} onAuthLost={onAuthLost} />
          <div className="timeline" style={{ marginTop: 14 }}>
            {contact.activities.length === 0 && <div className="board__empty mono">NO ACTIVITY YET</div>}
            {contact.activities.map((a) => (
              <div key={a.id} className="tl-item">
                <div className="tl-item__head">
                  <span className="tl-item__title">
                    <ActivityBadge type={a.type} /> {a.subject}
                    {a.deal_title && <span className="tl-item__meta mono"> · {a.deal_title}</span>}
                  </span>
                  <span className="tl-item__time mono">{fmtDateTime(a.created_at)}</span>
                </div>
                {a.body && <div className="tl-item__body">{a.body}</div>}
                {a.due_date && (
                  <div className="tl-item__meta mono">
                    FOLLOW-UP DUE {a.due_date} {a.done ? '· DONE' : ''}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="detail-side">
          <div className="panel">
            <div className="panel__label mono">DETAILS</div>
            <dl className="kv">
              <dt>Email</dt>
              <dd>{contact.email ?? '—'}</dd>
              <dt>Phone</dt>
              <dd>{contact.phone ?? '—'}</dd>
              <dt>Company</dt>
              <dd>{contact.company_name ?? '—'}</dd>
              <dt>Added</dt>
              <dd>{fmtDateTime(contact.created_at)}</dd>
            </dl>
          </div>
        </div>
      </div>

      {editing && (
        <ContactEditor
          contact={contact}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
          onAuthLost={onAuthLost}
        />
      )}
    </div>
  );
}
