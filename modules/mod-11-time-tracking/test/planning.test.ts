import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import type { BoardTask } from '../shared/types.js';

/**
 * Planning (server/planning.ts): the projects and tasks time is booked against,
 * planned. A person decides the plan; what follows from the hours booked and
 * the date — spent, remaining, overdue, a milestone reached — is derived. The
 * office plans; the person a task is assigned to moves it.
 *
 * Dates are fixed and far apart from today: 2020 is always past, 2099 always
 * ahead, so "overdue" and "late" do not depend on when the suite runs.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 'test-secret', ttlHours: 1, secureCookie: false };
let db: Database.Database;
let app: Express;
let anna: number;
let bob: number;
let project: number;

const as = (access: AccessLevel, actor: string) => `${COOKIE_NAME}=${createToken(auth, actor, Date.now(), access)}`;
const ANNA = as('edit', 'anna@example.com');
const BOB = as('edit', 'bob@example.com');
const VIEWER = as('view', 'eve@example.com');
const ADMIN = as('manage', 'admin');

const post = (path: string, values: Record<string, unknown>, cookie = ADMIN) => request(app).post(path).set('Cookie', cookie).send(values);
const put = (path: string, values: Record<string, unknown>, cookie = ADMIN) => request(app).put(path).set('Cookie', cookie).send(values);

async function task(name: string, plan: Record<string, unknown> = {}): Promise<number> {
  const created = (await post(`/api/projects/${project}/tasks`, { name }).expect(201)).body;
  const id = created.tasks.find((t: { name: string }) => t.name === name).id as number;
  if (Object.keys(plan).length > 0) await put(`/api/tasks/${id}/plan`, plan).expect(200);
  return id;
}
const move = (id: number, status: string, cookie = ADMIN) => post(`/api/tasks/${id}/status`, { status }, cookie);
const book = (taskId: number | null, minutes: number, employeeId = anna) =>
  post('/api/entries', { employee_id: employeeId, project_id: project, task_id: taskId, entry_date: '2020-03-02', minutes }).expect(201);
const boardOf = async (cookie = ADMIN) => (await request(app).get(`/api/projects/${project}/board`).set('Cookie', cookie).expect(200)).body;
const taskOn = async (id: number, cookie = ADMIN): Promise<BoardTask> => (await boardOf(cookie)).tasks.find((t: BoardTask) => t.id === id);

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, auth });
  anna = (await post('/api/employees', { name: 'Anna', email: 'anna@example.com' }).expect(201)).body.id;
  bob = (await post('/api/employees', { name: 'Bob', email: 'bob@example.com' }).expect(201)).body.id;
  project = (await post('/api/projects', { name: 'Relaunch', client: 'Acme', rate_cents: 9000 }).expect(201)).body.id;
});

describe('the plan — decided by the office', () => {
  it('assigns, dates, estimates and attaches a task to a milestone', async () => {
    const m = (await post(`/api/projects/${project}/milestones`, { name: 'Go-live', due_date: '2099-06-30' }).expect(201)).body;
    const id = await task('Frontend', { assignee_id: anna, due_date: '2099-06-01', estimate_minutes: 600, milestone_id: m.id, description: 'Pages and forms' });
    expect(await taskOn(id)).toMatchObject({
      status: 'todo',
      assignee_id: anna,
      assignee_name: 'Anna',
      due_date: '2099-06-01',
      estimate_minutes: 600,
      milestone_id: m.id,
      description: 'Pages and forms',
      spent_minutes: 0,
      remaining_minutes: 600,
    });
  });

  it('refuses a milestone of another project, an unknown person, and an editor planning', async () => {
    const other = (await post('/api/projects', { name: 'Other' }).expect(201)).body.id;
    const foreign = (await post(`/api/projects/${other}/milestones`, { name: 'X', due_date: '2099-01-01' }).expect(201)).body;
    const id = await task('Backend');
    expect((await put(`/api/tasks/${id}/plan`, { milestone_id: foreign.id }).expect(422)).body.details[0].field).toBe('milestone_id');
    await put(`/api/tasks/${id}/plan`, { assignee_id: 9999 }).expect(422);
    await put(`/api/tasks/${id}/plan`, { estimate_minutes: -5 }).expect(422);
    await put(`/api/tasks/${id}/plan`, { assignee_id: anna }, ANNA).expect(403);
    await post(`/api/projects/${project}/milestones`, { name: 'M', due_date: '2099-01-01' }, ANNA).expect(403);
  });

  it('a project budget is set, kept when not named, and cleared with null', async () => {
    const base = { name: 'Relaunch', client: 'Acme', rate_cents: 9000 };
    await put(`/api/projects/${project}`, { ...base, budget_minutes: 6000 }).expect(200);
    await put(`/api/projects/${project}`, base).expect(200);
    expect((await boardOf()).progress.budget_minutes).toBe(6000);
    await put(`/api/projects/${project}`, { ...base, budget_minutes: null }).expect(200);
    expect((await boardOf()).progress.budget_minutes).toBeNull();
  });
});

describe('the board — moved by the person doing the work', () => {
  it('the assignee moves their own task; every move is an event with the person', async () => {
    const id = await task('Frontend', { assignee_id: anna });
    expect((await move(id, 'in_progress', ANNA).expect(200)).body).toMatchObject({ status: 'in_progress', can_move: true });
    await move(id, 'review', ANNA).expect(200);
    await move(id, 'review', ANNA).expect(409);
    const events = (await request(app).get(`/api/tasks/${id}`).set('Cookie', VIEWER).expect(200)).body.events;
    expect(events.map((e: { from_status: string; to_status: string; actor: string }) => [e.from_status, e.to_status, e.actor])).toEqual([
      ['todo', 'in_progress', 'anna@example.com'],
      ['in_progress', 'review', 'anna@example.com'],
    ]);
  });

  it('nobody else moves it below manage — not a colleague, not an unassigned task, not a viewer', async () => {
    const annas = await task('Frontend', { assignee_id: anna });
    const nobodys = await task('Backend');
    expect((await move(annas, 'done', BOB).expect(403)).body.error).toBe('Only the person it is assigned to, or a manager, moves this task');
    expect((await move(nobodys, 'in_progress', ANNA).expect(403)).body.error).toBe('Only a manager moves an unassigned task');
    await move(annas, 'done', VIEWER).expect(403);
    expect((await taskOn(annas, BOB)).can_move).toBe(false);
    await move(annas, 'done').expect(200);
    await move(nobodys, 'in_progress').expect(200);
    await move(annas, 'nonsense').expect(422);
  });

  it('a deactivated task leaves the board and cannot be moved', async () => {
    const id = await task('Old');
    await put(`/api/tasks/${id}`, { name: 'Old', active: false }).expect(200);
    expect((await boardOf()).tasks).toEqual([]);
    await move(id, 'done').expect(409);
  });
});

describe('what is derived', () => {
  it('spent, remaining and over estimate come from the hours booked', async () => {
    const id = await task('Frontend', { assignee_id: anna, estimate_minutes: 300 });
    await book(id, 240);
    expect(await taskOn(id)).toMatchObject({ spent_minutes: 240, remaining_minutes: 60, over_estimate: false });
    await book(id, 120);
    expect(await taskOn(id)).toMatchObject({ spent_minutes: 360, remaining_minutes: 0, over_estimate: true });
  });

  it('overdue: past its date and not done', async () => {
    const late = await task('Late', { due_date: '2020-01-01' });
    const ahead = await task('Ahead', { due_date: '2099-01-01' });
    expect((await taskOn(late)).overdue).toBe(true);
    expect((await taskOn(ahead)).overdue).toBe(false);
    await move(late, 'done').expect(200);
    expect((await taskOn(late)).overdue).toBe(false);
  });

  it('a milestone is reached when every task on it is done, and late when its date passed first', async () => {
    const m = (await post(`/api/projects/${project}/milestones`, { name: 'Beta', due_date: '2020-06-30' }).expect(201)).body;
    expect(m).toMatchObject({ task_count: 0, reached: false, late: true });
    const a = await task('A', { milestone_id: m.id });
    const b = await task('B', { milestone_id: m.id });
    await move(a, 'done').expect(200);
    expect((await boardOf()).milestones[0]).toMatchObject({ task_count: 2, done_count: 1, reached: false, late: true });
    await move(b, 'done').expect(200);
    expect((await boardOf()).milestones[0]).toMatchObject({ done_count: 2, reached: true, late: false });
  });

  it('a project: every minute booked against the budget, tasks per status, the next milestone', async () => {
    await put(`/api/projects/${project}`, { name: 'Relaunch', budget_minutes: 1200 }).expect(200);
    const a = await task('A', { estimate_minutes: 300, due_date: '2020-01-01' });
    await task('B', { estimate_minutes: 200 });
    await move(a, 'in_progress').expect(200);
    await book(a, 120);
    // Time booked on the project without a task counts too.
    await book(null, 60, bob);
    await post(`/api/projects/${project}/milestones`, { name: 'Later', due_date: '2099-12-31' }).expect(201);
    await post(`/api/projects/${project}/milestones`, { name: 'Sooner', due_date: '2099-01-31' }).expect(201);
    const portfolio = (await request(app).get('/api/portfolio').set('Cookie', VIEWER).expect(200)).body.projects;
    expect(portfolio[0]).toMatchObject({
      project_name: 'Relaunch',
      budget_minutes: 1200,
      spent_minutes: 180,
      estimate_minutes: 500,
      counts: { todo: 1, in_progress: 1, review: 0, done: 0 },
      overdue_tasks: 1,
      late_milestones: 0,
      next_milestone: { name: 'Sooner', due_date: '2099-01-31' },
    });
  });
});

describe('my tasks', () => {
  it('the open tasks assigned to me, soonest first; done ones on request', async () => {
    const later = await task('Later', { assignee_id: anna, due_date: '2099-05-01' });
    const sooner = await task('Sooner', { assignee_id: anna, due_date: '2099-01-01' });
    const undated = await task('Undated', { assignee_id: anna });
    await task('Bobs', { assignee_id: bob });
    const finished = await task('Finished', { assignee_id: anna });
    await move(finished, 'done', ANNA).expect(200);
    const mine = (await request(app).get('/api/my-tasks').set('Cookie', ANNA).expect(200)).body.tasks;
    expect(mine.map((t: BoardTask) => t.id)).toEqual([sooner, later, undated]);
    const all = (await request(app).get('/api/my-tasks?done=1').set('Cookie', ANNA).expect(200)).body.tasks;
    expect(all.map((t: BoardTask) => t.id)).toEqual([sooner, later, undated, finished]);
    await request(app).get('/api/my-tasks').set('Cookie', VIEWER).expect(404);
  });
});

describe('history is kept', () => {
  it('a task or project that has moved on the board is not deleted; a milestone is, and its tasks stay', async () => {
    const moved = await task('Moved');
    const fresh = await task('Fresh');
    await move(moved, 'in_progress').expect(200);
    await request(app).delete(`/api/tasks/${moved}`).set('Cookie', ADMIN).expect(409);
    await request(app).delete(`/api/tasks/${fresh}`).set('Cookie', ADMIN).expect(200);
    await request(app).delete(`/api/projects/${project}`).set('Cookie', ADMIN).expect(409);

    const m = (await post(`/api/projects/${project}/milestones`, { name: 'M', due_date: '2099-01-01' }).expect(201)).body;
    await put(`/api/tasks/${moved}/plan`, { milestone_id: m.id }).expect(200);
    await request(app).delete(`/api/milestones/${m.id}`).set('Cookie', ADMIN).expect(200);
    expect((await taskOn(moved)).milestone_id).toBeNull();
  });
});

describe('an existing database', () => {
  it('gains the planning columns in place; old tasks start as to do', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mod11-planning-'));
    try {
      const path = join(dir, 'old.db');
      // The tables as a database from before planning has them.
      const old = new Database(path);
      old.exec(`
        CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, client TEXT, billable_default INTEGER NOT NULL DEFAULT 1,
          rate_cents INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
        CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
        INSERT INTO projects (name, created_at) VALUES ('Legacy', '2020-01-01T00:00:00Z');
        INSERT INTO tasks (project_id, name) VALUES (1, 'Legacy task');
      `);
      old.close();
      const upgraded = openDb(path);
      expect(upgraded.prepare('SELECT name, status, assignee_id, estimate_minutes FROM tasks').get()).toEqual({
        name: 'Legacy task',
        status: 'todo',
        assignee_id: null,
        estimate_minutes: null,
      });
      expect(upgraded.prepare('SELECT budget_minutes FROM projects').get()).toEqual({ budget_minutes: null });
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
