import { useCallback, useEffect, useState } from 'react';
import type { Project } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtEur } from '../format';

interface Props {
  onAuthLost: () => void;
}

interface Draft {
  name: string;
  client: string;
  billable_default: boolean;
  rate_eur: string;
  active: boolean;
}

const EMPTY: Draft = { name: '', client: '', billable_default: true, rate_eur: '0', active: true };

export function ProjectsView({ onAuthLost }: Props) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<number | null>(null);
  const [taskName, setTaskName] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    try {
      const { projects: list } = await api.projects();
      setProjects(list);
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
    try {
      const values = {
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

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ TT.04 · ALLOCATION</div>
          <h1 className="resource__title">Projects &amp; Tasks</h1>
          <p className="resource__desc">
            What time is booked against. Each project carries a billable default and an hourly rate
            (used to derive billable amounts). Optional tasks sit under a project. A project with
            entries can't be deleted — archive it.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

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
              </div>
              <div className="table__rowactions">
                <button
                  className="rowbtn"
                  onClick={() => {
                    setEditing(p.id);
                    setDraft({
                      name: p.name,
                      client: p.client ?? '',
                      billable_default: p.billable_default,
                      rate_eur: (p.rate_cents / 100).toFixed(2),
                      active: p.active,
                    });
                  }}
                >
                  EDIT
                </button>
                <button className="rowbtn" onClick={() => void toggleArchive(p)}>
                  {p.active ? 'ARCHIVE' : 'RESTORE'}
                </button>
                <button
                  className="rowbtn rowbtn--danger"
                  onClick={() => void remove(p)}
                  disabled={p.entry_count > 0}
                  title={p.entry_count > 0 ? 'Has entries — archive instead' : ''}
                >
                  DELETE
                </button>
              </div>
            </div>
            <div className="pcard__tasks">
              {p.tasks.map((t) => (
                <span key={t.id} className="taskchip mono">
                  {t.name}
                  <button
                    className="taskchip__x"
                    onClick={() => void removeTask(t.id)}
                    disabled={t.entry_count > 0}
                    title={t.entry_count > 0 ? 'Has entries' : 'Remove task'}
                  >
                    ×
                  </button>
                </span>
              ))}
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
            </div>
          </div>
        ))}
        {projects && projects.length === 0 && <div className="table__empty mono">NO PROJECTS YET</div>}
      </div>
    </div>
  );
}
