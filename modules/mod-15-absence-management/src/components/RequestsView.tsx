import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { AbsenceRequest, Employee, RequestStatus } from '../../shared/types';
import { REQUEST_STATUSES } from '../../shared/types';
import { leaveDays } from '../../shared/calendar';
import { api, ApiError, type AppConfig } from '../api';
import { fmtDays, fmtRange } from '../format';
import { StatusBadge, TypeBadge } from './Badges';

interface Props {
  config: AppConfig;
  employees: Employee[];
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}

const BLANK = { employee_id: '', type: 'vacation', from_date: '', to_date: '', half_start: false, half_end: false, note: '' };

export function RequestsView({ config, employees, onOpen, onAuthLost }: Props) {
  const [rows, setRows] = useState<AbsenceRequest[] | null>(null);
  const [status, setStatus] = useState<'' | RequestStatus>('');
  const [employeeId, setEmployeeId] = useState('');
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { requests } = await api.requests({
        status: status === '' ? undefined : status,
        employee_id: employeeId === '' ? undefined : Number(employeeId),
      });
      setRows(requests);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load requests');
    }
  }, [status, employeeId, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The live cost of the span being composed, computed with the SAME function
   * the server charges with — shared/calendar.ts is imported by both. A
   * preview computed a second way is a preview that eventually disagrees with
   * the number the employee is actually billed, and that argument is
   * unwinnable. It is a preview only: the server still recomputes on POST.
   */
  const preview = useMemo(() => {
    const employee = employees.find((candidate) => String(candidate.id) === form.employee_id);
    if (!employee || form.from_date === '' || form.to_date === '' || form.from_date > form.to_date) return null;
    const type = config.types.find((candidate) => candidate.key === form.type);
    return {
      days: leaveDays(form.from_date, form.to_date, employee.region, {
        halfStart: form.half_start,
        halfEnd: form.half_end,
      }),
      region: employee.region,
      deducts: type?.deducts === true,
    };
  }, [employees, config.types, form]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await api.createRequest({
        employee_id: Number(form.employee_id),
        type: form.type,
        from_date: form.from_date,
        to_date: form.to_date,
        half_start: form.half_start,
        half_end: form.half_end,
        note: form.note || null,
      });
      setForm(BLANK);
      setShowForm(false);
      onOpen(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to file the request');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ ABS.01 · REQUESTS</div>
          <h1 className="resource__title">Absence requests</h1>
          <p className="resource__desc">
            Every request, with the number of days it actually costs. The count comes from the employee's own
            regional holiday calendar, so the same week is charged differently in Bayern, Berlin and Österreich.
          </p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--primary" onClick={() => setShowForm((s) => !s)}>
            {showForm ? 'CLOSE' : 'NEW REQUEST +'}
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      {showForm && (
        <form className="form" onSubmit={(e) => void create(e)}>
          <div className="form__grid">
            <label className="field">
              <span className="field__label mono">EMPLOYEE</span>
              <select
                className="field__input"
                value={form.employee_id}
                onChange={(e) => setForm({ ...form, employee_id: e.target.value })}
                required
              >
                <option value="">Select…</option>
                {employees.map((employee) => (
                  <option key={employee.id} value={String(employee.id)}>
                    {employee.name} · {employee.region}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label mono">TYPE</span>
              <select
                className="field__input"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
              >
                {config.types.map((type) => (
                  <option key={type.key} value={type.key}>
                    {type.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label mono">FROM</span>
              <input
                className="field__input"
                type="date"
                value={form.from_date}
                onChange={(e) => setForm({ ...form, from_date: e.target.value })}
                required
              />
            </label>
            <label className="field">
              <span className="field__label mono">TO</span>
              <input
                className="field__input"
                type="date"
                value={form.to_date}
                onChange={(e) => setForm({ ...form, to_date: e.target.value })}
                required
              />
            </label>
            <label className="field field--check">
              <input
                type="checkbox"
                checked={form.half_start}
                onChange={(e) => setForm({ ...form, half_start: e.target.checked })}
              />
              <span className="field__label mono">HALF DAY ON THE FIRST DAY</span>
            </label>
            <label className="field field--check">
              <input
                type="checkbox"
                checked={form.half_end}
                onChange={(e) => setForm({ ...form, half_end: e.target.checked })}
              />
              <span className="field__label mono">HALF DAY ON THE LAST DAY</span>
            </label>
            <label className="field field--wide">
              <span className="field__label mono">NOTE</span>
              <input
                className="field__input"
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                placeholder="Optional"
              />
            </label>
          </div>
          {preview && (
            <div className="form__preview mono">
              {fmtDays(preview.days)} WORKING {preview.days === 1 ? 'DAY' : 'DAYS'} · CALENDAR {preview.region} ·{' '}
              {preview.deducts ? 'DEDUCTS FROM THE ENTITLEMENT' : 'DOES NOT DEDUCT'}
            </div>
          )}
          <div className="form__actions">
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'FILING…' : 'FILE REQUEST →'}
            </button>
          </div>
        </form>
      )}

      <div className="toolbar">
        <select className="toolbar__select mono" value={status} onChange={(e) => setStatus(e.target.value as '' | RequestStatus)}>
          <option value="">ALL STATUSES</option>
          {REQUEST_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value.toUpperCase()}
            </option>
          ))}
        </select>
        <select className="toolbar__select mono" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          <option value="">EVERYONE</option>
          {employees.map((employee) => (
            <option key={employee.id} value={String(employee.id)}>
              {employee.name.toUpperCase()}
            </option>
          ))}
        </select>
        <span className="toolbar__count mono">{rows === null ? '…' : `${rows.length} REQUEST(S)`}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Type</th>
              <th>Dates</th>
              <th className="num">Days</th>
              <th>Status</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((row) => (
              <tr key={row.id} onClick={() => onOpen(row.id)}>
                <td>
                  <span className="linklike">{row.employee_name}</span>
                </td>
                <td>
                  <TypeBadge type={row.type} types={config.types} />
                </td>
                <td className="mono">{fmtRange(row.from_date, row.to_date)}</td>
                <td className="num mono">{fmtDays(row.days)}</td>
                <td>
                  <StatusBadge status={row.status} />
                </td>
                <td className="table__muted">{row.note ?? '—'}</td>
              </tr>
            ))}
            {rows !== null && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="table__empty mono">
                  NO REQUESTS MATCH THIS FILTER
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
