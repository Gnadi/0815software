import { useCallback, useEffect, useState } from 'react';
import type { Project, ProjectProgress } from '../../shared/types';
import { api, ApiError, planning } from '../api';
import { fmtEur, fmtHm, parseHours } from '../format';
import { Can } from '../access';
import { ProjectBoard } from './ProjectBoard';

interface Props {
  onAuthLost: () => void;
}

interface Draft {
  name: string;
  client: string;
  billable_default: boolean;
  rate_eur: string;
  budget_hours: string;
  active: boolean;
}

const EMPTY: Draft = { name: '', client: '', billable_default: true, rate_eur: '0', budget_hours: '', active: true };

export function ProjectsView({ onAuthLost }: Props) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<number | null>(null);
  const [taskName, setTaskName] = useState<Record<number, string>>({});
  const [progress, setProgress] = useState<Map<number, ProjectProgress>>(new Map());
  const [boardFor, setBoardFor] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ projects: list }, { projects: figures }] = await Promise.all([api.projects(), planning.portfolio(true)]);
      setProjects(list);
      setProgress(new Map(figures.map((f) => [f.project_id, f])));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  function rateCents(): number {
    return Math.round(parseFloat(draft.rate_eur.replace(',', '.') || '0') * 100);
  }

  async function save() {
    setError('');
    const budget = draft.budget_hours.trim() === '' ? null : parseHours(draft.budget_hours);
    if (draft.budget_hours.trim() !== '' && (budget === null || budget <= 0)) {
      setError('Budget in hours, e.g. 80 or 37:30 — or empty for none');
      return;
    }
    try {
      const values = {
        budget_minutes: budget,
        name: draft.name,
        client: draft.client || null,
        billable_default: draft.billable_default,
        rate_cents: rateCents(),
        active: draft.active,
      };
      if (editing) await api.updateProject(editing, values);
      else await api.createProject(values);
      setDraft(EMPTY);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  }

  async function remove(p: Project) {
    if (!confirm(`Delete "${p.name}"? (Only possible with no entries — otherwise archive it.)`)) return;
    setError('');
    try {
      await api.deleteProject(p.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  async function toggleArchive(p: Project) {
    setError('');
    try {
      await api.updateProject(p.id, {
        name: p.name,
        client: p.client,
        billable_default: p.billable_default,
        rate_cents: p.rate_cents,
        active: !p.active,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function addTask(projectId: number) {
    const name = (taskName[projectId] ?? '').trim();
    if (!name) return;
    setError('');
    try {
      await api.createTask(projectId, name);
      setTaskName((m) => ({ ...m, [projectId]: '' }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add task');
    }
  }

  async function removeTask(id: number) {
    setError('');
    try {
      await api.deleteTask(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete task');
    }
  }

  if (boardFor !== null) {
    return (
      <ProjectBoard
        projectId={boardFor}
        onBack={() => {
          setBoardFor(null);
          void load();
        }}
        onAuthLost={onAuthLost}
      />
    );
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ TT.04 · ALLOCATION</div>
          <h1 className="resource__title">Projects &amp; Tasks</h1>
          <p className="resource__desc">
            What time is booked against, and the work to plan. Each project carries a billable
            default, an hourly rate and an optional budget in hours; open a project's board to
            plan its tasks and milestones. A project with entries can't be deleted — archive it.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <Can level="manage">
        <div className="editbar editbar--wrap">
          <input
            className="field__input"
            placeholder="Project name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <input
            className="field__input"
            placeholder="Client (optional)"
            value={draft.client}
            onChange={(e) => setDraft({ ...draft, client: e.target.value })}
          />
          <label className="inline-check mono">
            <input
              type="checkbox"
              checked={draft.billable_default}
              onChange={(e) => setDraft({ ...draft, billable_default: e.target.checked })}
            />
            BILLABLE
          </label>
          <input
            className="field__input field__input--narrow"
            placeholder="Rate €/h"
            value={draft.rate_eur}
            onChange={(e) => setDraft({ ...draft, rate_eur: e.target.value })}
          />
          <input
            className="field__input field__input--narrow"
            placeholder="Budget h (optional)"
            value={draft.budget_hours}
            onChange={(e) => setDraft({ ...draft, budget_hours: e.target.value })}
          />
          <button className="btn btn--primary" onClick={() => void save()} disabled={!draft.name.trim()}>
            {editing ? 'SAVE' : 'ADD'}
          </button>
          {editing && (
            <button
              className="btn btn--ghost"
              onClick={() => {
                setEditing(null);
                setDraft(EMPTY);
              }}
            >
              CANCEL
            </button>
          )}
        </div>
      </Can>

      <div className="cards">
        {projects?.map((p) => (
          <div key={p.id} className={`pcard ${p.active ? '' : 'is-archived'}`}>
            <div className="pcard__head">
              <div>
                <div className="pcard__name">
                  {p.name} {!p.active && <span className="badge badge--offboarded">ARCHIVED</span>}
                </div>
                <div className="pcard__meta mono">
                  {p.client ?? 'no client'} · {p.billable_default ? 'BILLABLE' : 'NON-BILLABLE'} ·{' '}
                  {fmtEur(p.rate_cents)}/h · {p.entry_count} entries
                </div>
                <ProgressLine progress={progress.get(p.id)} />
              </div>
              <div className="table__rowactions">
                <button className="rowbtn" onClick={() => setBoardFor(p.id)}>
                  BOARD →
                </button>
                <Can level="manage">
                  <button
                    className="rowbtn"
                    onClick={() => {
                      setEditing(p.id);
                      setDraft({
                        name: p.name,
                        client: p.client ?? '',
                        billable_default: p.billable_default,
                        rate_eur: (p.rate_cents / 100).toFixed(2),
                        budget_hours: p.budget_minutes === null ? '' : fmtHm(p.budget_minutes),
                        active: p.active,
                      });
                    }}
                  >
                    EDIT
                  </button>
                </Can>
                <Can level="manage">
                  <button className="rowbtn" onClick={() => void toggleArchive(p)}>
                    {p.active ? 'ARCHIVE' : 'RESTORE'}
                  </button>
                </Can>
                <Can level="manage">
                  <button
                    className="rowbtn rowbtn--danger"
                    onClick={() => void remove(p)}
                    disabled={p.entry_count > 0}
                    title={p.entry_count > 0 ? 'Has entries — archive instead' : ''}
                  >
                    DELETE
                  </button>
                </Can>
              </div>
            </div>
            <div className="pcard__tasks">
              {p.tasks.map((t) => (
                <span key={t.id} className="taskchip mono">
                  {t.name}
                  <Can level="manage">
                    <button
                      className="taskchip__x"
                      onClick={() => void removeTask(t.id)}
                      disabled={t.entry_count > 0}
                      title={t.entry_count > 0 ? 'Has entries' : 'Remove task'}
                    >
                      ×
                    </button>
                  </Can>
                </span>
              ))}
              <Can level="manage">
                <span className="taskchip taskchip--add">
                  <input
                    className="taskchip__input mono"
                    placeholder="+ task"
                    value={taskName[p.id] ?? ''}
                    onChange={(e) => setTaskName((m) => ({ ...m, [p.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void addTask(p.id);
                    }}
                  />
                </span>
              </Can>
            </div>
          </div>
        ))}
        {projects && projects.length === 0 && <div className="table__empty mono">NO PROJECTS YET</div>}
      </div>
    </div>
  );
}

/** Where a project stands, in one line — all of it derived on the server. */
function ProgressLine({ progress }: { progress: ProjectProgress | undefined }) {
  if (!progress) return null;
  const total = Object.values(progress.counts).reduce((a, b) => a + b, 0);
  const over = progress.budget_minutes !== null && progress.spent_minutes > progress.budget_minutes;
  return (
    <div className="pcard__meta mono">
      <span className={over ? 'qty-neg' : ''}>
        {fmtHm(progress.spent_minutes)} h spent{progress.budget_minutes !== null && ` of ${fmtHm(progress.budget_minutes)} h budget`}
      </span>
      {total > 0 && ` · ${progress.counts.done}/${total} tasks done`}
      {progress.overdue_tasks > 0 && <span className="qty-neg"> · {progress.overdue_tasks} overdue</span>}
      {progress.next_milestone && ` · ◆ ${progress.next_milestone.name} ${progress.next_milestone.due_date}`}
    </div>
  );
}
