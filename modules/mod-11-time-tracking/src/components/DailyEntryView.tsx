import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DaySheet, Employee, Project } from '../../shared/types';
import { api, ApiError } from '../api';
import { addDays, fmtEur, fmtHm } from '../format';

interface Props {
  onAuthLost: () => void;
}

interface RowDraft {
  project_id: string;
  task_id: string;
  hours: string; // "1:30" or "90m" or "1.5"
  billable: boolean | null;
  note: string;
}

const EMPTY_ROW: RowDraft = { project_id: '', task_id: '', hours: '', billable: null, note: '' };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Parse a duration into whole minutes. Accepts "90" or "90m" (minutes),
 * "1:30" (h:mm), or "1.5" / "1,5" (decimal hours). Returns null if the
 * value is empty or unparseable.
 */
function parseMinutes(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.includes(':')) {
    const [h, m] = s.split(':');
    const hi = Number(h);
    const mi = Number(m);
    if (!Number.isInteger(hi) || !Number.isInteger(mi) || mi < 0 || mi > 59) return null;
    return hi * 60 + mi;
  }
  if (s.endsWith('m')) {
    const n = Number(s.slice(0, -1));
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  if (s.endsWith('h')) {
    const n = Number(s.slice(0, -1).replace(',', '.'));
    return n > 0 ? Math.round(n * 60) : null;
  }
  // Bare number: integer ⇒ minutes, fractional ⇒ decimal hours.
  const n = Number(s.replace(',', '.'));
  if (Number.isNaN(n) || n <= 0) return null;
  return Number.isInteger(n) ? n : Math.round(n * 60);
}

const DRAFT_KEY = 'mod11.dailyDraft';

