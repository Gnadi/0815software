import { useCallback, useEffect, useState } from 'react';
import type { MyOverview } from '../../shared/types';
import { ApiError, timer as timerApi } from '../api';
import { Can } from '../access';
import { fmtHm, fmtSignedHm, statusLabel } from '../format';
import type { View } from '../App';
import { TimerWidget } from './TimerWidget';
import { STATUS_LABEL } from './ProjectBoard';
import { TimerSettingsPanel } from './TimerSettingsPanel';

/**
 * "My area": the signed-in person's own figures on one screen, with the
 * timer on top. Every number is the one its own screen shows — the server
 * reads them from the same functions (server/my-area.ts) — and each card
 * leads to that screen.
 */
export function MyAreaView({ onNavigate, onAuthLost }: { onNavigate: (view: View) => void; onAuthLost: () => void }) {
  const [o, setO] = useState<MyOverview | null>(null);
  const [error, setError] = useState('');
  const [noRecord, setNoRecord] = useState(false);

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Request failed');
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    try {
      setO(await timerApi.overview());
      setNoRecord(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNoRecord(true);
      else handle(err);
    }
  }, [handle]);

  useEffect(() => {
    void load();
  }, [load]);

  const card = (label: string, value: string, sub: string, view: View, warn = false) => (
    <button type="button" className="stat stat--link" onClick={() => onNavigate(view)}>
      <div className="stat__label mono">{label}</div>
      <div className={`stat__value ${warn ? 'qty-neg' : ''}`}>{value}</div>
      <div className="stat__sub mono">{sub}</div>
    </button>
  );

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ TT.00 · MY AREA</div>
          <h1 className="resource__title">{o ? o.employee.name : 'My area'}</h1>
          <p className="resource__desc">Your week, your balances and what is waiting on you — each figure is the one its own screen shows.</p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}
      {noRecord && <div className="resource__error mono">NO EMPLOYEE RECORD CARRIES YOUR LOGIN — ASK A MANAGER TO ADD YOUR EMAIL TO ONE</div>}

      {o && (
        <>
          <TimerWidget employeeId={o.employee.id} onStopped={() => void load()} onError={handle} />
          <div className="stat-row">
            {card('THIS WEEK', fmtHm(o.week.minutes), `${o.week.week_start} · ${statusLabel(o.week.status).toUpperCase()}`, 'timesheets')}
            {card(
              'LAST WEEK',
              fmtHm(o.last_week.minutes),
              o.last_week.status === 'draft' && o.last_week.minutes > 0 ? 'NOT SUBMITTED YET' : statusLabel(o.last_week.status).toUpperCase(),
              'timesheets',
              o.last_week.status === 'draft' && o.last_week.minutes > 0,
            )}
            {card('FLEXITIME', o.flex ? fmtSignedHm(o.flex.balance) : '—', o.flex ? (o.flex.over_cap > 0 ? `${fmtHm(o.flex.over_cap)} OVER THE CAP` : o.flex.under_floor > 0 ? `${fmtHm(o.flex.under_floor)} UNDER THE FLOOR` : 'BALANCE TODAY') : 'NO WEEKLY TARGET', 'flex', Boolean(o.flex && (o.flex.over_cap > 0 || o.flex.under_floor > 0)))}
            {card(
              `LEAVE ${o.leave.year}`,
              `${o.leave.free} d`,
              `${o.leave.remaining} LEFT · ${o.leave.pending} REQUESTED${o.next_absence ? ` · NEXT ${o.next_absence.start_date}` : ''}`,
              'absences',
            )}
            {card('MY TASKS', String(o.tasks.open), o.tasks.overdue > 0 ? `${o.tasks.overdue} OVERDUE` : 'OPEN', 'my-tasks', o.tasks.overdue > 0)}
          </div>
          {o.tasks.next.length > 0 && (
            <>
              <div className="section-title mono">NEXT DUE</div>
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {o.tasks.next.map((t) => (
                      <tr key={t.id}>
                        <td className={`mono table__id ${t.overdue ? 'qty-neg' : ''}`}>{t.due_date ?? '—'}</td>
                        <td>{t.name}</td>
                        <td className="mono table__id">{t.project_name}</td>
                        <td className="mono">{STATUS_LABEL[t.status]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {o.pending_requests > 0 && <p className="resource__desc mono">{o.pending_requests} LEAVE REQUEST(S) WAITING FOR A DECISION</p>}
        </>
      )}

      <Can level="manage">
        <TimerSettingsPanel onError={handle} />
      </Can>
    </div>
  );
}
