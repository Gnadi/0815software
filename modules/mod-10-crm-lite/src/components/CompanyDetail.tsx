import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type CompanyDetail } from '../api';
import { fmtDateTime, fmtEur } from '../format';
import { StageBadge } from './ui';
import { CompanyEditor } from './CompaniesView';

export function CompanyDetailView({
  id,
  onBack,
  onOpenContact,
  onOpenDeal,
  onDeleted,
  onAuthLost,
}: {
  id: number;
  onBack: () => void;
  onOpenContact: (id: number) => void;
  onOpenDeal: (id: number) => void;
  onDeleted: () => void;
  onAuthLost: () => void;
}) {
  const [company, setCompany] = useState<CompanyDetail | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setCompany(await api.company(id));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load company');
    }
  }, [id, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove() {
    if (!window.confirm('Delete this company? Only possible if it has no contacts or deals.')) return;
    try {
      await api.deleteCompany(id);
      onDeleted();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  if (!company) {
    return <div className="boot mono">{error || 'LOADING…'}</div>;
  }

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← BACK TO COMPANIES
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">COMPANY #{company.id}</div>
          <h1 className="resource__title">{company.name}</h1>
          <p className="resource__desc">{company.domain ?? 'No domain on file'}</p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--ghost" onClick={() => setEditing(true)}>
            EDIT
          </button>
          <button className="btn btn--danger" onClick={() => void remove()}>
            DELETE
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="detail-grid">
        <div>
          <div className="section-title mono">CONTACTS</div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>NAME</th>
                  <th>TITLE</th>
                  <th>EMAIL</th>
                </tr>
              </thead>
              <tbody>
                {company.contacts.length === 0 && (
                  <tr>
                    <td className="table__empty mono" colSpan={3}>
                      NO CONTACTS
                    </td>
                  </tr>
                )}
                {company.contacts.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <button className="linklike" onClick={() => onOpenContact(c.id)}>
                        {c.name}
                      </button>
                    </td>
                    <td className="note-cell">{c.title ?? '—'}</td>
                    <td className="note-cell">{c.email ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="section-title mono">DEALS</div>
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
                {company.deals.length === 0 && (
                  <tr>
                    <td className="table__empty mono" colSpan={4}>
                      NO DEALS
                    </td>
                  </tr>
                )}
                {company.deals.map((d) => (
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
        </div>

        <div className="detail-side">
          <div className="panel">
            <div className="panel__label mono">DETAILS</div>
            <dl className="kv">
              <dt>Domain</dt>
              <dd>{company.domain ?? '—'}</dd>
              <dt>Contacts</dt>
              <dd>{company.contact_count}</dd>
              <dt>Deals</dt>
              <dd>{company.deal_count}</dd>
              <dt>Added</dt>
              <dd>{fmtDateTime(company.created_at)}</dd>
            </dl>
            {company.notes && <div className="tl-item__body">{company.notes}</div>}
          </div>
        </div>
      </div>

      {editing && (
        <CompanyEditor
          company={company}
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
