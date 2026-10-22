import { useCallback, useEffect, useState } from 'react';
import type { Employee, WorkSchedule } from '../../shared/types';
import { api, ApiError } from '../api';
import { Can } from '../access';
import { fmtHm, parseHours } from '../format';

const DAY_LETTERS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

export function fmtWorkDays(days: string): string {
  return days
    .split('')
    .map((d) => DAY_LETTERS[Number(d) - 1])
    .join(' ');
}

/** Which ISO weekdays the person works — a part-timer's leave counts only those. */
function WorkDaysPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <span className="inline-check mono" title="Days worked — leave and the daily target fall only on these">
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
 * A person's working-time models, oldest first. A change of contract is a new
 * row from its date — never an edit — so last year's leave and flexitime keep
 * the price they had (server/schedules.ts).
 */
export function WorkSchedulePanel({ employee, onChanged, onError }: { employee: Employee; onChanged: () => void; onError: (message: string) => void }) {
  const [rows, setRows] = useState<WorkSchedule[]>([]);
  const [validFrom, setValidFrom] = useState('');
  const [hours, setHours] = useState('');
  const [workDays, setWorkDays] = useState(employee.work_days);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      setRows((await api.schedules(employee.id)).schedules);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [employee.id, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    const weekly = hours.trim() === '' ? null : parseHours(hours);
    if (hours.trim() !== '' && (weekly === null || weekly <= 0)) {
      onError('Weekly hours as e.g. 38,5 or 38:30 — or empty for no flexitime account');
      return;
    }
    try {
      await api.addSchedule(employee.id, { valid_from: validFrom, weekly_minutes: weekly, work_days: workDays, note: note || null });
      setValidFrom('');
      setHours('');
      setNote('');
      await load();
      onChanged();
    } catch (err) {
      onError(err instanceof ApiError && err.details.length > 0 ? err.details.map((d) => d.message).join(' · ') : err instanceof Error ? err.message : 'Failed to save');
    }
  }

  return (
    <>
      <div className="section-title mono">WORKING TIME · {employee.name.toUpperCase()}</div>
      <Can level="manage">
        <div className="editbar">
          <input className="field__input field__input--narrow" type="date" value={validFrom} title="Valid from" onChange={(e) => setValidFrom(e.target.value)} />
          <input
            className="field__input field__input--narrow"
            placeholder="Hours/week, e.g. 38,5"
            title="Empty: no flexitime account, only the work days"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
          <WorkDaysPicker value={workDays} onChange={setWorkDays} />
          <input className="field__input" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn btn--primary" onClick={() => void add()} disabled={validFrom === '' || workDays === ''}>
            ADD FROM DATE
          </button>
        </div>
      </Can>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Valid from</th>
              <th>Hours/week</th>
              <th>Works</th>
              <th>Note</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={5}>
                  NO SCHEDULE — MONDAY TO FRIDAY, NO FLEXITIME ACCOUNT
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.valid_from}</td>
                <td className="mono">{r.weekly_minutes === null ? '— (no account)' : fmtHm(r.weekly_minutes)}</td>
                <td className="mono">{fmtWorkDays(r.work_days)}</td>
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
