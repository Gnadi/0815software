import { useCallback, useEffect, useState } from 'react';
import type { Employee, TimesheetDetail, TimesheetRow } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDate, fmtEur, fmtHm } from '../format';

interface Props {
  onAuthLost: () => void;
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'approved' ? 'badge--active' : status === 'submitted' ? 'badge--submitted' : '';
  return <span className={`badge ${cls}`}>{status.toUpperCase()}</span>;
}

export function TimesheetsView({ onAuthLost }: Props) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [weeks, setWeeks] = useState<TimesheetRow[]>([]);
  const [open, setOpen] = useState<TimesheetDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const { employees: emps } = await api.employees();
        setEmployees(emps);
        if (emps.length > 0) setEmployeeId(emps[0]!.id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onAuthLost();
        else setError(err instanceof Error ? err.message : 'Failed to load');
      }
    })();
  }, [onAuthLost]);

  const loadWeeks = useCallback(async () => {
    if (employeeId === null) return;
    try {
      const { timesheets } = await api.timesheets(employeeId);
      setWeeks(timesheets);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [employeeId, onAuthLost]);

  useEffect(() => {
    void loadWeeks();
    setOpen(null);
  }, [loadWeeks]);

  async function openWeek(week: TimesheetRow) {
    if (employeeId === null) return;
    try {
      setOpen(await api.timesheet(employeeId, week.week_start));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load week');
    }
  }

  async function act(action: 'submit' | 'approve' | 'reject', week: string) {
    if (employeeId === null) return;
    setError('');
    try {
      let detail: TimesheetDetail;
      if (action === 'submit') detail = await api.submitWeek(employeeId, week);
      else if (action === 'approve') detail = await api.approveWeek(employeeId, week, null);
      else {
        const note = prompt('Rejection note (optional):') ?? null;
        detail = await api.rejectWeek(employeeId, week, note);
      }
      setOpen(detail);
      await loadWeeks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ TT.02 · WEEKLY APPROVAL</div>
          <h1 className="resource__title">Timesheets</h1>
          <p className="resource__desc">
            Entries roll up into a per-week timesheet: <span className="mono">draft → submitted →
            approved</span>. Approving locks the week's entries; rejecting sends it back to draft and
            records the reason. Every transition is written to an append-only history.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <select
          className="field__input toolbar__filter"
          value={employeeId ?? ''}
          onChange={(e) => setEmployeeId(Number(e.target.value))}
        >
          {employees.map((emp) => (
            <option key={emp.id} value={emp.id}>
              {emp.name}
            </option>
          ))}
        </select>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Week</th>
              <th>Status</th>
              <th>Total</th>
              <th>Billable</th>
              <th>Amount</th>
              <th>Entries</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.week_start}>
                <td className="mono">
                  {w.week_start} – {w.week_end}
                </td>
                <td>
                  <StatusBadge status={w.status} />
                </td>
                <td className="mono">{fmtHm(w.total_minutes)}</td>
                <td className="mono">{fmtHm(w.billable_minutes)}</td>
                <td className="mono">{fmtEur(w.billable_cents)}</td>
                <td className="mono">{w.entry_count}</td>
                <td>
                  <div className="table__rowactions">
                    <button className="rowbtn" onClick={() => void openWeek(w)}>
                      VIEW
                    </button>
                    {w.status === 'draft' && (
                      <button
                        className="rowbtn"
                        onClick={() => void act('submit', w.week_start)}
                        disabled={w.entry_count === 0}
                      >
                        SUBMIT
                      </button>
                    )}
                    {w.status === 'submitted' && (
                      <>
                        <button className="rowbtn" onClick={() => void act('approve', w.week_start)}>
                          APPROVE
                        </button>
                        <button
                          className="rowbtn rowbtn--danger"
                          onClick={() => void act('reject', w.week_start)}
                        >
                          REJECT
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {weeks.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={7}>
                  NO ACTIVITY FOR THIS EMPLOYEE
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {open && (
        <div className="detail">
          <div className="section-title mono">
            WEEK {open.week_start} – {open.week_end} · <StatusBadge status={open.status} />
          </div>

          <div className="section-title mono">BY PROJECT</div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Client</th>
                  <th>Total</th>
                  <th>Billable</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {open.by_project.map((r) => (
                  <tr key={r.project_id}>
                    <td>{r.project_name}</td>
                    <td className="mono">{r.client ?? '—'}</td>
                    <td className="mono">{fmtHm(r.total_minutes)}</td>
                    <td className="mono">{fmtHm(r.billable_minutes)}</td>
                    <td className="mono">{fmtEur(r.billable_cents)}</td>
                  </tr>
                ))}
                {open.by_project.length === 0 && (
                  <tr>
                    <td className="table__empty mono" colSpan={5}>
                      NO ENTRIES
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="section-title mono">HISTORY</div>
          {open.events.length === 0 ? (
            <p className="resource__desc">No status changes yet.</p>
          ) : (
            <div className="events">
              {open.events.map((ev) => (
                <div key={ev.id} className="event mono">
                  <span className="event__action">{ev.action.toUpperCase()}</span>
                  <span className="event__flow">
                    {ev.from_status} → {ev.to_status}
                  </span>
                  <span className="event__meta">
                    {ev.actor} · {fmtDate(ev.created_at)}
                    {ev.note ? ` · “${ev.note}”` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
