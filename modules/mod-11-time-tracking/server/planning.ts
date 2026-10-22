import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import type { BoardTask, Milestone, ProjectProgress, TaskEvent, TaskStatus } from '../shared/types.js';
import { TASK_STATUSES } from '../shared/types.js';
import { mayMoveTask } from './ownership.js';
import { DomainError, getProject, nowIso, TASK_SELECT, todayIso, toTask, type TaskStored } from './tracking.js';

/**
 * Planning — the projects and tasks time is booked against, as work to plan.
 *
 * Here and not in a module of its own because the projects and tasks already
 * live here: a second project list elsewhere would have to be kept in step
 * with this one, and every hour booked would land in one and be planned in
 * the other.
 *
 * - **Stored:** what a person decides — a task's place on the board, who does
 *   it, by when, its estimate, its milestone; a milestone's name and date; a
 *   project's budget in hours.
 * - **Derived:** everything that follows from the time booked and the date —
 *   spent, remaining, over estimate, overdue; whether a milestone is reached
 *   (all its tasks done) or late; a project's spent hours against its budget.
 * - **Append-only:** every move across the board is an event with the person.
 * - **Who:** `manage` plans (tasks, assignees, estimates, milestones, budget,
 *   see server/access.ts); the person a task is assigned to moves it
 *   (`mayMoveTask`, server/ownership.ts).
 */

export interface Viewer {
  actor: string;
  access: AccessLevel;
}

function toBoardTask(db: Database.Database, row: TaskStored & { project_name: string }, viewer: Viewer, today: string): BoardTask {
  const task = toTask(row);
  return {
    ...task,
    project_name: row.project_name,
    overdue: task.due_date !== null && task.due_date < today && task.status !== 'done',
    over_estimate: task.estimate_minutes !== null && task.spent_minutes > task.estimate_minutes,
    remaining_minutes: task.estimate_minutes === null ? null : Math.max(0, task.estimate_minutes - task.spent_minutes),
    can_move: task.active && mayMoveTask(db, viewer.actor, viewer.access, task.assignee_id),
  };
}

const BOARD_SELECT = TASK_SELECT.replace('SELECT t.id,', 'SELECT p.name AS project_name, t.id,').replace(
  'FROM tasks t',
  'FROM tasks t JOIN projects p ON p.id = t.project_id',
);

const ORDER = 'ORDER BY t.due_date IS NULL, t.due_date, t.id';

function taskRow(db: Database.Database, id: number): TaskStored & { project_name: string } {
  const row = db.prepare(`${BOARD_SELECT} WHERE t.id = ?`).get(id) as (TaskStored & { project_name: string }) | undefined;
  if (!row) throw new DomainError(404, 'Task not found');
  return row;
}

export function getBoardTask(db: Database.Database, id: number, viewer: Viewer, today = todayIso()): BoardTask {
  return toBoardTask(db, taskRow(db, id), viewer, today);
}

export function listMilestones(db: Database.Database, projectId: number, today = todayIso()): Milestone[] {
  const rows = db
    .prepare(
      `SELECT m.*, COUNT(t.id) AS task_count, COALESCE(SUM(t.status = 'done'), 0) AS done_count
         FROM milestones m LEFT JOIN tasks t ON t.milestone_id = m.id AND t.active = 1
        WHERE m.project_id = ? GROUP BY m.id ORDER BY m.due_date, m.id`,
    )
    .all(projectId) as (Omit<Milestone, 'reached' | 'late'> & { created_at: string })[];
  return rows.map(({ created_at: _created, ...m }) => {
    const reached = m.task_count > 0 && m.done_count === m.task_count;
    return { ...m, reached, late: !reached && m.due_date < today };
  });
}

/** The board for one project: its tasks (active ones), milestones and progress. */
export function board(db: Database.Database, projectId: number, viewer: Viewer, today = todayIso()) {
  getProject(db, projectId);
  const tasks = (db.prepare(`${BOARD_SELECT} WHERE t.project_id = ? AND t.active = 1 ${ORDER}`).all(projectId) as (TaskStored & {
    project_name: string;
  })[]).map((r) => toBoardTask(db, r, viewer, today));
  return { progress: progress(db, projectId, today), milestones: listMilestones(db, projectId, today), tasks };
}

export function progress(db: Database.Database, projectId: number, today = todayIso()): ProjectProgress {
  const project = getProject(db, projectId);
  const tasks = project.tasks.filter((t) => t.active);
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, tasks.filter((t) => t.status === s).length])) as Record<TaskStatus, number>;
  const spent = (db.prepare('SELECT COALESCE(SUM(minutes), 0) AS m FROM time_entries WHERE project_id = ?').get(projectId) as { m: number }).m;
  const milestones = listMilestones(db, projectId, today);
  const next = milestones.find((m) => !m.reached);
  return {
    project_id: project.id,
    project_name: project.name,
    client: project.client,
    active: project.active,
    budget_minutes: project.budget_minutes,
    spent_minutes: spent,
    estimate_minutes: tasks.reduce((sum, t) => sum + (t.estimate_minutes ?? 0), 0),
    counts,
    overdue_tasks: tasks.filter((t) => t.due_date !== null && t.due_date < today && t.status !== 'done').length,
    late_milestones: milestones.filter((m) => m.late).length,
    next_milestone: next ? { name: next.name, due_date: next.due_date } : null,
  };
}

