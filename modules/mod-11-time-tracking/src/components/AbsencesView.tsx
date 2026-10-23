import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { CalendarDay, CalendarRow, Employee, LeaveBalance, LeaveRequest, LeaveType, ShownLeaveType } from '../../shared/types';
import { api, ApiError } from '../api';
import { Can, useCan } from '../access';
import { LeaveSettingsPanel } from './LeaveSettingsPanel';

/**
 * Absences: vacation, sick leave and the rest, next to the time they replace.
 * Days are never typed in — the server derives them from the dates, the
 * person's work days and the holiday calendar (server/leave.ts), and the
 * balance from the entitlement ledger minus approved vacation.
 */

interface Props {
  /** The employee the signed-in identity is (`GET /api/me`), or null. */
  ownEmployeeId: number | null;
  onAuthLost: () => void;
}

export const LEAVE_LABEL: Record<ShownLeaveType, string> = {
  vacation: 'Vacation',
  sick: 'Sick leave',
  special: 'Special leave',
  unpaid: 'Unpaid leave',
  comp_time: 'Comp time',
  absent: 'Absent',
};

/** One letter per type for the calendar grid; the title carries the word. */
const LEAVE_MARK: Record<ShownLeaveType, string> = { vacation: 'V', sick: 'S', special: 'X', unpaid: 'U', comp_time: 'C', absent: 'A' };

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'approved' ? 'badge--active' : status === 'requested' ? 'badge--submitted' : 'badge--offboarded';
  return <span className={`badge ${cls}`}>{status.toUpperCase()}</span>;
}

const fmtDays = (d: number) => (Number.isInteger(d) ? String(d) : d.toFixed(1));
const thisYear = () => new Date().getFullYear();
const thisMonth = () => new Date().toISOString().slice(0, 7);

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}

