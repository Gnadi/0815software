import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Employee, FlexAccount, FlexDay, FlexEntry, FlexKind, LeaveSettings } from '../../shared/types';
import { api, ApiError, flexCsvUrl } from '../api';
import { Can, useCan } from '../access';
import { fmtHm, fmtSignedHm, parseHours } from '../format';
import { LEAVE_LABEL } from './AbsencesView';

/**
 * Flexitime and overtime. Every figure is derived on the server
 * (server/flextime.ts) from the time recorded, each day's target and the
 * absences; the only thing typed here is what the days cannot say — the
 * balance brought in, a correction, overtime paid out.
 */

interface Props {
  ownEmployeeId: number | null;
  onAuthLost: () => void;
}

const WEEKDAY = ['', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const KIND_LABEL: Record<FlexKind, string> = { opening: 'Opening balance', adjustment: 'Correction', payout: 'Overtime paid out' };

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}

export function FlexView({ ownEmployeeId, onAuthLost }: Props) {
  const canManage = useCan('manage');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = useState<number | null>(ownEmployeeId);
  const [account, setAccount] = useState<FlexAccount | null>(null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [days, setDays] = useState<FlexDay[]>([]);
  const [entries, setEntries] = useState<FlexEntry[]>([]);
  const [overview, setOverview] = useState<Awaited<ReturnType<typeof api.flexOverview>>['rows']>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof ApiError && err.details.length > 0 ? `${err.message}: ${err.details.map((d) => d.message).join(' · ')}` : err instanceof Error ? err.message : 'Request failed');
    },
    [onAuthLost],
  );

  useEffect(() => {
    void api.employees().then(({ employees: list }) => {
      setEmployees(list);
      setEmployeeId((current) => current ?? (canManage ? (list.find((e) => e.weekly_minutes !== null)?.id ?? list[0]?.id ?? null) : null));
    }, handle);
  }, [handle, canManage]);

  const load = useCallback(async () => {
    try {
      if (employeeId !== null) {
        const [a, d, e] = await Promise.all([api.flexAccount(employeeId), api.flexDays(employeeId, month), api.flexEntries(employeeId)]);
        setAccount(a);
        setDays(d.days);
        setEntries(e.entries);
      }
      if (canManage) setOverview((await api.flexOverview()).rows);
    } catch (err) {
      handle(err);
    }
  }, [employeeId, month, canManage, handle]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (err) {
      handle(err);
    } finally {
      setBusy(false);
    }
  }

  const tone = (minutes: number) => (minutes < 0 ? 'qty-neg' : minutes > 0 ? 'qty-pos' : '');

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ TT.07 · FLEXITIME</div>
          <h1 className="resource__title">Flexitime &amp; overtime</h1>
          <p className="resource__desc">
            Each day asks for its share of the weekly hours; holidays ask for nothing; vacation, sick, special and unpaid leave cover the day, comp time is taken from
            the balance. The balance is what was worked minus what was due — overtime is the part above the cap.
          </p>
        </div>
        <div className="resource__actions">
          <a className="btn btn--ghost" href={flexCsvUrl(month)}>
            PAYROLL CSV {month} ↓
          </a>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        {canManage && (
          <select className="field__input field__input--narrow" value={employeeId ?? ''} onChange={(e) => setEmployeeId(Number(e.target.value))}>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.weekly_minutes === null ? ' (no account)' : ''}
              </option>
            ))}
          </select>
        )}
        {account && <span className="toolbar__count mono">{account.start ? `ACCOUNT SINCE ${account.start} · AS OF ${account.as_of}` : 'NO FLEXITIME ACCOUNT — A MANAGER SETS THE WEEKLY HOURS UNDER EMPLOYEES → WORK TIME'}</span>}
      </div>

      {employeeId === null && !canManage && <div className="lockbar mono">NO EMPLOYEE RECORD CARRIES YOUR LOGIN — ASK A MANAGER TO ADD YOUR EMAIL TO ONE.</div>}

      {account?.start && (
        <div className="stat-row">
          <div className="stat stat--total">
            <div className="stat__label mono">BALANCE</div>
            <div className={`stat__value ${tone(account.balance)}`}>{fmtSignedHm(account.balance)}</div>
          </div>
          <div className="stat">
            <div className="stat__label mono">OVERTIME (ABOVE CAP)</div>
            <div className="stat__value">{fmtHm(account.over_cap)}</div>
          </div>
          <div className="stat">
            <div className="stat__label mono">CAP · FLOOR</div>
            <div className="stat__value">
              {account.cap === null ? '—' : fmtSignedHm(account.cap)} · {account.floor === null ? '—' : fmtSignedHm(account.floor)}
            </div>
          </div>
          {account.under_floor > 0 && (
            <div className="stat">
              <div className="stat__label mono">BELOW FLOOR BY</div>
              <div className="stat__value qty-neg">{fmtHm(account.under_floor)}</div>
            </div>
          )}
        </div>
      )}

      {account?.start && (
        <>
          <div className="section-title mono">MONTHS</div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="table__num">Due</th>
                  <th className="table__num">Worked</th>
                  <th className="table__num">Difference</th>
                  <th className="table__num">Booked</th>
                  <th className="table__num">Paid out</th>
                  <th className="table__num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {[...account.months].reverse().map((m) => (
                  <tr key={m.month} className={m.month === month ? 'is-selected' : ''}>
                    <td>
                      <button type="button" className="linklike mono" onClick={() => setMonth(m.month)}>
                        {m.month}
                      </button>
                    </td>
                    <td className="table__num mono">{fmtHm(m.due)}</td>
                    <td className="table__num mono">{fmtHm(m.worked)}</td>
                    <td className={`table__num mono ${tone(m.diff)}`}>{fmtSignedHm(m.diff)}</td>
                    <td className="table__num mono">{m.booked === 0 ? '' : fmtSignedHm(m.booked)}</td>
                    <td className="table__num mono">{m.paid_out === 0 ? '' : fmtHm(m.paid_out)}</td>
                    <td className={`table__num mono ${tone(m.balance_end)}`}>{fmtSignedHm(m.balance_end)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="section-title mono">
            DAYS ·{' '}
            <button type="button" className="rowbtn mono" onClick={() => setMonth(shiftMonth(month, -1))}>
              ←
            </button>{' '}
            {month}{' '}
            <button type="button" className="rowbtn mono" onClick={() => setMonth(shiftMonth(month, 1))}>
              →
            </button>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Absence / holiday</th>
                  <th className="table__num">Target</th>
                  <th className="table__num">Due</th>
                  <th className="table__num">Worked</th>
                  <th className="table__num">Difference</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => {
                  // Days still ahead show what they will ask for, not a shortfall.
                  const ahead = account !== null && d.date > account.as_of;
                  return (
                  <tr key={d.date} className={(d.target === 0 && d.worked === 0) || ahead ? 'is-off' : ''}>
                    <td className="mono">
                      {WEEKDAY[d.weekday]} {d.date.slice(8)}
                    </td>
                    <td>
                      {d.holiday}
                      {d.absence && `${LEAVE_LABEL[d.absence]}${d.absence_half ? ' (½)' : ''}`}
                      {!d.tracked && <span className="table__id"> not counted</span>}
                    </td>
                    <td className="table__num mono">{d.target ? fmtHm(d.target) : ''}</td>
                    <td className="table__num mono">{d.tracked && d.target > 0 ? fmtHm(d.due) : ''}</td>
                    <td className={`table__num mono ${d.over_max ? 'qty-neg' : ''}`} title={d.over_max ? 'More than the daily maximum in the settings' : undefined}>
                      {d.worked ? fmtHm(d.worked) : ''}
                      {d.over_max && ' ⚠'}
                    </td>
                    <td className={`table__num mono ${tone(d.diff)}`}>{d.tracked && !ahead && (d.due || d.worked) ? fmtSignedHm(d.diff) : ''}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="section-title mono">BOOKINGS</div>
          {employeeId !== null && (
            <Can level="manage">
              <BookingForm busy={busy} onSubmit={(values) => run(() => api.addFlexEntry(employeeId, values))} />
            </Can>
          )}
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {entries.length === 0 && (
                  <tr>
                    <td className="table__empty mono" colSpan={5}>
                      NOTHING BOOKED — THE BALANCE IS THE DAYS ALONE
                    </td>
                  </tr>
                )}
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="mono table__id">{e.effective_date}</td>
                    <td>{KIND_LABEL[e.kind]}</td>
                    <td className={`table__num mono ${tone(e.minutes)}`}>{fmtSignedHm(e.minutes)}</td>
                    <td className="cell-note">{e.note}</td>
                    <td className="table__id">{e.actor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {canManage && (
        <>
          <div className="section-title mono">TEAM · AS OF TODAY</div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th className="table__num">Balance</th>
                  <th className="table__num">Overtime</th>
                  <th className="table__num">Below floor</th>
                  <th className="table__num">Days over max (month)</th>
                </tr>
              </thead>
              <tbody>
                {overview.length === 0 && (
                  <tr>
                    <td className="table__empty mono" colSpan={5}>
                      NOBODY HAS A FLEXITIME ACCOUNT YET
                    </td>
                  </tr>
                )}
                {overview.map((r) => (
                  <tr key={r.employee_id}>
                    <td>
                      <button type="button" className="linklike" onClick={() => setEmployeeId(r.employee_id)}>
                        {r.employee_name}
                      </button>
                    </td>
                    <td className={`table__num mono ${tone(r.balance)}`}>{fmtSignedHm(r.balance)}</td>
                    <td className="table__num mono">{r.over_cap ? fmtHm(r.over_cap) : ''}</td>
                    <td className="table__num mono qty-neg">{r.under_floor ? fmtHm(r.under_floor) : ''}</td>
                    <td className="table__num mono">{r.days_over_max || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <FlexRules onError={handle} onSaved={() => void load()} />
        </>
      )}
    </div>
  );
}

function BookingForm({ busy, onSubmit }: { busy: boolean; onSubmit: (values: Record<string, unknown>) => Promise<void> }) {
  const [kind, setKind] = useState<FlexKind>('payout');
  const [hours, setHours] = useState('');
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    const minutes = parseHours(hours);
    if (minutes === null || minutes === 0) {
      setProblem('Hours as e.g. 2,5 or 2:30 (negative only for an opening balance or a correction)');
      return;
    }
    setProblem('');
    void onSubmit({ kind, minutes, effective_date: date || undefined, note: note || null }).then(() => {
      setHours('');
      setNote('');
    });
  }

  return (
    <form className="editbar" onSubmit={submit}>
      <select className="field__input field__input--narrow" value={kind} onChange={(e) => setKind(e.target.value as FlexKind)}>
        {(Object.keys(KIND_LABEL) as FlexKind[]).map((k) => (
          <option key={k} value={k}>
            {KIND_LABEL[k]}
          </option>
        ))}
      </select>
      <input className="field__input field__input--narrow" placeholder={kind === 'payout' ? 'Hours paid, e.g. 8' : 'Hours ±, e.g. -2:30'} value={hours} onChange={(e) => setHours(e.target.value)} />
      <input className="field__input field__input--narrow" type="date" value={date} title="Effective on — empty: today" onChange={(e) => setDate(e.target.value)} />
      <input className="field__input" placeholder={kind === 'adjustment' ? 'Why (required)' : 'Note (optional)'} value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="btn btn--primary" type="submit" disabled={busy || hours.trim() === ''}>
        BOOK →
      </button>
      {problem && <span className="receive-bar__hint mono qty-neg">{problem}</span>}
    </form>
  );
}

/** The cap, floor and daily maximum — from the flexitime agreement, entered by the office. */
function FlexRules({ onError, onSaved }: { onError: (err: unknown) => void; onSaved: () => void }) {
  const [settings, setSettings] = useState<LeaveSettings | null>(null);
  const [cap, setCap] = useState('');
  const [floor, setFloor] = useState('');
  const [dailyMax, setDailyMax] = useState('');

  const load = useCallback(async () => {
    try {
      const s = (await api.leaveSettings()).settings;
      setSettings(s);
      setCap(s.flex_cap_minutes === null ? '' : fmtHm(s.flex_cap_minutes));
      setFloor(s.flex_floor_minutes === null ? '' : `-${fmtHm(-s.flex_floor_minutes)}`);
      setDailyMax(fmtHm(s.daily_max_minutes));
    } catch (err) {
      onError(err);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!settings) return;
    const capMinutes = cap.trim() === '' ? null : parseHours(cap);
    const floorMinutes = floor.trim() === '' ? null : parseHours(floor.trim().startsWith('-') ? floor : `-${floor.trim()}`);
    const max = parseHours(dailyMax);
    if ((cap.trim() !== '' && capMinutes === null) || (floor.trim() !== '' && floorMinutes === null) || max === null) {
      onError(new Error('Hours as e.g. 40, 38,5 or 10:30'));
      return;
    }
    try {
      await api.saveLeaveSettings({ ...settings, flex_cap_minutes: capMinutes, flex_floor_minutes: floorMinutes, daily_max_minutes: max });
      await load();
      onSaved();
    } catch (err) {
      onError(err);
    }
  }

  if (!settings) return null;
  return (
    <>
      <div className="section-title mono">FLEXITIME RULES</div>
      <div className="editbar">
        <label className="field">
          <span className="field__label mono">CAP — ABOVE IS OVERTIME</span>
          <input className="field__input field__input--narrow" placeholder="e.g. 40 — empty: none" value={cap} onChange={(e) => setCap(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label mono">FLOOR</span>
          <input className="field__input field__input--narrow" placeholder="e.g. -20 — empty: none" value={floor} onChange={(e) => setFloor(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label mono">DAILY MAXIMUM</span>
          <input className="field__input field__input--narrow" placeholder="e.g. 10" value={dailyMax} onChange={(e) => setDailyMax(e.target.value)} />
        </label>
        <button className="btn btn--primary" onClick={() => void save()}>
          SAVE RULES
        </button>
      </div>
    </>
  );
}