/** Every project with where it stands — the portfolio view. */
export function portfolio(db: Database.Database, includeArchived: boolean, today = todayIso()): ProjectProgress[] {
  const ids = db.prepare(`SELECT id FROM projects ${includeArchived ? '' : 'WHERE active = 1'} ORDER BY active DESC, name`).all() as { id: number }[];
  return ids.map(({ id }) => progress(db, id, today));
}

/** The tasks assigned to one person, open ones first by due date. */
export function tasksOf(db: Database.Database, employeeId: number, viewer: Viewer, includeDone: boolean, today = todayIso()): BoardTask[] {
  const rows = db
    .prepare(
      `${BOARD_SELECT} WHERE t.assignee_id = ? AND t.active = 1 AND p.active = 1 ${includeDone ? '' : "AND t.status <> 'done'"}
       ORDER BY t.status = 'done', t.due_date IS NULL, t.due_date, t.id`,
    )
    .all(employeeId) as (TaskStored & { project_name: string })[];
  return rows.map((r) => toBoardTask(db, r, viewer, today));
}

export interface PlanInput {
  assigneeId: number | null;
  dueDate: string | null;
  estimateMinutes: number | null;
  milestoneId: number | null;
  description: string | null;
}

/** Set a task's plan: who, by when, how long, which milestone. */
export function planTask(db: Database.Database, id: number, input: PlanInput): void {
  const task = taskRow(db, id);
  if (input.assigneeId !== null && !db.prepare('SELECT 1 FROM employees WHERE id = ?').get(input.assigneeId)) {
    throw new DomainError(422, 'Validation failed', [{ field: 'assignee_id', message: 'No such employee' }]);
  }
  if (input.milestoneId !== null) {
    const m = db.prepare('SELECT project_id FROM milestones WHERE id = ?').get(input.milestoneId) as { project_id: number } | undefined;
    // A milestone of another project would make this task count towards it.
    if (!m || m.project_id !== task.project_id) {
      throw new DomainError(422, 'Validation failed', [{ field: 'milestone_id', message: 'The milestone belongs to another project' }]);
    }
  }
  db.prepare('UPDATE tasks SET assignee_id = ?, due_date = ?, estimate_minutes = ?, milestone_id = ?, description = ? WHERE id = ?').run(
    input.assigneeId,
    input.dueDate,
    input.estimateMinutes,
    input.milestoneId,
    input.description,
    id,
  );
}

/** Move a task across the board, as `viewer`. Every move is an event. */
export function moveTask(db: Database.Database, id: number, to: TaskStatus, note: string | null, viewer: Viewer, today = todayIso()): BoardTask {
  return db.transaction((): BoardTask => {
    const row = taskRow(db, id);
    if (row.active !== 1) throw new DomainError(409, 'This task is deactivated — reactivate it to plan it again');
    if (!mayMoveTask(db, viewer.actor, viewer.access, row.assignee_id)) {
      throw new DomainError(403, row.assignee_id === null ? 'Only a manager moves an unassigned task' : 'Only the person it is assigned to, or a manager, moves this task');
    }
    if (row.status === to) throw new DomainError(409, `The task is already ${to.replace('_', ' ')}`);
    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(to, id);
    db.prepare('INSERT INTO task_events (task_id, from_status, to_status, actor, note, at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      row.status,
      to,
      viewer.actor,
      note,
      nowIso(),
    );
    return getBoardTask(db, id, viewer, today);
  })();
}

export function taskEvents(db: Database.Database, id: number): TaskEvent[] {
  taskRow(db, id);
  return db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id').all(id) as TaskEvent[];
}

export function createMilestone(db: Database.Database, projectId: number, name: string, dueDate: string): Milestone {
  getProject(db, projectId);
  const info = db.prepare('INSERT INTO milestones (project_id, name, due_date, created_at) VALUES (?, ?, ?, ?)').run(projectId, name, dueDate, nowIso());
  return listMilestones(db, projectId).find((m) => m.id === Number(info.lastInsertRowid))!;
}

function milestoneProject(db: Database.Database, id: number): number {
  const row = db.prepare('SELECT project_id FROM milestones WHERE id = ?').get(id) as { project_id: number } | undefined;
  if (!row) throw new DomainError(404, 'Milestone not found');
  return row.project_id;
}

export function updateMilestone(db: Database.Database, id: number, name: string, dueDate: string): Milestone {
  const projectId = milestoneProject(db, id);
  db.prepare('UPDATE milestones SET name = ?, due_date = ? WHERE id = ?').run(name, dueDate, id);
  return listMilestones(db, projectId).find((m) => m.id === id)!;
}

/** Delete a milestone; its tasks stay and simply belong to none. */
export function deleteMilestone(db: Database.Database, id: number): void {
  milestoneProject(db, id);
  db.transaction(() => {
    db.prepare('UPDATE tasks SET milestone_id = NULL WHERE milestone_id = ?').run(id);
    db.prepare('DELETE FROM milestones WHERE id = ?').run(id);
  })();
}

/** Open tasks past their due date, across active projects — for the shell. */
export function overdueCount(db: Database.Database, today = todayIso()): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.active = 1 AND p.active = 1 AND t.status <> 'done' AND t.due_date IS NOT NULL AND t.due_date < ?`,
      )
      .get(today) as { n: number }
  ).n;
}
