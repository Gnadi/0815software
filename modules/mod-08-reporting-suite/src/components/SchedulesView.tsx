import { Fragment, useCallback, useEffect, useState } from 'react';
import type { ParamValues, Report, RunRow, ScheduleRow } from '../../shared/types';
import { api, ApiError, errorText } from '../api';
import { ts } from '../format';
import { Can, useCan } from '../access';
import { ParamForm, describeValues, given } from './ParamForm';

interface Props {
  onAuthLost: () => void;
}

export function SchedulesView({ onAuthLost }: Props) {
  const [reports, setReports] = useState<Report[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const canEdit = useCan();
  const [error, setError] = useState('');
  // The report whose parameter values are open for editing, and the draft.
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<ParamValues>({});

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

  /** Fields left out stay as they are on the server. */
  async function save(reportId: number, patch: Record<string, unknown>): Promise<boolean> {
    try {
      const current = scheduleFor(reportId);
      await api.upsertSchedule(reportId, { interval: current?.interval ?? 'daily', enabled: current ? !!current.enabled : true, ...patch });
      setError('');
      void load();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(errorText(err, 'Save failed'));
      return false;
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
            Per-report export schedules — CSV or Excel — run by an in-process scheduler while the
            server is up. A report with parameters runs with the values saved here; a relative date
            such as &ldquo;start of last month&rdquo; is resolved at each run, in the time zone set
            under Settings. Next-due is derived from the last run; there is no catch-up backfill.
            Run history is append-only and records the values each run used.
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
              <th>Format</th>
              <th>Values</th>
              <th>Enabled</th>
              <th>Last run</th>
              <th>Next due</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {reports.length === 0 ? (
              <tr>
                <td className="table__empty mono" colSpan={8}>
                  NO REPORTS
                </td>
              </tr>
            ) : (
              reports.map((r) => {
                const s = scheduleFor(r.id);
                return (
                  <Fragment key={r.id}>
                  <tr>
                    <td>{r.name}</td>
                    <td>
                      <select
                        className="field__input"
                        style={{ width: 100 }}
                        value={s?.interval ?? 'daily'}
                        disabled={!canEdit}
                        onChange={(e) => void save(r.id, { interval: e.target.value })}
                      >
                        <option value="hourly">hourly</option>
                        <option value="daily">daily</option>
                      </select>
                    </td>
                    <td>
                      <select
                        className="field__input"
                        style={{ width: 80 }}
                        value={s?.format ?? 'csv'}
                        disabled={!canEdit || !s}
                        onChange={(e) => void save(r.id, { format: e.target.value })}
                      >
                        <option value="csv">csv</option>
                        <option value="xlsx">xlsx</option>
                      </select>
                    </td>
                    <td className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
                      {r.params.length === 0 ? (
                        <span style={{ color: 'var(--fg-mute)' }}>—</span>
                      ) : (
                        <div className="table__wrap">
                          {describeValues(s?.param_values) || 'defaults'}{' '}
                          {s && canEdit && (
                            <button
                              className="rowbtn"
                              onClick={() => {
                                setEditing(editing === r.id ? null : r.id);
                                setDraft({ ...s.param_values });
                              }}
                            >
                              {editing === r.id ? 'CLOSE' : 'SET'}
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      {s ? (
                        <Can>
                          <button
                            className="rowbtn"
                            onClick={() => void save(r.id, { enabled: !s.enabled })}
                          >
                            {s.enabled ? 'ON' : 'OFF'}
                          </button>
                        </Can>
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
                          <Can>
                            <button className="rowbtn" onClick={() => void runNow(s.id)}>
                              RUN NOW
                            </button>
                          </Can>
                          <Can>
                            <button
                              className="rowbtn rowbtn--danger"
                              onClick={() => void removeSchedule(s.id)}
                            >
                              UNSCHEDULE
                            </button>
                          </Can>
                        </>
                      ) : (
                        <Can>
                          <button className="rowbtn" onClick={() => void save(r.id, { interval: 'daily', enabled: true })}>
                            SCHEDULE
                          </button>
                        </Can>
                      )}
                    </td>
                  </tr>
                  {editing === r.id && s && (
                    <tr>
                      <td colSpan={8}>
                        <ParamForm params={r.params} values={draft} onChange={setDraft}>
                          <button
                            className="btn btn--primary"
                            onClick={() => void save(r.id, { params: given(draft) }).then((ok) => ok && setEditing(null))}
                          >
                            SAVE VALUES
                          </button>
                        </ParamForm>
                      </td>
                    </tr>
                  )}
                  </Fragment>
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
              <th>Values</th>
              <th>File</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 ? (
              <tr>
                <td className="table__empty mono" colSpan={8}>
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
                  <td className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
                    <div className="table__wrap">{describeValues(run.params) || '—'}</div>
                  </td>
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
