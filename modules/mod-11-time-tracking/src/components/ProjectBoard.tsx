import { useCallback, useEffect, useState } from 'react';
import type { BoardTask, Employee, Milestone, ProjectProgress, TaskStatus } from '../../shared/types';
import { TASK_STATUSES } from '../../shared/types';
import { api, ApiError, planning } from '../api';
import { Can } from '../access';
import { fmtHm, parseHours } from '../format';

/**
 * One project as a board. Where a task stands is moved by the person doing it
 * (or a manager); who, by when, how long and which milestone are planned by a
 * manager. Spent, remaining, overdue and a milestone being reached are derived
 * on the server from the hours booked and the date (server/planning.ts).
 */

export const STATUS_LABEL: Record<TaskStatus, string> = { todo: 'To do', in_progress: 'In progress', review: 'Review', done: 'Done' };

interface Props {
  projectId: number;
  onBack: () => void;
  onAuthLost: () => void;
}

/** "3:00 / 8:00" — spent against the estimate, or spent alone. */
export function fmtEffort(t: Pick<BoardTask, 'spent_minutes' | 'estimate_minutes'>): string {
  return t.estimate_minutes === null ? fmtHm(t.spent_minutes) : `${fmtHm(t.spent_minutes)} / ${fmtHm(t.estimate_minutes)}`;
}

/** The buttons that move a task one column left or right. */
export function MoveButtons({ task, busy, onMove }: { task: BoardTask; busy: boolean; onMove: (status: TaskStatus) => void }) {
  if (!task.can_move) return null;
  const i = TASK_STATUSES.indexOf(task.status);
  const prev = TASK_STATUSES[i - 1];
  const next = TASK_STATUSES[i + 1];
  return (
    <span className="kcard__moves">
      {prev && (
        <button type="button" className="rowbtn mono" disabled={busy} title={`Back to ${STATUS_LABEL[prev]}`} onClick={() => onMove(prev)}>
          ←
        </button>
      )}
      {next && (
        <button type="button" className="rowbtn mono" disabled={busy} title={`On to ${STATUS_LABEL[next]}`} onClick={() => onMove(next)}>
          {STATUS_LABEL[next].toUpperCase()} →
        </button>
      )}
    </span>
  );
}