export function DailyEntryView({ onAuthLost }: Props) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [date, setDate] = useState<string>(todayIso());
  const [sheet, setSheet] = useState<DaySheet | null>(null);
  const [error, setError] = useState('');
  const [row, setRow] = useState<RowDraft>(EMPTY_ROW);
  const restored = useRef(false);

  // Load reference data once.
  useEffect(() => {
    void (async () => {
      try {
        const [{ employees: emps }, { projects: projs }] = await Promise.all([
          api.employees(),
          api.projects(true),
        ]);
        setEmployees(emps);
        setProjects(projs);
        if (emps.length > 0) setEmployeeId((cur) => cur ?? emps[0]!.id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onAuthLost();
        else setError(err instanceof Error ? err.message : 'Failed to load');
      }
    })();
  }, [onAuthLost]);

  // OFFLINE TOUCH: restore an in-progress row draft from localStorage so
  // an accidental reload never loses what you were typing.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { employeeId?: number; date?: string; row?: RowDraft };
        if (parsed.row) setRow(parsed.row);
        if (parsed.employeeId) setEmployeeId(parsed.employeeId);
        if (parsed.date) setDate(parsed.date);
      }
    } catch {
      /* ignore malformed draft */
    }
    restored.current = true;
  }, []);

  // Persist the in-progress row draft on every change (after the restore).
  useEffect(() => {
    if (!restored.current) return;
    const isBlank = row.project_id === '' && row.hours === '' && row.note === '';
    if (isBlank) localStorage.removeItem(DRAFT_KEY);
    else localStorage.setItem(DRAFT_KEY, JSON.stringify({ employeeId, date, row }));
  }, [row, employeeId, date]);

  const loadSheet = useCallback(async () => {
    if (employeeId === null) return;
    try {
      setSheet(await api.day(employeeId, date));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [employeeId, date, onAuthLost]);

  useEffect(() => {
    void loadSheet();
  }, [loadSheet]);

  const selectedProject = useMemo(
    () => projects.find((p) => String(p.id) === row.project_id),
    [projects, row.project_id],
  );

  const parsedMinutes = parseMinutes(row.hours);
  const canAdd =
    employeeId !== null && row.project_id !== '' && parsedMinutes !== null && !sheet?.locked;

  async function addRow() {
    if (!canAdd || employeeId === null) return;
    setError('');
    try {
      await api.createEntry({
        employee_id: employeeId,
        project_id: Number(row.project_id),
        task_id: row.task_id ? Number(row.task_id) : null,
        entry_date: date,
        minutes: parsedMinutes,
        billable: row.billable, // null ⇒ inherit project default
        note: row.note || null,
      });
      setRow(EMPTY_ROW);
      localStorage.removeItem(DRAFT_KEY);
      await loadSheet();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add entry');
    }
  }

  async function deleteRow(id: number) {
    setError('');
    try {
      await api.deleteEntry(id);
      await loadSheet();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  const effectiveBillable = row.billable ?? selectedProject?.billable_default ?? true;

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ TT.01 · DAILY ENTRY</div>
          <h1 className="resource__title">Daily Entry</h1>
          <p className="resource__desc">
            Pick a person and a day, then add rows fast. Durations accept <span className="mono">90</span>,{' '}
            <span className="mono">1:30</span> or <span className="mono">1.5</span>. Your in-progress row
            survives a reload (saved locally). Entries in an approved week are locked.
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
        <button className="rowbtn" onClick={() => setDate(addDays(date, -1))}>
          ‹ PREV
        </button>
        <input
          className="field__input toolbar__filter"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <button className="rowbtn" onClick={() => setDate(addDays(date, 1))}>
          NEXT ›
        </button>
        <button className="rowbtn" onClick={() => setDate(todayIso())}>
          TODAY
        </button>
        {sheet && (
          <span className="toolbar__count mono">
            WEEK {sheet.week_start} · {sheet.timesheet_status.toUpperCase()}
          </span>
        )}
      </div>

      {sheet?.locked && (
        <div className="lockbar mono">
          ⚿ THIS WEEK IS APPROVED — ENTRIES ARE LOCKED. Reject the week from Timesheets to edit again.
        </div>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Task</th>
              <th>Duration</th>
              <th>Billable</th>
              <th>Amount</th>
              <th>Note</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sheet?.entries.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.project_name}</td>
                <td className="mono">{entry.task_name ?? '—'}</td>
                <td className="mono">{fmtHm(entry.minutes)}</td>
                <td>
                  {entry.billable ? (
                    <span className="badge badge--active">BILLABLE</span>
                  ) : (
                    <span className="badge">NON-BILL</span>
                  )}
                </td>
                <td className="mono">{entry.billable ? fmtEur(entry.billable_cents) : '—'}</td>
                <td className="cell-note">{entry.note ?? ''}</td>
                <td>
                  <button
                    className="rowbtn rowbtn--danger"
                    onClick={() => void deleteRow(entry.id)}
                    disabled={entry.locked}
                    title={entry.locked ? 'Approved week — locked' : ''}
                  >
                    DEL
                  </button>
                </td>
              </tr>
            ))}
            {sheet && sheet.entries.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={7}>
                  NO ENTRIES FOR {date}
                </td>
              </tr>
            )}
            {sheet && !sheet.locked && (
              <tr className="addrow">
                <td>
                  <select
                    className="field__input"
                    value={row.project_id}
                    onChange={(e) => setRow({ ...row, project_id: e.target.value, task_id: '' })}
                  >
                    <option value="">— project —</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    className="field__input"
                    value={row.task_id}
                    onChange={(e) => setRow({ ...row, task_id: e.target.value })}
                    disabled={!selectedProject || selectedProject.tasks.length === 0}
                  >
                    <option value="">— none —</option>
                    {selectedProject?.tasks
                      .filter((t) => t.active)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                  </select>
                </td>
                <td>
                  <input
                    className="field__input field__input--narrow mono"
                    placeholder="1:30"
                    value={row.hours}
                    onChange={(e) => setRow({ ...row, hours: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void addRow();
                    }}
                  />
                </td>
                <td>
                  <button
                    className={`toggle mono ${effectiveBillable ? 'is-on' : ''}`}
                    onClick={() => setRow({ ...row, billable: !effectiveBillable })}
                  >
                    {effectiveBillable ? 'BILLABLE' : 'NON-BILL'}
                  </button>
                </td>
                <td className="mono">
                  {parsedMinutes !== null && effectiveBillable && selectedProject
                    ? fmtEur(Math.round((parsedMinutes * selectedProject.rate_cents) / 60))
                    : '—'}
                </td>
                <td>
                  <input
                    className="field__input"
                    placeholder="note"
                    value={row.note}
                    onChange={(e) => setRow({ ...row, note: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void addRow();
                    }}
                  />
                </td>
                <td>
                  <button className="btn btn--primary btn--sm" onClick={() => void addRow()} disabled={!canAdd}>
                    ADD
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {sheet && (
        <div className="stat-row">
          <div className="stat">
            <div className="stat__label mono">DAY TOTAL</div>
            <div className="stat__value">{fmtHm(sheet.total_minutes)}</div>
          </div>
          <div className="stat">
            <div className="stat__label mono">BILLABLE</div>
            <div className="stat__value">{fmtHm(sheet.billable_minutes)}</div>
          </div>
          <div className="stat">
            <div className="stat__label mono">BILLABLE AMOUNT</div>
            <div className="stat__value">{fmtEur(sheet.billable_cents)}</div>
          </div>
          <div className="stat">
            <div className="stat__label mono">REMAINING TODAY</div>
            <div className="stat__value">{fmtHm(sheet.remaining_minutes)}</div>
          </div>
        </div>
      )}
    </div>
  );
}
