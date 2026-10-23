import { useCallback, useEffect, useState } from 'react';
import type { BoardTask } from '../../shared/types';
import { ApiError, planning } from '../api';
import { fmtEffort, MoveButtons, STATUS_LABEL } from './ProjectBoard';

/**
 * The tasks assigned to the signed-in person, across projects, soonest due
 * first. Moving one here is the same move as on the board — the server checks
 * it is theirs (server/ownership.ts, mayMoveTask).
 */
export function MyTasksView({ onAuthLost }: { onAuthLost: () => void }) {
  const [tasks, setTasks] = useState<BoardTask[] | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Request failed');
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    try {
      setTasks((await planning.myTasks(showDone)).tasks);
    } catch (err) {
      handle(err);
    }
  }, [showDone, handle]);

  useEffect(() => {
    void load();
  }, [load]);

  async function move(task: BoardTask, to: BoardTask['status']) {
    setBusy(true);
    setError('');
    try {
      await planning.move(task.id, to);
      await load();
    } catch (err) {
      handle(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ TT.08 · MY WORK</div>
          <h1 className="resource__title">My tasks</h1>
          <p className="resource__desc">What is assigned to you, soonest due first. Time spent is what you booked against each task.</p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <label className="inline-check mono">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> SHOW DONE
        </label>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Project</th>
              <th>Due</th>
              <th>Status</th>
              <th className="table__num">Spent / estimate</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tasks?.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={6}>
                  NOTHING ASSIGNED TO YOU
                </td>
              </tr>
            )}
            {tasks?.map((t) => (
              <tr key={t.id}>
                <td>
                  {t.name}
                  {t.description && <div className="cell-note">{t.description}</div>}
                </td>
                <td>{t.project_name}</td>
                <td className={`mono ${t.overdue ? 'qty-neg' : ''}`}>{t.due_date ?? '—'}</td>
                <td className="mono">{STATUS_LABEL[t.status].toUpperCase()}</td>
                <td className={`table__num mono ${t.over_estimate ? 'qty-neg' : ''}`}>{fmtEffort(t)}</td>
                <td>
                  <MoveButtons task={t} busy={busy} onMove={(to) => void move(t, to)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