export function ProjectBoard({ projectId, onBack, onAuthLost }: Props) {
  const [progress, setProgress] = useState<ProjectProgress | null>(null);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [planning_, setPlanning] = useState<BoardTask | null>(null);
  const [newTask, setNewTask] = useState('');
  const [msName, setMsName] = useState('');
  const [msDate, setMsDate] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof ApiError && err.details.length > 0 ? `${err.message}: ${err.details.map((d) => d.message).join(' · ')}` : err instanceof Error ? err.message : 'Request failed');
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    try {
      const b = await planning.board(projectId);
      setProgress(b.progress);
      setMilestones(b.milestones);
      setTasks(b.tasks);
    } catch (err) {
      handle(err);
    }
  }, [projectId, handle]);

  useEffect(() => {
    void load();
    void api.employees().then(({ employees: list }) => setEmployees(list), handle);
  }, [load, handle]);

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

  if (!progress) return error ? <div className="resource__error mono">{error}</div> : <div className="boot mono">LOADING…</div>;
  const milestoneName = (id: number | null) => milestones.find((m) => m.id === id)?.name;
  const overBudget = progress.budget_minutes !== null && progress.spent_minutes > progress.budget_minutes;

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← PROJECTS
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ TT.04 · BOARD</div>
          <h1 className="resource__title">{progress.project_name}</h1>
          <p className="resource__desc">
            {progress.client ?? 'no client'}
            {progress.next_milestone && (
              <>
                {' '}
                · next milestone {progress.next_milestone.name} on {progress.next_milestone.due_date}
              </>
            )}
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="stat-row">
        <div className="stat">
          <div className="stat__label mono">SPENT{progress.budget_minutes !== null ? ' / BUDGET' : ''}</div>
          <div className={`stat__value ${overBudget ? 'qty-neg' : ''}`}>
            {fmtHm(progress.spent_minutes)}
            {progress.budget_minutes !== null && ` / ${fmtHm(progress.budget_minutes)}`}
          </div>
        </div>
        <div className="stat">
          <div className="stat__label mono">ESTIMATED (TASKS)</div>
          <div className="stat__value">{fmtHm(progress.estimate_minutes)}</div>
        </div>
        <div className="stat">
          <div className="stat__label mono">DONE</div>
          <div className="stat__value">
            {progress.counts.done} / {Object.values(progress.counts).reduce((a, b) => a + b, 0)}
          </div>
        </div>
        <div className="stat">
          <div className="stat__label mono">OVERDUE</div>
          <div className={`stat__value ${progress.overdue_tasks > 0 ? 'qty-neg' : ''}`}>{progress.overdue_tasks}</div>
        </div>
      </div>

      <Can level="manage">
        <div className="editbar" style={{ marginTop: 14 }}>
          <input className="field__input" placeholder="New task" value={newTask} onChange={(e) => setNewTask(e.target.value)} />
          <button
            className="btn btn--primary"
            disabled={busy || newTask.trim() === ''}
            onClick={() => void run(() => api.createTask(projectId, newTask.trim()).then(() => setNewTask('')))}
          >
            ADD TASK
          </button>
        </div>
      </Can>

      <div className="kanban">
        {TASK_STATUSES.map((status) => (
          <div key={status} className="kanban__col">
            <div className="kanban__head mono">
              {STATUS_LABEL[status].toUpperCase()} <span className="table__id">{tasks.filter((t) => t.status === status).length}</span>
            </div>
            {tasks
              .filter((t) => t.status === status)
              .map((t) => (
                <div key={t.id} className={`kcard ${t.overdue ? 'is-overdue' : ''}`}>
                  <div className="kcard__name">{t.name}</div>
                  <div className="kcard__meta mono">
                    {t.assignee_name ?? 'unassigned'}
                    {t.due_date && <span className={t.overdue ? 'qty-neg' : ''}> · due {t.due_date}</span>}
                  </div>
                  <div className="kcard__meta mono">
                    <span className={t.over_estimate ? 'qty-neg' : ''}>{fmtEffort(t)}</span>
                    {t.milestone_id !== null && <> · ◆ {milestoneName(t.milestone_id)}</>}
                  </div>
                  <div className="kcard__actions">
                    <MoveButtons task={t} busy={busy} onMove={(to) => void run(() => planning.move(t.id, to))} />
                    <Can level="manage">
                      <button type="button" className="rowbtn mono" onClick={() => setPlanning(planning_?.id === t.id ? null : t)}>
                        PLAN
                      </button>
                    </Can>
                  </div>
                  {planning_?.id === t.id && (
                    <PlanForm
                      task={t}
                      employees={employees}
                      milestones={milestones}
                      busy={busy}
                      onSave={(values) =>
                        void run(async () => {
                          await planning.plan(t.id, values);
                          setPlanning(null);
                        })
                      }
                    />
                  )}
                </div>
              ))}
          </div>
        ))}
      </div>

      <div className="section-title mono">MILESTONES</div>
      <Can level="manage">
        <div className="editbar">
          <input className="field__input" placeholder="Milestone, e.g. Go-live" value={msName} onChange={(e) => setMsName(e.target.value)} />
          <input className="field__input field__input--narrow" type="date" value={msDate} onChange={(e) => setMsDate(e.target.value)} />
          <button
            className="btn btn--primary"
            disabled={busy || msName.trim() === '' || msDate === ''}
            onClick={() =>
              void run(async () => {
                await planning.addMilestone(projectId, { name: msName.trim(), due_date: msDate });
                setMsName('');
                setMsDate('');
              })
            }
          >
            ADD MILESTONE
          </button>
        </div>
      </Can>
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {milestones.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={4}>
                  NO MILESTONES
                </td>
              </tr>
            )}
            {milestones.map((m) => (
              <tr key={m.id}>
                <td className="mono table__id">{m.due_date}</td>
                <td>◆ {m.name}</td>
                <td className="mono">
                  {m.reached ? (
                    <span className="badge badge--active">REACHED</span>
                  ) : m.late ? (
                    <span className="qty-neg">LATE</span>
                  ) : (
                    'OPEN'
                  )}{' '}
                  · {m.done_count} / {m.task_count} tasks done
                </td>
                <td>
                  <Can level="manage">
                    <div className="table__rowactions">
                      <button
                        className="rowbtn rowbtn--danger"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(`Delete milestone "${m.name}"? Its tasks stay.`)) void run(() => planning.deleteMilestone(m.id));
                        }}
                      >
                        DELETE
                      </button>
                    </div>
                  </Can>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlanForm({
  task,
  employees,
  milestones,
  busy,
  onSave,
}: {
  task: BoardTask;
  employees: Employee[];
  milestones: Milestone[];
  busy: boolean;
  onSave: (values: Record<string, unknown>) => void;
}) {
  const [assignee, setAssignee] = useState(task.assignee_id === null ? '' : String(task.assignee_id));
  const [due, setDue] = useState(task.due_date ?? '');
  const [estimate, setEstimate] = useState(task.estimate_minutes === null ? '' : fmtHm(task.estimate_minutes));
  const [milestone, setMilestone] = useState(task.milestone_id === null ? '' : String(task.milestone_id));
  const [description, setDescription] = useState(task.description ?? '');
  const [problem, setProblem] = useState('');

  return (
    <div className="kcard__plan">
      <select className="field__input" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
        <option value="">Unassigned</option>
        {employees.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      <input className="field__input" type="date" value={due} title="Due" onChange={(e) => setDue(e.target.value)} />
      <input className="field__input" placeholder="Estimate, e.g. 8 or 7:30" value={estimate} onChange={(e) => setEstimate(e.target.value)} />
      <select className="field__input" value={milestone} onChange={(e) => setMilestone(e.target.value)}>
        <option value="">No milestone</option>
        {milestones.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <textarea className="field__input" rows={2} placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
      {problem && <div className="qty-neg mono">{problem}</div>}
      <button
        type="button"
        className="btn btn--primary btn--sm"
        disabled={busy}
        onClick={() => {
          const minutes = estimate.trim() === '' ? null : parseHours(estimate);
          if (estimate.trim() !== '' && (minutes === null || minutes <= 0)) {
            setProblem('Estimate in hours, e.g. 8 or 7:30');
            return;
          }
          onSave({
            assignee_id: assignee === '' ? null : Number(assignee),
            due_date: due || null,
            estimate_minutes: minutes,
            milestone_id: milestone === '' ? null : Number(milestone),
            description: description.trim() || null,
          });
        }}
      >
        SAVE PLAN
      </button>
    </div>
  );
}
