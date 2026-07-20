import { useCallback, useEffect, useState } from 'react';
import type { EmployeeDetail } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDate } from '../format';
import { EmployeeModal } from './EmployeeModal';

interface Props {
  id: number;
  onBack: () => void;
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}

export function EmployeeDetailView({ id, onBack, onOpen, onAuthLost }: Props) {
  const [employee, setEmployee] = useState<EmployeeDetail | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setEmployee(await api.employeeDetail(id));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load employee');
    }
  }, [id, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await load();
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Action failed');
    }
  }

  if (!employee) {
    return (
      <div>
        <button className="backlink mono" onClick={onBack}>
          ← DIRECTORY
        </button>
        {error ? <div className="resource__error mono">{error}</div> : <div className="boot mono">LOADING…</div>}
      </div>
    );
  }

  const offboarded = employee.status === 'offboarded';

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← DIRECTORY
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">
            EMPLOYEE #{employee.id} · {employee.department_code}
          </div>
          <h1 className="resource__title">{employee.name}</h1>
          <p className="resource__desc">
            {employee.job_title} · {employee.department_name}
          </p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--ghost" onClick={() => setEditing(true)}>
            EDIT
          </button>
          {offboarded ? (
            <button className="btn btn--primary" onClick={() => void run(() => api.reactivate(employee.id))}>
              REACTIVATE
            </button>
          ) : (
            <button
              className="btn btn--ghost"
              onClick={() => {
                if (window.confirm(`Offboard ${employee.name}? The record is kept; they leave the org chart.`)) {
                  void run(() => api.offboard(employee.id));
                }
              }}
            >
              OFFBOARD
            </button>
          )}
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}
      {offboarded && (
        <div className="resource__error mono">
          OFFBOARDED {employee.offboarded_at ? fmtDate(employee.offboarded_at) : ''} · RECORD KEPT FOR HISTORY ·
          NOT ON THE ORG CHART
        </div>
      )}

      <div className="section-title mono">CONTACT CARD</div>
      <div className="card-grid">
        <div className="stat">
          <div className="stat__label mono">EMAIL</div>
          <div className="stat__text">
            <a className="linklike" href={`mailto:${employee.email}`}>
              {employee.email}
            </a>
          </div>
        </div>
        <div className="stat">
          <div className="stat__label mono">PHONE</div>
          <div className="stat__text">{employee.phone ?? '—'}</div>
        </div>
        <div className="stat">
          <div className="stat__label mono">LOCATION / OFFICE</div>
          <div className="stat__text">{employee.location ?? '—'}</div>
        </div>
        <div className="stat">
          <div className="stat__label mono">START DATE</div>
          <div className="stat__text mono">{fmtDate(employee.start_date)}</div>
        </div>
      </div>

      <div className="section-title mono">REPORTS TO (UP TO ROOT)</div>
      {employee.manager_chain.length === 0 ? (
        <p className="resource__desc">No manager — this employee is an org chart root.</p>
      ) : (
        <div className="chain">
          {employee.manager_chain.map((link, i) => (
            <span key={link.id} className="chain__item">
              {i > 0 && <span className="chain__sep mono">→</span>}
              <button className="linklike" onClick={() => onOpen(link.id)}>
                {link.name}
              </button>
              <span className="chain__title">{link.job_title}</span>
            </span>
          ))}
        </div>
      )}

      <div className="section-title mono">DIRECT REPORTS ({employee.reports.length})</div>
      {employee.reports.length === 0 ? (
        <p className="resource__desc">No direct reports.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="mono">NAME</th>
                <th className="mono">TITLE</th>
                <th className="mono">STATUS</th>
              </tr>
            </thead>
            <tbody>
              {employee.reports.map((report) => (
                <tr key={report.id}>
                  <td>
                    <button className="linklike" onClick={() => onOpen(report.id)}>
                      {report.name}
                    </button>
                  </td>
                  <td>{report.job_title}</td>
                  <td>
                    <span className={`badge badge--${report.status} mono`}>{report.status.toUpperCase()}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <EmployeeModal
          initial={employee}
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
