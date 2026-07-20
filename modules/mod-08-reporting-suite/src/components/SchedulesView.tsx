import { useCallback, useEffect, useState } from 'react';
import type { Report, RunRow, ScheduleRow } from '../../shared/types';
import { api, ApiError } from '../api';
import { ts } from '../format';

interface Props {
  onAuthLost: () => void;
}

export function SchedulesView({ onAuthLost }: Props) {
  const [reports, setReports] = useState<Report[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [r, s, h] = await Promise.all([api.reports(), api.schedules(), api.runs()]);
      setReports(r.reports);
      setSchedules(s.schedules);
      setRuns(h.runs);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const scheduleFor = (reportId: number): ScheduleRow | undefined =>
    schedules.find((s) => s.report_id === reportId);

  async function save(reportId: number, interval: string, enabled: boolean) {
    try {
      await api.upsertSchedule(reportId, { interval, enabled });
      void load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  async function runNow(scheduleId: number) {
    try {
      await api.runSchedule(scheduleId);
      void load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : 'Run failed');
    }
  }

  async function removeSchedule(scheduleId: number) {
    try {
      await api.deleteSchedule(scheduleId);
      void load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">EXPORTS &amp; SCHEDULES</div>
          <h1 className="resource__title">Schedules</h1>
          <p className="resource__desc">
            Per-report CSV export schedules run by an in-process scheduler while the server is up.
            Next-due is derived from the last run; there is no catch-up backfill. Run history is
            append-only.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="section-title mono">PER-REPORT SCHEDULE</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Report</th>
              <th>Interval</th>
              <th>Enabled</th>
              <th>Last run</th>
              <th>Next due</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {reports.length === 0 ? (
              <tr>
                <td className="table__empty mono" colSpan={6}>
                  NO REPORTS
                </td>
              </tr>
            ) : (
              reports.map((r) => {
                const s = scheduleFor(r.id);
                return (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td>
                      <select
                        className="field__input"
                        style={{ width: 120 }}
                        value={s?.interval ?? 'daily'}
                        onChange={(e) => void save(r.id, e.target.value, s ? !!s.enabled : true)}
                      >
                        <option value="hourly">hourly</option>
                        <option value="daily">daily</option>
                      </select>
                    </td>
                    <td>
                      {s ? (
                        <button
                          className="rowbtn"
                          onClick={() => void save(r.id, s.interval, !s.enabled)}
                        >
                          {s.enabled ? 'ON' : 'OFF'}
                        </button>
                      ) : (
                        <span className="mono" style={{ color: 'var(--fg-mute)' }}>
                          —
                        </span>
                      )}
                    </td>
                    <td className="mono">{ts(s?.last_run_at ?? null)}</td>
                    <td className="mono">{s ? ts(s.next_due_at) : '—'}</td>
                    <td className="table__rowactions">
                      {s ? (
                        <>
                          <button className="rowbtn" onClick={() => void runNow(s.id)}>
                            RUN NOW
                          </button>
                          <button
                            className="rowbtn rowbtn--danger"
                            onClick={() => void removeSchedule(s.id)}
                          >
                            UNSCHEDULE
                          </button>
                        </>
                      ) : (
                        <button className="rowbtn" onClick={() => void save(r.id, 'daily', true)}>
                          SCHEDULE
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="section-title mono">RUN HISTORY · {runs.length}</div>
      <div className="table-wrap result-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Report</th>
              <th>Trigger</th>
              <th>Status</th>
              <th>Started</th>
              <th>Rows</th>
              <th>File</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 ? (
              <tr>
                <td className="table__empty mono" colSpan={7}>
                  NO RUNS YET
                </td>
              </tr>
            ) : (
              runs.map((run) => (
                <tr key={run.id}>
                  <td className="mono">{run.id}</td>
                  <td>{run.report_name}</td>
                  <td className="mono">{run.trigger}</td>
                  <td>
                    <span className={`badge badge--${run.status}`}>{run.status.toUpperCase()}</span>
                  </td>
                  <td className="mono">{ts(run.started_at)}</td>
                  <td className="table__num">{run.row_count ?? '—'}</td>
                  <td className="mono" style={{ color: 'var(--fg-mute)', fontSize: 11 }}>
                    {run.file_path ?? run.error ?? '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