export function AbsencesView({ ownEmployeeId, onAuthLost }: Props) {
  const canManage = useCan('manage');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = useState<number | null>(ownEmployeeId);
  const [year, setYear] = useState(thisYear());
  const [balance, setBalance] = useState<LeaveBalance | null>(null);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [toDecide, setToDecide] = useState<LeaveRequest[]>([]);
  const [month, setMonth] = useState(thisMonth());
  const [calendar, setCalendar] = useState<{ days: CalendarDay[]; rows: CalendarRow[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [type, setType] = useState<LeaveType>('vacation');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [halfDay, setHalfDay] = useState(false);
  const [note, setNote] = useState('');

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof ApiError && err.details.length > 0 ? `${err.message}: ${err.details.map((d) => d.message).join(' · ')}` : err instanceof Error ? err.message : 'Request failed');
    },
    [onAuthLost],
  );

  useEffect(() => {
    void api.employees().then(
      ({ employees: list }) => {
        setEmployees(list);
        // A manager without an employee record of their own starts on the first person.
        setEmployeeId((current) => current ?? (canManage ? (list[0]?.id ?? null) : null));
      },
      handle,
    );
  }, [handle, canManage]);

  const load = useCallback(async () => {
    try {
      if (employeeId !== null) {
        const [b, r] = await Promise.all([api.leaveBalance(employeeId, year), api.leaveRequests({ employee_id: employeeId, year })]);
        setBalance(b);
        setRequests(r.requests);
      }
      if (canManage) setToDecide((await api.leaveRequests({ to_decide: true })).requests);
    } catch (err) {
      handle(err);
    }
  }, [employeeId, year, canManage, handle]);

  const loadCalendar = useCallback(async () => {
    try {
      setCalendar(await api.leaveCalendar(month));
    } catch (err) {
      handle(err);
    }
  }, [month, handle]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadCalendar();
  }, [loadCalendar]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await Promise.all([load(), loadCalendar()]);
    } catch (err) {
      handle(err);
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await api.requestLeave({
        employee_id: employeeId ?? undefined,
        type,
        start_date: start,
        end_date: halfDay ? start : end || start,
        half_day: halfDay,
        note: note || null,
      });
      setStart('');
      setEnd('');
      setHalfDay(false);
      setNote('');
    });
  }

  const own = employeeId !== null && employeeId === ownEmployeeId;
  const person = employees.find((e) => e.id === employeeId);

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ TT.06 · ABSENCES</div>
          <h1 className="resource__title">Absences</h1>
          <p className="resource__desc">
            Vacation is requested and approved by a manager — never by the person themselves. Sick leave is recorded, not asked for, and only the person and managers see
            that it is sickness; everyone else sees “absent”. Days are counted from work days and the holiday calendar.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      {employeeId === null && !canManage && (
        <div className="lockbar mono">NO EMPLOYEE RECORD CARRIES YOUR LOGIN — ASK A MANAGER TO ADD YOUR EMAIL TO ONE.</div>
      )}

      <div className="toolbar">
        {canManage && (
          <select className="field__input field__input--narrow" value={employeeId ?? ''} onChange={(e) => setEmployeeId(Number(e.target.value))}>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.id === ownEmployeeId ? ' (you)' : ''}
              </option>
            ))}
          </select>
        )}
        <select className="field__input field__input--narrow" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {[thisYear() - 1, thisYear(), thisYear() + 1].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        {person && <span className="toolbar__count mono">WORKS {person.work_days.split('').map((d) => 'MTWTFSS'[Number(d) - 1]).join(' ')}</span>}
      </div>

      {balance && (
        <div className="stat-row">
          <div className="stat">
            <div className="stat__label mono">ENTITLED {year}</div>
            <div className="stat__value">{fmtDays(balance.entitled)}</div>
          </div>
          <div className="stat">
            <div className="stat__label mono">TAKEN</div>
            <div className="stat__value">{fmtDays(balance.taken)}</div>
          </div>
          <div className="stat">
            <div className="stat__label mono">PENDING</div>
            <div className="stat__value">{fmtDays(balance.pending)}</div>
          </div>
          <div className="stat">
            <div className="stat__label mono">FREE</div>
            <div className="stat__value">{fmtDays(balance.free)}</div>
          </div>
        </div>
      )}

      {employeeId !== null && (own || canManage) && (
        <Can>
          <form className="editbar" onSubmit={submit}>
            <select className="field__input field__input--narrow" value={type} onChange={(e) => setType(e.target.value as LeaveType)}>
              {(Object.keys(LEAVE_LABEL) as ShownLeaveType[])
                .filter((t): t is LeaveType => t !== 'absent')
                .map((t) => (
                  <option key={t} value={t}>
                    {LEAVE_LABEL[t]}
                  </option>
                ))}
            </select>
            <input className="field__input field__input--narrow" type="date" required value={start} onChange={(e) => setStart(e.target.value)} title="First day" />
            {!halfDay && <input className="field__input field__input--narrow" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} title="Last day — empty for one day" />}
            <label className="inline-check mono">
              <input type="checkbox" checked={halfDay} onChange={(e) => setHalfDay(e.target.checked)} /> HALF DAY
            </label>
            <input className="field__input" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn btn--primary" type="submit" disabled={busy || start === ''}>
              {type === 'sick' ? 'RECORD' : 'REQUEST'}
              {!own && person ? ` FOR ${person.name.toUpperCase()}` : ''} →
            </button>
          </form>
        </Can>
      )}

      {canManage && (
        <>
          <div className="section-title mono">TO DECIDE ({toDecide.length})</div>
          <RequestTable requests={toDecide} showPerson busy={busy} run={run} empty="NOTHING WAITING" />
        </>
      )}

      {employeeId !== null && (
        <>
          <div className="section-title mono">
            {own ? 'YOUR' : (person?.name.toUpperCase() ?? '')} ABSENCES {year}
          </div>
          <RequestTable requests={requests} busy={busy} run={run} empty="NONE IN THIS YEAR" />
        </>
      )}

      <div className="section-title mono">
        TEAM CALENDAR ·{' '}
        <button type="button" className="rowbtn mono" onClick={() => setMonth(shiftMonth(month, -1))}>
          ←
        </button>{' '}
        {month}{' '}
        <button type="button" className="rowbtn mono" onClick={() => setMonth(shiftMonth(month, 1))}>
          →
        </button>
      </div>
      {calendar && <TeamCalendar days={calendar.days} rows={calendar.rows} />}

      <Can level="manage">
        <LeaveSettingsPanel year={year} onSaved={() => void Promise.all([load(), loadCalendar()])} onError={handle} />
      </Can>
    </div>
  );
}

