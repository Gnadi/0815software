import { useCallback, useEffect, useState } from 'react';
import type { Employee, LeaveEntitlement } from '../../shared/types';
import { api, ApiError } from '../api';
import { Can } from '../access';

interface Props {
  onAuthLost: () => void;
}

export function EmployeesView({ onAuthLost }: Props) {
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [workDays, setWorkDays] = useState('12345');
  const [ledgerFor, setLedgerFor] = useState<Employee | null>(null);
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
      const values = { name, email: email || null, work_days: workDays };
      if (editing) await api.updateEmployee(editing, values);
      else await api.createEmployee(values);
      setName('');
      setEmail('');
      setWorkDays('12345');
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
            The people who log time and take leave. A person whose login email is on their record
            records their own time and absences; managers keep the list, work days and vacation
            entitlements.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <Can level="manage">
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
          <WorkDaysPicker value={workDays} onChange={setWorkDays} />
          <button className="btn btn--primary" onClick={() => void save()} disabled={!name.trim() || workDays === ''}>
            {editing ? 'SAVE' : 'ADD'}
          </button>
          {editing && (
            <button
              className="btn btn--ghost"
              onClick={() => {
                setEditing(null);
                setName('');
                setEmail('');
                setWorkDays('12345');
              }}
            >
              CANCEL
            </button>
          )}
        </div>
      </Can>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Works</th>
              <th>Entries</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {employees?.map((emp) => (
              <tr key={emp.id}>
                <td>{emp.name}</td>
                <td className="mono">{emp.email ?? '—'}</td>
                <td className="mono">{fmtWorkDays(emp.work_days)}</td>
                <td className="mono">{emp.entry_count}</td>
                <td>
                  <div className="table__rowactions">
                    <Can level="manage">
                      <button
                        className="rowbtn"
                        onClick={() => {
                          setEditing(emp.id);
                          setName(emp.name);
                          setEmail(emp.email ?? '');
                          setWorkDays(emp.work_days);
                        }}
                      >
                        EDIT
                      </button>
                    </Can>
                    <button className="rowbtn" onClick={() => setLedgerFor(ledgerFor?.id === emp.id ? null : emp)}>
                      VACATION
                    </button>
                    <Can level="manage">
                      <button
                        className="rowbtn rowbtn--danger"
                        onClick={() => void remove(emp)}
                        disabled={emp.entry_count > 0}
                        title={emp.entry_count > 0 ? 'Has time entries — cannot delete' : ''}
                      >
                        DELETE
                      </button>
                    </Can>
                  </div>
                </td>
              </tr>
            ))}
            {employees && employees.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={5}>
                  NO EMPLOYEES YET
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {ledgerFor && <EntitlementLedger employee={ledgerFor} onError={setError} />}
    </div>
  );
}

const DAY_LETTERS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

function fmtWorkDays(days: string): string {
  return days
    .split('')
    .map((d) => DAY_LETTERS[Number(d) - 1])
    .join(' ');
}

/** Which ISO weekdays the person works — a part-timer's leave counts only those. */
function WorkDaysPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <span className="inline-check mono" title="Days worked — leave is counted only on these">
      {DAY_LETTERS.map((label, i) => {
        const d = String(i + 1);
        return (
          <label key={d}>
            <input
              type="checkbox"
              checked={value.includes(d)}
              onChange={(e) => {
                const set = new Set(value.split('').filter(Boolean));
                if (e.target.checked) set.add(d);
                else set.delete(d);
                onChange([...set].sort().join(''));
              }}
            />
            {label}{' '}
          </label>
        );
      })}
    </span>
  );
}

/**
 * The vacation account is a ledger: allowance, carry-over and corrections are
 * added, never edited, so the history of who granted what stays visible. The
 * balance on the Absences screen is derived from it.
 */
function EntitlementLedger({ employee, onError }: { employee: Employee; onError: (message: string) => void }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [rows, setRows] = useState<LeaveEntitlement[]>([]);
  const [kind, setKind] = useState<LeaveEntitlement['kind']>('allowance');
  const [days, setDays] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      setRows((await api.entitlements(employee.id, year)).entitlements);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [employee.id, year, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    try {
      await api.addEntitlement(employee.id, { year, kind, days: Number(days.replace(',', '.')), note: note || null });
      setDays('');
      setNote('');
      await load();
    } catch (err) {
      onError(err instanceof ApiError && err.details.length > 0 ? err.details.map((d) => d.message).join(' · ') : err instanceof Error ? err.message : 'Failed to save');
    }
  }

  const total = rows.reduce((sum, r) => sum + r.days, 0);
  return (
    <>
      <div className="section-title mono">
        VACATION ENTITLEMENT · {employee.name.toUpperCase()} ·{' '}
        <select className="field__input field__input--narrow" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {[year - 1, year, year + 1].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>{' '}
        · {total} DAYS
      </div>
      <Can level="manage">
        <div className="editbar">
          <select className="field__input field__input--narrow" value={kind} onChange={(e) => setKind(e.target.value as LeaveEntitlement['kind'])}>
            <option value="allowance">Annual allowance</option>
            <option value="carryover">Carried over</option>
            <option value="adjustment">Correction (±)</option>
          </select>
          <input className="field__input field__input--narrow" placeholder="Days, e.g. 25 or 2.5" value={days} onChange={(e) => setDays(e.target.value)} />
          <input className="field__input" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn btn--primary" onClick={() => void add()} disabled={days.trim() === ''}>
            ADD
          </button>
        </div>
      </Can>
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={5}>
                  NO ENTITLEMENT FOR {year} YET
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono table__id">{r.created_at.slice(0, 10)}</td>
                <td className="mono">{r.kind.toUpperCase()}</td>
                <td className="mono">{r.days > 0 ? `+${r.days}` : r.days}</td>
                <td className="cell-note">{r.note}</td>
                <td className="table__id">{r.actor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
