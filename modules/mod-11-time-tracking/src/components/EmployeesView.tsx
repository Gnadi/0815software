import { useCallback, useEffect, useState } from 'react';
import type { Employee } from '../../shared/types';
import { api, ApiError } from '../api';

interface Props {
  onAuthLost: () => void;
}

export function EmployeesView({ onAuthLost }: Props) {
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [editing, setEditing] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const { employees: list } = await api.employees();
      setEmployees(list);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setError('');
    try {
      const values = { name, email: email || null };
      if (editing) await api.updateEmployee(editing, values);
      else await api.createEmployee(values);
      setName('');
      setEmail('');
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  }

  async function remove(emp: Employee) {
    if (!confirm(`Delete ${emp.name}?`)) return;
    setError('');
    try {
      await api.deleteEmployee(emp.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ TT.05 · PEOPLE</div>
          <h1 className="resource__title">Employees</h1>
          <p className="resource__desc">
            The people who log time. A simple list — this is a single-admin tool, so there is no
            per-employee login (see the README's out-of-scope note).
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="editbar">
        <input
          className="field__input"
          placeholder="Full name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="field__input"
          placeholder="email@example.com (optional)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button className="btn btn--primary" onClick={() => void save()} disabled={!name.trim()}>
          {editing ? 'SAVE' : 'ADD'}
        </button>
        {editing && (
          <button
            className="btn btn--ghost"
            onClick={() => {
              setEditing(null);
              setName('');
              setEmail('');
            }}
          >
            CANCEL
          </button>
        )}
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Entries</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {employees?.map((emp) => (
              <tr key={emp.id}>
                <td>{emp.name}</td>
                <td className="mono">{emp.email ?? '—'}</td>
                <td className="mono">{emp.entry_count}</td>
                <td>
                  <div className="table__rowactions">
                    <button
                      className="rowbtn"
                      onClick={() => {
                        setEditing(emp.id);
                        setName(emp.name);
                        setEmail(emp.email ?? '');
                      }}
                    >
                      EDIT
                    </button>
                    <button
                      className="rowbtn rowbtn--danger"
                      onClick={() => void remove(emp)}
                      disabled={emp.entry_count > 0}
                      title={emp.entry_count > 0 ? 'Has time entries — cannot delete' : ''}
                    >
                      DELETE
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {employees && employees.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={4}>
                  NO EMPLOYEES YET
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