function RequestTable({
  requests,
  showPerson = false,
  busy,
  run,
  empty,
}: {
  requests: LeaveRequest[];
  showPerson?: boolean;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
  empty: string;
}) {
  const cols = showPerson ? 7 : 6;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {showPerson && <th>Person</th>}
            <th>Type</th>
            <th>From – to</th>
            <th>Days</th>
            <th>Status</th>
            <th>Note</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {requests.length === 0 && (
            <tr>
              <td className="table__empty mono" colSpan={cols}>
                {empty}
              </td>
            </tr>
          )}
          {requests.map((r) => (
            <tr key={r.id}>
              {showPerson && <td>{r.employee_name}</td>}
              <td>{LEAVE_LABEL[r.type]}</td>
              <td className="mono">
                {r.start_date}
                {r.end_date !== r.start_date && <> – {r.end_date}</>}
                {r.half_day && ' (½)'}
              </td>
              <td className="mono">{fmtDays(r.days)}</td>
              <td>
                <StatusBadge status={r.status} />
                {r.decided_by && <span className="table__id"> {r.decided_by}</span>}
              </td>
              <td className="cell-note">
                {r.note}
                {r.decision_note && <> — {r.decision_note}</>}
              </td>
              <td>
                <div className="table__rowactions">
                  {r.can_decide && (
                    <>
                      <button className="rowbtn" disabled={busy} onClick={() => void run(() => api.approveLeave(r.id, null))}>
                        APPROVE
                      </button>
                      <button
                        className="rowbtn rowbtn--danger"
                        disabled={busy}
                        onClick={() => {
                          const why = window.prompt('Why is it rejected? The person sees this.');
                          if (why && why.trim()) void run(() => api.rejectLeave(r.id, why.trim()));
                        }}
                      >
                        REJECT
                      </button>
                    </>
                  )}
                  {r.can_withdraw && (
                    <button
                      className="rowbtn"
                      disabled={busy}
                      onClick={() => {
                        if (confirm('Withdraw this absence?')) void run(() => api.withdrawLeave(r.id));
                      }}
                    >
                      WITHDRAW
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TeamCalendar({ days, rows }: { days: CalendarDay[]; rows: CalendarRow[] }) {
  return (
    <div className="table-wrap">
      <table className="table leavecal">
        <thead>
          <tr>
            <th>Person</th>
            {days.map((d) => (
              <th key={d.date} className={`leavecal__day ${d.holiday || d.weekday > 5 ? 'is-off' : ''}`} title={d.holiday ?? undefined}>
                {Number(d.date.slice(8))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const byDate = new Map(row.absences.map((a) => [a.date, a]));
            return (
              <tr key={row.employee_id}>
                <td>{row.employee_name}</td>
                {days.map((d) => {
                  const a = byDate.get(d.date);
                  return (
                    <td
                      key={d.date}
                      className={`leavecal__cell mono ${d.holiday || d.weekday > 5 ? 'is-off' : ''} ${a ? (a.status === 'approved' ? 'is-approved' : 'is-requested') : ''}`}
                      title={a ? `${LEAVE_LABEL[a.type]}${a.half ? ' (half day)' : ''} · ${a.status}` : (d.holiday ?? undefined)}
                    >
                      {a ? `${LEAVE_MARK[a.type]}${a.half ? '½' : ''}` : ''}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="toolbar__count mono">
        {Object.entries(LEAVE_MARK)
          .map(([t, m]) => `${m} ${LEAVE_LABEL[t as ShownLeaveType]}`)
          .join(' · ')}{' '}
        · FILLED = APPROVED, OUTLINED = REQUESTED · SHADED = WEEKEND OR HOLIDAY
      </div>
    </div>
  );
}
