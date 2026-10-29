import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, RunningTimer } from '../../shared/types';
import { api, ApiError, timer as timerApi } from '../api';
import { Can } from '../access';
import { fmtHm } from '../format';

/**
 * Start, change, stop or discard the person's timer (server/timer.ts). The
 * clock runs on the server; this only shows it, ticking from `started_at`.
 * Stopping writes an ordinary entry — capped at local midnight and the daily
 * maximum — and `onStopped` lets the screen around it reload.
 */
export function TimerWidget({ employeeId, onStopped, onError }: { employeeId: number; onStopped?: () => void; onError: (err: unknown) => void }) {
  const [running, setRunning] = useState<RunningTimer | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [note, setNote] = useState('');
  const [stoppedAt, setStoppedAt] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  // Held in a ref: screens pass a fresh callback each render, which must not reload the timer every time.
  const report = useRef(onError);
  report.current = onError;

  const load = useCallback(async () => {
    try {
      const [t, p] = await Promise.all([timerApi.get(employeeId), api.projects(true)]);
      setRunning(t.timer);
      setProjects(p.projects);
      if (t.timer) {
        setProjectId(String(t.timer.project_id));
        setTaskId(t.timer.task_id === null ? '' : String(t.timer.task_id));
        setNote(t.timer.note ?? '');
      }
    } catch (err) {
      report.current(err);
    }
  }, [employeeId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-render twice a minute so the elapsed time moves; the figure itself is derived from started_at.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [running]);

  async function run(action: () => Promise<string | void>) {
    setBusy(true);
    setMessage('');
    try {
      const said = await action();
      if (said) setMessage(said);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.details.length > 0) setMessage(`${err.message}: ${err.details.map((d) => d.message).join(' · ')}`);
      else if (err instanceof ApiError && err.status !== 401) setMessage(err.message);
      else report.current(err);
    } finally {
      setBusy(false);
    }
  }

  const project = projects.find((p) => String(p.id) === projectId);
  const body = () => ({ employee_id: employeeId, project_id: Number(projectId), task_id: taskId === '' ? null : Number(taskId), note: note.trim() || null });
  const elapsed = running ? Math.max(0, Math.floor((Date.now() - Date.parse(running.started_at)) / 60_000)) : 0;

  return (
    <div className={`timer ${running ? 'is-running' : ''}`}>
      <div className="timer__head mono">
        <span>{running ? `⏱ RUNNING ${fmtHm(elapsed)}` : '⏱ TIMER'}</span>
        {running && <span className="table__id">since {new Date(running.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
      </div>
      <div className="editbar">
        <select className="field__input" value={projectId} onChange={(e) => (setProjectId(e.target.value), setTaskId(''))}>
          <option value="">Project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.client ? ` · ${p.client}` : ''}
            </option>
          ))}
        </select>
        <select className="field__input" value={taskId} onChange={(e) => setTaskId(e.target.value)} disabled={!project || project.tasks.length === 0}>
          <option value="">No task</option>
          {project?.tasks
            .filter((t) => t.active)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </select>
        <input className="field__input" placeholder="Note" value={note} onChange={(e) => setNote(e.target.value)} />
        <Can>
          {!running ? (
            <button className="btn btn--primary" disabled={busy || projectId === ''} onClick={() => void run(async () => void (await timerApi.start(body())))}>
              START
            </button>
          ) : (
            <>
              <button className="btn" disabled={busy || projectId === ''} title="Book the running time to this project instead" onClick={() => void run(async () => void (await timerApi.update(body())))}>
                CHANGE
              </button>
              <input
                className="field__input field__input--narrow"
                type="time"
                title="Forgot to stop? When did you finish (today)"
                value={stoppedAt}
                onChange={(e) => setStoppedAt(e.target.value)}
              />
              <button
                className="btn btn--primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    // Today at that time, in the browser's own clock; the server refuses a time before the start or in the future.
                    let at: string | undefined;
                    if (stoppedAt) {
                      const [h, m] = stoppedAt.split(':').map(Number);
                      const d = new Date();
                      d.setHours(h!, m!, 0, 0);
                      at = d.toISOString();
                    }
                    const r = await timerApi.stop({ employee_id: employeeId, stopped_at: at });
                    setStoppedAt('');
                    onStopped?.();
                    if (r.discarded) return 'Under a minute — nothing was booked.';
                    return r.capped ? `Booked ${fmtHm(r.minutes)} — capped at midnight or the daily maximum; correct it if you worked on.` : `Booked ${fmtHm(r.minutes)}.`;
                  })
                }
              >
                STOP
              </button>
              <button
                className="rowbtn rowbtn--danger"
                disabled={busy}
                onClick={() => {
                  if (confirm('Throw this timer away? Nothing is booked.')) void run(async () => void (await timerApi.discard({ employee_id: employeeId })));
                }}
              >
                DISCARD
              </button>
            </>
          )}
        </Can>
      </div>
      {message && <div className="mono table__id">{message}</div>}
    </div>
  );
}
