import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DepartmentRow, EmployeeRow } from '../../shared/types';
import { api, ApiError, exportCsvUrl } from '../api';
import { fmtDate } from '../format';
import { EmployeeModal } from './EmployeeModal';

interface Props {
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}

const STATUS_FILTERS = [
  { value: 'active', label: 'ACTIVE' },
  { value: 'offboarded', label: 'OFFBOARDED' },
  { value: '', label: 'ALL' },
];

export function DirectoryView({ onOpen, onAuthLost }: Props) {
  const [rows, setRows] = useState<EmployeeRow[] | null>(null);
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState('');
  const [location, setLocation] = useState('');
  const [status, setStatus] = useState('active');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (search.trim()) p.set('search', search.trim());
    if (department) p.set('department', department);
    if (location) p.set('location', location);
    if (status) p.set('status', status);
    return p;
  }, [search, department, location, status]);

  const load = useCallback(async () => {
    try {
      const { employees } = await api.employees(params);
      setRows(employees);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load the directory');
    }
  }, [params, onAuthLost]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const [depts, locs] = await Promise.all([api.departments(), api.locations()]);
        setDepartments(depts.departments);
        setLocations(locs.locations);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onAuthLost();
      }
    })();
  }, [onAuthLost]);

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ DIR.01 · PEOPLE</div>
          <h1 className="resource__title">Directory</h1>
          <p className="resource__desc">Who works here, what they do, and how to reach them.</p>
        </div>
        <div className="resource__actions">
          <a className="btn btn--ghost" href={exportCsvUrl(params)}>
            EXPORT CSV ↓
          </a>
          <button className="btn btn--primary" onClick={() => setCreating(true)}>
            + ADD EMPLOYEE
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <input
          className="field__input toolbar__search"
          placeholder="Search name, email, or title…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="field__input toolbar__filter" value={department} onChange={(e) => setDepartment(e.target.value)}>
          <option value="">ALL DEPTS</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.code}
            </option>
          ))}
        </select>
        <select className="field__input toolbar__filter" value={location} onChange={(e) => setLocation(e.target.value)}>
          <option value="">ALL LOCATIONS</option>
          {locations.map((l) => (
            <option key={l} value={l}>
              {l.toUpperCase()}
            </option>
          ))}
        </select>
        <select className="field__input toolbar__filter" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <span className="toolbar__count mono">{rows ? `${rows.length} PEOPLE` : ''}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">NAME</th>
              <th className="mono">TITLE</th>
              <th className="mono">DEPT</th>
              <th className="mono">MANAGER</th>
              <th className="mono">LOCATION</th>
              <th className="mono">STARTED</th>
              <th className="mono">REPORTS</th>
              <th className="mono">STATUS</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((emp) => (
              <tr key={emp.id} className={emp.status === 'offboarded' ? 'is-offboarded' : ''}>
                <td>
                  <button className="linklike" onClick={() => onOpen(emp.id)}>
                    {emp.name}
                  </button>
                </td>
                <td>{emp.job_title}</td>
                <td>
                  <span className="badge badge--dept mono">{emp.department_code}</span>
                </td>
                <td>{emp.manager_name ?? '—'}</td>
                <td>{emp.location ?? '—'}</td>
                <td className="mono table__id">{fmtDate(emp.start_date)}</td>
                <td className="mono table__id">{emp.direct_reports > 0 ? emp.direct_reports : '—'}</td>
                <td>
                  <span className={`badge badge--${emp.status} mono`}>{emp.status.toUpperCase()}</span>
                </td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={8}>
                  NO EMPLOYEES MATCH
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {creating && (
        <EmployeeModal
          initial={null}
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
