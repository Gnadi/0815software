import express, { type NextFunction, type Request, type Response } from 'express';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import type Database from 'better-sqlite3';
import { weekStartOf } from '../shared/time.js';
import type { FieldError } from '../shared/types.js';
import {
  accessOf,
  actorOf,
  checkCredentials,
  clearedCookie,
  createToken,
  requireAuth,
  sessionCookie,
  type AuthConfig,
} from './auth.js';
import { createHandoff, isRedeemPath, requestedAccess, safeServiceTokenEqual } from './handoff.js';
import { parseSummaryContext } from '../shared/summary.js';
import { moduleSummary } from './summary.js';
import { exportRange } from './csv.js';
import { importTransfer } from './transfer-import.js';
import { noopPlatform, OfferFetchError, type PlatformHooks } from './platform.js';
import { LOCAL_LOGIN, nullVerifier, type LoginMode, type LoginVerifier } from './sso.js';
import { EXPORT_PROFILES, getProfile } from './export-profiles.js';
import { assertMayRecordFor, employeeOf } from './ownership.js';
import { discardTimer, readTimerSettings, runningTimer, runningTimers, startTimer, stopTimer, timerSettingsStamp, updateTimer, validateTimerSettings, writeTimerSettings, type TimerInput } from './timer.js';
import { dueReminders, listReminders, runReminders } from './reminders.js';
import { myOverview } from './my-area.js';
import {
  addEntitlement,
  balance,
  calendar,
  createRequest,
  decideRequest,
  getRequest,
  holidaysOf,
  leaveSettingsStamp,
  listEntitlements,
  listRequests,
  readLeaveSettings,
  requestEvents,
  validateLeaveSettings,
  withdrawRequest,
  writeLeaveSettings,
  type Viewer,
} from './leave.js';
import { FLEX_KINDS, LEAVE_STATUSES, LEAVE_TYPES, TASK_STATUSES, type FlexKind, type LeaveStatus, type LeaveType, type TaskStatus } from '../shared/types.js';
import { addSchedule, listSchedules } from './schedules.js';
import { board, createMilestone, deleteMilestone, getBoardTask, moveTask, planTask, portfolio, taskEvents, tasksOf, updateMilestone } from './planning.js';
import { addFlexEntry, flexAccount, flexDays, flexMonthCsv, flexOverview, listFlexEntries, monthEnd } from './flextime.js';
import {
  approveTimesheet,
  createEmployee,
  createEntry,
  createProject,
  createTask,
  daySheet,
  deleteEmployee,
  deleteEntry,
  deleteProject,
  deleteTask,
  DomainError,
  getEmployee,
  getEntry,
  getProject,
  listEmployees,
  listProjects,
  listTimesheets,
  rangeSummary,
  rejectTimesheet,
  submitTimesheet,
  timesheetDetail,
  todayIso,
  updateEmployee,
  updateEntry,
  updateProject,
  updateTask,
  type EmployeeInput,
  type EntryInput,
  type ProjectInput,
} from './tracking.js';

// ── Tiny validation helpers ────────────────────────────────────────────

function body(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null
    ? (req.body as Record<string, unknown>)
    : {};
}

function fail(details: FieldError[]): never {
  throw new DomainError(422, 'Validation failed', details);
}

function reqId(raw: unknown, field: string, errors: FieldError[]): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) errors.push({ field, message: `${field} must be a positive integer id` });
  return n;
}

function optText(raw: unknown, field: string, errors: FieldError[], maxLength = 200): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    errors.push({ field, message: `${field} must be a string` });
    return null;
  }
  if (raw.length > maxLength) errors.push({ field, message: `${field} must be at most ${maxLength} characters` });
  return raw;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function reqDate(raw: unknown, field: string, errors: FieldError[]): string {
  if (typeof raw !== 'string' || !DATE_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    errors.push({ field, message: `${field} must be a date in YYYY-MM-DD format` });
    return '';
  }
  return raw;
}

function optBool(raw: unknown, field: string, errors: FieldError[]): boolean | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'boolean') return raw;
  errors.push({ field, message: `${field} must be a boolean` });
  return null;
}

function reqCents(raw: unknown, field: string, errors: FieldError[]): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 100_000_000) {
    errors.push({ field, message: `${field} must be a non-negative integer amount in cents` });
    return 0;
  }
  return n;
}

function validateProject(input: Record<string, unknown>): ProjectInput {
  const errors: FieldError[] = [];
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '' || name.length > 160) errors.push({ field: 'name', message: 'Name is required (max 160 characters)' });
  const client = optText(input.client, 'client', errors, 160);
  const billableDefault = optBool(input.billable_default, 'billable_default', errors) ?? true;
  const rateCents = reqCents(input.rate_cents ?? 0, 'rate_cents', errors);
  const active = optBool(input.active, 'active', errors) ?? true;
  // Budget in minutes; absent keeps it, null clears it.
  let budgetMinutes: number | null | undefined;
  if (input.budget_minutes === null || input.budget_minutes === '') budgetMinutes = null;
  else if (input.budget_minutes !== undefined) {
    const b = Number(input.budget_minutes);
    if (!Number.isInteger(b) || b <= 0 || b > 6_000_000) errors.push({ field: 'budget_minutes', message: 'budget_minutes is a positive whole number of minutes, or null' });
    else budgetMinutes = b;
  }
  if (errors.length > 0) fail(errors);
  return { name, client, billableDefault, rateCents, active, budgetMinutes };
}

function validateEmployee(input: Record<string, unknown>): EmployeeInput {
  const errors: FieldError[] = [];
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '' || name.length > 160) errors.push({ field: 'name', message: 'Name is required (max 160 characters)' });
  const email = optText(input.email, 'email', errors, 160);
  if (email !== null && !/^\S+@\S+\.\S+$/.test(email)) {
    errors.push({ field: 'email', message: 'Email must look like an email address' });
  }
  if (errors.length > 0) fail(errors);
  return { name, email };
}

function validateEntry(input: Record<string, unknown>): EntryInput {
  const errors: FieldError[] = [];
  const employeeId = reqId(input.employee_id, 'employee_id', errors);
  const projectId = reqId(input.project_id, 'project_id', errors);
  let taskId: number | null = null;
  if (input.task_id !== undefined && input.task_id !== null && input.task_id !== '') {
    taskId = reqId(input.task_id, 'task_id', errors);
  }
  const entryDate = reqDate(input.entry_date, 'entry_date', errors);

  // Minutes: integer, strictly positive, at most one full day (1440).
  const minutes = Number(input.minutes);
  if (
    typeof input.minutes === 'boolean' ||
    input.minutes === '' ||
    input.minutes === null ||
    input.minutes === undefined ||
    !Number.isInteger(minutes) ||
    minutes <= 0 ||
    minutes > 1440
  ) {
    errors.push({ field: 'minutes', message: 'Minutes must be a whole number between 1 and 1440' });
  }
  const billable = optBool(input.billable, 'billable', errors);
  const note = optText(input.note, 'note', errors, 500);
  if (errors.length > 0) fail(errors);
  return { employeeId, projectId, taskId, entryDate, minutes, billable, note };
}

export interface AppOptions {
  /** Optional transport hardening; omit it (as the tests do) to run unthrottled. */
  hardening?: HardeningConfig;
  db: Database.Database;
  auth: AuthConfig;
  /** Absolute path to the built client (dist/client). Omit to serve API only. */
  staticDir?: string;
  /** Optional PS-07 Audit integration; defaults to a no-op (standalone). */
  platform?: PlatformHooks;
  verifyLogin?: LoginVerifier;
  /**
   * The platform machine token (PLATFORM_SERVICE_TOKEN). When set, it is the
   * only credential that opens the shell summary and the handoff routes — the
   * caller is another service in the same stack, not a human. Unset means all
   * of them are closed, which is the standalone default.
   */
  serviceToken?: string;
  /**
   * The shell origins allowed to embed this module and to sign users into it
   * (SHELL_ORIGIN). Empty — the default — leaves the handoff routes unmounted
   * entirely and keeps `X-Frame-Options: DENY` in `hardening.ts`. A list, so a
   * stack can run both MOD-15 Workspace and MOD-16 Mosaic.
   */
  shellOrigins?: string[];
  /**
   * Which credentials the login form should name, served as-is from
   * GET /api/auth-mode. Defaults to this module's own — the standalone case.
   */
  loginMode?: LoginMode;
}

export function createApp({ db, hardening, auth, staticDir, platform = noopPlatform, verifyLogin = nullVerifier, loginMode = LOCAL_LOGIN, serviceToken, shellOrigins = [] }: AppOptions): express.Express {
  const app = express();
  const handoff = shellOrigins.length > 0 ? createHandoff(auth) : null;

  // Transport hardening: security headers, a default-deny CORS policy and
  // per-IP rate limits. Mounted only when a config is passed — index.ts always
  // passes one, tests do not, so suites stay unthrottled and deterministic.
  if (hardening) {
    // Behind the stack's reverse proxy every socket peer is the proxy, so the
    // forwarded chain is what per-IP limiting and audit logging must read.
    if (hardening.trustProxy > 0) app.set('trust proxy', hardening.trustProxy);
    app.use(hardeningMiddleware(hardening));
  }
  app.use(express.json({ limit: '1mb' }));

  // ── Public routes ────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Readiness for a deployment healthcheck: the database is reachable and the
  // schema is in place. Liveness (the process answers at all) is /api/health.
  app.get('/api/ready', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ ready: true });
    } catch {
      res.status(503).json({ ready: false });
    }
  });

  // Which credentials this deployment accepts, read by the login form before
  // anyone is signed in — hence public. With SSO configured, PS-01 validates
  // logins and this module's own admin credentials are rejected, so a form
  // advertising them would send people at a password that cannot work. The org
  // slug is deployment configuration, not a secret.
  app.get('/api/auth-mode', (_req, res) => {
    res.json(loginMode);
  });

  app.post('/api/login', async (req, res) => {
    const { username, password } = body(req);
    // SSO seam: when IDENTITY_URL is set, PS-01 validates the credentials;
    // otherwise the local admin credentials do. Either way the module mints
    // its own session below, so the rest of the request path is unchanged.
    const viaSso = await verifyLogin(username, password);
    // An unreachable PS-01 is not a wrong password. Saying 401 here would tell
    // the user to check credentials that were never checked, and would let a
    // broken identity deployment look like a wave of bad logins; 503 says what
    // actually happened, to the user and to whatever is monitoring this.
    if (viaSso !== null && !viaSso.ok && viaSso.reason === 'unavailable') {
      res.status(503).json({ error: 'Identity service unavailable' });
      return;
    }
    // Who signed in: the PS-01 identity when SSO validated it, the local admin
    // otherwise. It rides in the session token and ends up on every audit
    // entry and history row the session writes.
    const actor =
      viaSso === null
        ? checkCredentials(auth, username, password)
          ? auth.username
          : null
        : viaSso.ok
          ? viaSso.actor
          : null;
    if (actor === null) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    // The level rides in the token next to the actor: the local admin manages,
    // a PS-01 identity gets what its module permissions grant.
    const access = viaSso !== null && viaSso.ok ? viaSso.access : 'manage';
    res.setHeader('Set-Cookie', sessionCookie(auth, createToken(auth, actor, Date.now(), access)));
    res.json({ ok: true, username: actor, access });
  });

  // ── Machine-to-machine ───────────────────────────────────────────────
  // Authenticated with the platform machine token, NOT a staff session: the
  // caller is another service in the same stack. With no token configured
  // every route below is closed, which is the standalone default.
  function requireServiceToken(req: Request): void {
    const provided = req.headers['x-service-token'];
    if (!serviceToken || typeof provided !== 'string' || !safeServiceTokenEqual(provided, serviceToken)) {
      throw new DomainError(401, 'Service token required');
    }
  }

  // What this module looks like on a shell's board (shared/summary.ts).
  app.get('/api/summary', (req, res, next) => {
  // Only ours when a machine token is actually presented.
    //
    // MOD-11 already serves a session-guarded /api/summary of its own, and this
    // route is mounted above the session gate, so without the fallthrough it
    // would shadow that endpoint and answer 401 to the module's own frontend.
    // Rather than give one module a different path from the other fourteen —
    // the contract is worth more than the collision is expensive — this route
    // claims only the requests that are unambiguously the shell's.
    if (req.headers['x-service-token'] === undefined) {
      next();
      return;
    }
        requireServiceToken(req);
    res.json(moduleSummary(db, parseSummaryContext(req.query as Record<string, unknown>)));
  });

  // ── Shell handoff ────────────────────────────────────────────────────
  // Mounted only when the operator named a shell in SHELL_ORIGIN, so a
  // standalone module has no such surface at all. See handoff.ts for why the
  // destination is signed into the ticket rather than passed alongside it.
  if (handoff) {
    app.post('/api/session/handoff', (req, res) => {
      requireServiceToken(req);
      const { actor, path, access } = body(req);
      const level = requestedAccess(access);
      if (typeof actor !== 'string' || actor.trim() === '') throw new DomainError(422, 'actor is required');
      const target = path === undefined ? '/' : path;
      if (!isRedeemPath(target)) throw new DomainError(422, 'path must be module-relative');
      if (level === null) throw new DomainError(422, 'access must be view, edit or manage');
      res.json(handoff.issue(actor.trim(), target, Date.now(), level));
    });

    app.post('/api/session/issue', (req, res) => {
      requireServiceToken(req);
      const { actor, access } = body(req);
      const level = requestedAccess(access);
      if (typeof actor !== 'string' || actor.trim() === '') throw new DomainError(422, 'actor is required');
      if (level === null) throw new DomainError(422, 'access must be view, edit or manage');
      res.json(handoff.issueSession(actor.trim(), Date.now(), level));
    });

    // The browser lands here from an iframe `src`. Deliberately NOT under
    // /api: it is a navigation, and it must stay outside the session gate
    // below — it is how a session is obtained in the first place.
    app.get('/session/handoff', (req, res) => {
      const result = handoff.redeem(req.query.ticket);
      if (!result.ok) {
        // One status for all three verdicts. Which of "never issued",
        // "already used" and "expired" a ticket hit is not something an
        // unauthenticated caller gets to probe for.
        res.status(401).type('text/plain').send('Handoff ticket is not valid');
        return;
      }
      res.setHeader('Set-Cookie', result.cookie);
      res.redirect(302, result.location);
    });
  }

  // ── Everything below requires a valid session ────────────────────────
  app.use('/api', requireAuth(auth));

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  app.get('/api/me', (_req, res) => {
    const actor = actorOf(res, auth);
    // Which employee this identity is, so the screens open on the person's own
    // sheet — and, below `manage`, offer no other (server/ownership.ts).
    res.json({ username: actor, access: accessOf(res), employee_id: employeeOf(db, actor) });
  });

  // ── Projects & tasks ─────────────────────────────────────────────────
  app.get('/api/projects', (req, res) => {
    const active = req.query.active === '1' || req.query.active === 'true';
    res.json({ projects: listProjects(db, !active) });
  });

  app.post('/api/projects', (req, res) => {
    const id = createProject(db, validateProject(body(req)));
    res.status(201).json(getProject(db, id));
  });

  // ── Plan an accepted offer as a project ──────────────────────────────
  // The step between selling work and doing it. It fetches the offer as a
  // neutral document transfer (shared/transfer.ts) — the same one MOD-04 bills
  // — and creates a project with one task per line, so hours land against the
  // thing that was sold instead of a single undifferentiated bucket.
  //
  // The offer's money deliberately does NOT come across: a project's rate is
  // what an hour costs and an offer's total is what the job costs, and nothing
  // in the offer says how many hours are in it. See transfer-import.ts.
  //
  // Idempotent on the offer number: a retry returns the project the first call
  // produced, with 200 instead of 201, so one job's hours can never end up
  // split across two projects.
  app.post('/api/projects/import-offer', async (req, res) => {
    const reference = body(req).offer_number;
    if (typeof reference !== 'string' || reference.trim() === '') {
      fail([{ field: 'offer_number', message: 'offer_number is required' }]);
    }
    const offerNumber = reference.trim();

    let transfer: unknown;
    try {
      transfer = await platform.fetchOffer(offerNumber);
    } catch (err) {
      if (err instanceof OfferFetchError) throw new DomainError(err.status === 404 ? 404 : 502, err.message);
      throw err;
    }
    if (transfer === null) {
      throw new DomainError(501, 'No offer source is configured — set OFFERS_URL to plan offers from MOD-13');
    }

    const result = importTransfer(db, transfer);
    if (!result.replayed) {
      void platform.audit({
        actor: actorOf(res, auth),
        action: 'project.imported',
        resource: `project:${result.projectId}`,
        metadata: { origin: offerNumber, source: 'mod-13-offers' },
      });
    }
    res
      .status(result.replayed ? 200 : 201)
      .json({ ...getProject(db, result.projectId), imported: !result.replayed });
  });

  app.get('/api/projects/:id', (req, res) => {
    res.json(getProject(db, Number(req.params.id)));
  });

  app.put('/api/projects/:id', (req, res) => {
    updateProject(db, Number(req.params.id), validateProject(body(req)));
    res.json(getProject(db, Number(req.params.id)));
  });

  app.delete('/api/projects/:id', (req, res) => {
    deleteProject(db, Number(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/tasks', (req, res) => {
    const errors: FieldError[] = [];
    const name = typeof body(req).name === 'string' ? (body(req).name as string).trim() : '';
    if (name === '' || name.length > 160) errors.push({ field: 'name', message: 'Task name is required (max 160 characters)' });
    if (errors.length > 0) fail(errors);
    createTask(db, Number(req.params.id), name);
    res.status(201).json(getProject(db, Number(req.params.id)));
  });

  app.put('/api/tasks/:id', (req, res) => {
    const errors: FieldError[] = [];
    const name = typeof body(req).name === 'string' ? (body(req).name as string).trim() : '';
    if (name === '' || name.length > 160) errors.push({ field: 'name', message: 'Task name is required (max 160 characters)' });
    const active = optBool(body(req).active, 'active', errors) ?? true;
    if (errors.length > 0) fail(errors);
    updateTask(db, Number(req.params.id), name, active);
    res.json({ ok: true });
  });

  // ── Planning (server/planning.ts) ────────────────────────────────────
  const optDate = (raw: unknown, field: string, errors: FieldError[]): string | null =>
    raw === undefined || raw === null || raw === '' ? null : reqDate(raw, field, errors);
  const optRef = (raw: unknown, field: string, errors: FieldError[]): number | null =>
    raw === undefined || raw === null || raw === '' ? null : reqId(raw, field, errors);

  app.get('/api/portfolio', (req, res) => {
    res.json({ projects: portfolio(db, req.query.archived === '1') });
  });

  app.get('/api/projects/:id/board', (req, res) => {
    res.json(board(db, Number(req.params.id), viewerOf(res)));
  });

  app.get('/api/my-tasks', (req, res) => {
    const viewer = viewerOf(res);
    const own = employeeOf(db, viewer.actor);
    if (own === null) throw new DomainError(404, 'No employee record carries this login');
    res.json({ tasks: tasksOf(db, own, viewer, req.query.done === '1') });
  });

  app.get('/api/tasks/:id', (req, res) => {
    const id = Number(req.params.id);
    res.json({ task: getBoardTask(db, id, viewerOf(res)), events: taskEvents(db, id) });
  });

  app.put('/api/tasks/:id/plan', (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const assigneeId = optRef(input.assignee_id, 'assignee_id', errors);
    const dueDate = optDate(input.due_date, 'due_date', errors);
    let estimateMinutes: number | null = null;
    if (input.estimate_minutes !== undefined && input.estimate_minutes !== null && input.estimate_minutes !== '') {
      const e = Number(input.estimate_minutes);
      if (!Number.isInteger(e) || e <= 0 || e > 600_000) errors.push({ field: 'estimate_minutes', message: 'estimate_minutes is a positive whole number of minutes, or null' });
      else estimateMinutes = e;
    }
    const milestoneId = optRef(input.milestone_id, 'milestone_id', errors);
    const description = optText(input.description, 'description', errors, 2000);
    if (errors.length > 0) fail(errors);
    const id = Number(req.params.id);
    planTask(db, id, { assigneeId, dueDate, estimateMinutes, milestoneId, description });
    const actor = actorOf(res, auth);
    void platform.audit({ actor, action: 'task.planned', resource: `task:${id}`, metadata: { assignee_id: assigneeId, due_date: dueDate, estimate_minutes: estimateMinutes } });
    res.json(getBoardTask(db, id, viewerOf(res)));
  });

  app.post('/api/tasks/:id/status', (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const status = input.status as TaskStatus;
    if (!(TASK_STATUSES as readonly unknown[]).includes(status)) errors.push({ field: 'status', message: `status must be one of: ${TASK_STATUSES.join(', ')}` });
    const note = optText(input.note, 'note', errors, 300);
    if (errors.length > 0) fail(errors);
    const viewer = viewerOf(res);
    const task = moveTask(db, Number(req.params.id), status, note, viewer);
    void platform.audit({ actor: viewer.actor, action: 'task.moved', resource: `task:${task.id}`, metadata: { status } });
    res.json(task);
  });

  const validateMilestone = (input: Record<string, unknown>) => {
    const errors: FieldError[] = [];
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '' || name.length > 160) errors.push({ field: 'name', message: 'Name is required (max 160 characters)' });
    const dueDate = reqDate(input.due_date, 'due_date', errors);
    if (errors.length > 0) fail(errors);
    return { name, dueDate };
  };

  app.post('/api/projects/:id/milestones', (req, res) => {
    const { name, dueDate } = validateMilestone(body(req));
    res.status(201).json(createMilestone(db, Number(req.params.id), name, dueDate));
  });

  app.put('/api/milestones/:id', (req, res) => {
    const { name, dueDate } = validateMilestone(body(req));
    res.json(updateMilestone(db, Number(req.params.id), name, dueDate));
  });

  app.delete('/api/milestones/:id', (req, res) => {
    deleteMilestone(db, Number(req.params.id));
    res.json({ ok: true });
  });

  app.delete('/api/tasks/:id', (req, res) => {
    deleteTask(db, Number(req.params.id));
    res.json({ ok: true });
  });

  // ── Employees ────────────────────────────────────────────────────────
  app.get('/api/employees', (_req, res) => {
    res.json({ employees: listEmployees(db) });
  });

  app.post('/api/employees', (req, res) => {
    const id = createEmployee(db, validateEmployee(body(req)));
    res.status(201).json(getEmployee(db, id));
  });

  app.get('/api/employees/:id', (req, res) => {
    res.json(getEmployee(db, Number(req.params.id)));
  });

  app.put('/api/employees/:id', (req, res) => {
    updateEmployee(db, Number(req.params.id), validateEmployee(body(req)));
    res.json(getEmployee(db, Number(req.params.id)));
  });

  app.delete('/api/employees/:id', (req, res) => {
    deleteEmployee(db, Number(req.params.id));
    res.json({ ok: true });
  });

  // ── Absences (server/leave.ts) ───────────────────────────────────────
  // The policy says who may write at all; leave.ts says whose leave
  // (mayActFor) and who decides (mayDecide) — never one's own.
  const viewerOf = (res: Response): Viewer => ({ actor: actorOf(res, auth), access: accessOf(res) });
  const optInt = (raw: unknown): number | undefined => (raw === undefined || raw === '' ? undefined : Number(raw));

  app.get('/api/leave/requests', (req, res) => {
    const status = typeof req.query.status === 'string' && (LEAVE_STATUSES as readonly string[]).includes(req.query.status) ? (req.query.status as LeaveStatus) : undefined;
    res.json({
      requests: listRequests(db, viewerOf(res), {
        employeeId: optInt(req.query.employee_id),
        year: optInt(req.query.year),
        status,
        toDecide: req.query.to_decide === '1',
      }),
    });
  });

  app.post('/api/leave/requests', (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const viewer = viewerOf(res);
    // Without an employee_id it is one's own leave.
    const employeeId =
      input.employee_id === undefined || input.employee_id === null || input.employee_id === ''
        ? (employeeOf(db, viewer.actor) ?? 0)
        : reqId(input.employee_id, 'employee_id', errors);
    if (employeeId === 0) throw new DomainError(403, `No employee record carries ${viewer.actor} — ask a manager to add your email to it`);
    const type = input.type as LeaveType;
    if (!(LEAVE_TYPES as readonly unknown[]).includes(type)) errors.push({ field: 'type', message: `type must be one of: ${LEAVE_TYPES.join(', ')}` });
    const startDate = reqDate(input.start_date, 'start_date', errors);
    const endDate = input.end_date === undefined || input.end_date === '' ? startDate : reqDate(input.end_date, 'end_date', errors);
    if (input.half_day !== undefined && typeof input.half_day !== 'boolean') errors.push({ field: 'half_day', message: 'half_day is true or false' });
    const note = optText(input.note, 'note', errors, 300);
    if (errors.length > 0) fail(errors);
    const request = createRequest(db, { employeeId, type, startDate, endDate, halfDay: input.half_day === true, note }, viewer);
    void platform.audit({ actor: viewer.actor, action: `leave.${type === 'sick' ? 'recorded' : 'requested'}`, resource: `employee:${employeeId}`, metadata: { request: request.id } });
    res.status(201).json(request);
  });

  app.get('/api/leave/requests/:id', (req, res) => {
    const id = Number(req.params.id);
    res.json({ request: getRequest(db, id, viewerOf(res)), events: requestEvents(db, id) });
  });

  const decide = (decision: 'approved' | 'rejected') => (req: Request, res: Response) => {
    const errors: FieldError[] = [];
    const note = optText(body(req).note, 'note', errors, 300);
    if (decision === 'rejected' && !note) errors.push({ field: 'note', message: 'A rejection says why' });
    if (errors.length > 0) fail(errors);
    const viewer = viewerOf(res);
    const request = decideRequest(db, Number(req.params.id), decision, note, viewer);
    void platform.audit({ actor: viewer.actor, action: `leave.${decision}`, resource: `employee:${request.employee_id}`, metadata: { request: request.id } });
    res.json(request);
  };
  app.post('/api/leave/requests/:id/approve', decide('approved'));
  app.post('/api/leave/requests/:id/reject', decide('rejected'));

  app.post('/api/leave/requests/:id/withdraw', (req, res) => {
    const viewer = viewerOf(res);
    const request = withdrawRequest(db, Number(req.params.id), viewer);
    void platform.audit({ actor: viewer.actor, action: 'leave.withdrawn', resource: `employee:${request.employee_id}`, metadata: { request: request.id } });
    res.json(request);
  });

  app.get('/api/leave/balance', (req, res) => {
    const viewer = viewerOf(res);
    const employeeId = optInt(req.query.employee_id) ?? employeeOf(db, viewer.actor);
    if (employeeId === null || employeeId === undefined) throw new DomainError(404, 'No employee record carries this login');
    res.json(balance(db, employeeId, optInt(req.query.year) ?? Number(todayIso().slice(0, 4))));
  });

  app.get('/api/employees/:id/entitlements', (req, res) => {
    res.json({ entitlements: listEntitlements(db, Number(req.params.id), optInt(req.query.year)) });
  });

  app.post('/api/employees/:id/entitlements', (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const year = Number(input.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) errors.push({ field: 'year', message: 'year is a four-digit year' });
    const kind = input.kind ?? 'allowance';
    if (kind !== 'allowance' && kind !== 'carryover' && kind !== 'adjustment') errors.push({ field: 'kind', message: 'kind is allowance, carryover or adjustment' });
    const days = Number(input.days);
    // Half days count; a correction may be negative, an allowance may not.
    if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 366 || Math.round(days * 2) !== days * 2 || (kind !== 'adjustment' && days < 0)) {
      errors.push({ field: 'days', message: 'days is a non-zero number of whole or half days (negative only as an adjustment)' });
    }
    const note = optText(input.note, 'note', errors, 300);
    if (errors.length > 0) fail(errors);
    const actor = actorOf(res, auth);
    const entry = addEntitlement(db, Number(req.params.id), { year, kind: kind as 'allowance', days, note }, actor);
    void platform.audit({ actor, action: 'leave.entitlement', resource: `employee:${req.params.id}`, metadata: { year, kind, days } });
    res.status(201).json(entry);
  });

  app.get('/api/leave/calendar', (req, res) => {
    const month = typeof req.query.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month) ? req.query.month : todayIso().slice(0, 7);
    res.json({ month, ...calendar(db, month, viewerOf(res)) });
  });

  app.get('/api/leave/holidays', (req, res) => {
    const year = optInt(req.query.year) ?? Number(todayIso().slice(0, 4));
    res.json({ year, holidays: [...holidaysOf(db, year)].map(([date, name]) => ({ date, name })).sort((a, b) => a.date.localeCompare(b.date)) });
  });

  app.get('/api/leave/settings', (_req, res) => {
    res.json({ settings: readLeaveSettings(db), ...leaveSettingsStamp(db) });
  });

  app.put('/api/leave/settings', (req, res) => {
    const settings = validateLeaveSettings(body(req));
    const actor = actorOf(res, auth);
    writeLeaveSettings(db, settings, actor);
    void platform.audit({ actor, action: 'leave.settings', resource: 'leave-settings' });
    res.json({ settings, ...leaveSettingsStamp(db) });
  });

  // ── Working time and flexitime (server/schedules.ts, server/flextime.ts) ──
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

  app.get('/api/employees/:id/schedules', (req, res) => {
    getEmployee(db, Number(req.params.id));
    res.json({ schedules: listSchedules(db, Number(req.params.id)) });
  });

  app.post('/api/employees/:id/schedules', (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const validFrom = reqDate(input.valid_from, 'valid_from', errors);
    // Weekly hours as whole minutes (38.5 h = 2310); null: no flexitime account.
    let weeklyMinutes: number | null = null;
    if (input.weekly_minutes !== null && input.weekly_minutes !== undefined && input.weekly_minutes !== '') {
      const w = Number(input.weekly_minutes);
      if (!Number.isInteger(w) || w <= 0 || w > 4200) errors.push({ field: 'weekly_minutes', message: 'weekly_minutes is whole minutes, 1 to 4200 (70 h), or null' });
      else weeklyMinutes = w;
    }
    const raw = String(input.work_days ?? '');
    if (!/^[1-7]{1,7}$/.test(raw) || new Set(raw).size !== raw.length) {
      errors.push({ field: 'work_days', message: 'Work days are weekday digits 1 (Mon) to 7 (Sun), each once, e.g. 12345' });
    }
    const note = optText(input.note, 'note', errors, 300);
    if (errors.length > 0) fail(errors);
    const actor = actorOf(res, auth);
    const schedule = addSchedule(db, Number(req.params.id), { validFrom, weeklyMinutes, workDays: [...raw].sort().join(''), note }, actor);
    void platform.audit({ actor, action: 'worktime.schedule', resource: `employee:${req.params.id}`, metadata: { valid_from: validFrom, weekly_minutes: weeklyMinutes } });
    res.status(201).json(schedule);
  });

  /** Whose account: the query's employee, or the signed-in person's own. */
  const accountHolder = (req: Request, res: Response): number => {
    const id = optInt(req.query.employee_id) ?? employeeOf(db, viewerOf(res).actor);
    if (id === null || id === undefined) throw new DomainError(404, 'No employee record carries this login');
    return id;
  };

  app.get('/api/flex/account', (req, res) => {
    const errors: FieldError[] = [];
    const asOf = req.query.as_of === undefined ? todayIso() : reqDate(req.query.as_of, 'as_of', errors);
    if (errors.length > 0) fail(errors);
    res.json(flexAccount(db, accountHolder(req, res), asOf, viewerOf(res)));
  });

  app.get('/api/flex/days', (req, res) => {
    const month = typeof req.query.month === 'string' && MONTH_RE.test(req.query.month) ? req.query.month : todayIso().slice(0, 7);
    res.json({ month, days: flexDays(db, accountHolder(req, res), `${month}-01`, monthEnd(month), viewerOf(res)) });
  });

  app.get('/api/flex/overview', (_req, res) => {
    res.json({ as_of: todayIso(), rows: flexOverview(db, todayIso(), viewerOf(res)) });
  });

  app.get('/api/employees/:id/flex-entries', (req, res) => {
    res.json({ entries: listFlexEntries(db, Number(req.params.id)) });
  });

  app.post('/api/employees/:id/flex-entries', (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const kind = input.kind as FlexKind;
    if (!(FLEX_KINDS as readonly unknown[]).includes(kind)) errors.push({ field: 'kind', message: `kind must be one of: ${FLEX_KINDS.join(', ')}` });
    const minutes = Number(input.minutes);
    // A payout is the minutes paid, so positive; a correction may go either way.
    if (!Number.isInteger(minutes) || minutes === 0 || Math.abs(minutes) > 100_000 || (kind === 'payout' && minutes < 0)) {
      errors.push({ field: 'minutes', message: 'minutes is a non-zero whole number (positive for a payout)' });
    }
    const effectiveDate = input.effective_date === undefined ? todayIso() : reqDate(input.effective_date, 'effective_date', errors);
    const note = optText(input.note, 'note', errors, 300);
    if (kind === 'adjustment' && !note) errors.push({ field: 'note', message: 'A correction says why' });
    if (errors.length > 0) fail(errors);
    const actor = actorOf(res, auth);
    const entry = addFlexEntry(db, Number(req.params.id), { kind, minutes, effectiveDate, note }, actor, viewerOf(res));
    void platform.audit({ actor, action: `worktime.${kind}`, resource: `employee:${req.params.id}`, metadata: { minutes: entry.minutes, effective_date: effectiveDate } });
    res.status(201).json(entry);
  });

  app.get('/api/export/flex.csv', (req, res) => {
    if (typeof req.query.month !== 'string' || !MONTH_RE.test(req.query.month)) fail([{ field: 'month', message: 'month must be YYYY-MM' }]);
    const month = req.query.month as string;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="flexitime-${month}.csv"`);
    res.send(flexMonthCsv(db, month, viewerOf(res)));
  });

  // ── Time entries & daily grid ─────────────────────────────────────────
  app.get('/api/day', (req, res) => {
    const errors: FieldError[] = [];
    const employeeId = reqId(req.query.employee_id, 'employee_id', errors);
    const date = reqDate(req.query.date ?? todayIso(), 'date', errors);
    if (errors.length > 0) fail(errors);
    res.json(daySheet(db, employeeId, date));
  });

  app.post('/api/entries', (req, res) => {
    const input = validateEntry(body(req));
    assertMayRecordFor(db, actorOf(res, auth), accessOf(res), input.employeeId);
    const id = createEntry(db, input);
    res.status(201).json(getEntry(db, id));
  });

  app.get('/api/entries/:id', (req, res) => {
    res.json(getEntry(db, Number(req.params.id)));
  });

  app.put('/api/entries/:id', (req, res) => {
    const input = validateEntry(body(req));
    // Both the person the entry is for now and the one it would move to.
    assertMayRecordFor(db, actorOf(res, auth), accessOf(res), getEntry(db, Number(req.params.id)).employee_id);
    assertMayRecordFor(db, actorOf(res, auth), accessOf(res), input.employeeId);
    updateEntry(db, Number(req.params.id), input);
    res.json(getEntry(db, Number(req.params.id)));
  });

  app.delete('/api/entries/:id', (req, res) => {
    assertMayRecordFor(db, actorOf(res, auth), accessOf(res), getEntry(db, Number(req.params.id)).employee_id);
    deleteEntry(db, Number(req.params.id));
    res.json({ ok: true });
  });

  // ── The timer (server/timer.ts) ──────────────────────────────────────
  // Whose timer: the one named, else the signed-in person's own. Held to the
  // same rule as an entry (server/ownership.ts) — below `manage`, only one's own.
  const timerHolder = (raw: unknown, res: Response, write: boolean): number => {
    if (raw !== undefined && raw !== null && raw !== '') {
      const errors: FieldError[] = [];
      const id = reqId(raw, 'employee_id', errors);
      if (errors.length > 0) fail(errors);
      if (write) assertMayRecordFor(db, actorOf(res, auth), accessOf(res), id);
      return id;
    }
    const own = employeeOf(db, actorOf(res, auth));
    if (own === null) throw new DomainError(404, 'No employee record carries this login — name the employee');
    if (write) assertMayRecordFor(db, actorOf(res, auth), accessOf(res), own);
    return own;
  };
  const validateTimer = (input: Record<string, unknown>, employeeId: number): TimerInput => {
    const errors: FieldError[] = [];
    const projectId = reqId(input.project_id, 'project_id', errors);
    const taskId = input.task_id === undefined || input.task_id === null || input.task_id === '' ? null : reqId(input.task_id, 'task_id', errors);
    const billable = optBool(input.billable, 'billable', errors);
    const note = optText(input.note, 'note', errors, 500);
    if (errors.length > 0) fail(errors);
    return { employeeId, projectId, taskId, note, billable };
  };

  app.get('/api/timer', (req, res) => {
    res.json({ timer: runningTimer(db, timerHolder(req.query.employee_id, res, false)) });
  });

  // Who is on the clock right now — the office's view (server/access.ts).
  app.get('/api/timers', (_req, res) => {
    res.json({ timers: runningTimers(db) });
  });

  app.post('/api/timer/start', (req, res) => {
    const input = validateTimer(body(req), timerHolder(body(req).employee_id, res, true));
    res.status(201).json(startTimer(db, input, actorOf(res, auth)));
  });

  app.put('/api/timer', (req, res) => {
    res.json({ timer: updateTimer(db, validateTimer(body(req), timerHolder(body(req).employee_id, res, true))) });
  });

  app.post('/api/timer/stop', (req, res) => {
    const b = body(req);
    const employeeId = timerHolder(b.employee_id, res, true);
    let stoppedAt: number | undefined;
    if (b.stopped_at !== undefined && b.stopped_at !== null && b.stopped_at !== '') {
      stoppedAt = typeof b.stopped_at === 'string' ? Date.parse(b.stopped_at) : NaN;
      if (Number.isNaN(stoppedAt)) fail([{ field: 'stopped_at', message: 'stopped_at is an ISO date-time' }]);
    }
    res.json(stopTimer(db, employeeId, actorOf(res, auth), Date.now(), stoppedAt));
  });

  app.post('/api/timer/discard', (req, res) => {
    discardTimer(db, timerHolder(body(req).employee_id, res, true), actorOf(res, auth));
    res.json({ ok: true });
  });

  // ── Timer & reminder settings, reminders (server/reminders.ts) ────────
  const timerSettingsResponse = () => ({ settings: readTimerSettings(db), ...timerSettingsStamp(db), notification_configured: Boolean(platform.notificationConfigured) });

  app.get('/api/settings/timer', (_req, res) => {
    res.json(timerSettingsResponse());
  });

  app.put('/api/settings/timer', (req, res) => {
    writeTimerSettings(db, validateTimerSettings(body(req)), actorOf(res, auth));
    res.json(timerSettingsResponse());
  });

  app.get('/api/reminders', (_req, res) => {
    res.json({ sent: listReminders(db), due: dueReminders(db).map(({ body: _b, ...r }) => r), notification_configured: Boolean(platform.notificationConfigured) });
  });

  // Send what is due now, without waiting for the tick.
  app.post('/api/reminders/run', async (_req, res) => {
    if (!platform.notificationConfigured) throw new DomainError(501, 'No notification hub is configured — set NOTIFICATION_URL to send reminders');
    res.json({ sent: await runReminders(db, platform) });
  });

  // ── My area (server/my-area.ts) ──────────────────────────────────────
  app.get('/api/my-overview', (_req, res) => {
    const viewer = viewerOf(res);
    const own = employeeOf(db, viewer.actor);
    if (own === null) throw new DomainError(404, 'No employee record carries this login — ask a manager to add your email to one');
    res.json(myOverview(db, own, viewer));
  });

  // ── Weekly timesheets & approval ──────────────────────────────────────
  app.get('/api/timesheets', (req, res) => {
    const errors: FieldError[] = [];
    const employeeId = reqId(req.query.employee_id, 'employee_id', errors);
    if (errors.length > 0) fail(errors);
    res.json({ timesheets: listTimesheets(db, employeeId) });
  });

  app.get('/api/timesheets/:employeeId/:weekStart', (req, res) => {
    const errors: FieldError[] = [];
    const employeeId = reqId(req.params.employeeId, 'employee_id', errors);
    const weekStart = reqDate(req.params.weekStart, 'week_start', errors);
    if (errors.length > 0) fail(errors);
    // Normalise to the Monday so a mid-week date still resolves the week.
    res.json(timesheetDetail(db, employeeId, weekStartOf(weekStart)));
  });

  function transitionHandler(
    fn: (
      db: Database.Database,
      employeeId: number,
      weekStart: string,
      actor: string,
      note: string | null,
    ) => unknown,
    withNote: boolean,
  ) {
    return (req: Request, res: Response) => {
      const errors: FieldError[] = [];
      const employeeId = reqId(body(req).employee_id, 'employee_id', errors);
      const weekStart = reqDate(body(req).week_start, 'week_start', errors);
      const note = withNote ? optText(body(req).note, 'note', errors, 300) : null;
      if (errors.length > 0) fail(errors);
      res.json(fn(db, employeeId, weekStartOf(weekStart), actorOf(res, auth), note));
    };
  }

  app.post('/api/timesheets/submit', (req, res) => {
    const errors: FieldError[] = [];
    const employeeId = reqId(body(req).employee_id, 'employee_id', errors);
    const weekStart = reqDate(body(req).week_start, 'week_start', errors);
    if (errors.length > 0) fail(errors);
    assertMayRecordFor(db, actorOf(res, auth), accessOf(res), employeeId);
    const submitted = submitTimesheet(db, employeeId, weekStartOf(weekStart), actorOf(res, auth));
    void platform.audit({ actor: actorOf(res, auth), action: 'timesheet.submitted', resource: `employee:${employeeId}`, metadata: { week_start: weekStartOf(weekStart) } });
    res.json(submitted);
  });
  app.post('/api/timesheets/approve', transitionHandler(approveTimesheet, true));
  app.post('/api/timesheets/reject', transitionHandler(rejectTimesheet, true));

  // ── Summaries (derived rollups) ───────────────────────────────────────
  app.get('/api/summary', (req, res) => {
    const errors: FieldError[] = [];
    const from = reqDate(req.query.from, 'from', errors);
    const to = reqDate(req.query.to, 'to', errors);
    if (errors.length > 0) fail(errors);
    if (from > to) fail([{ field: 'to', message: 'to must be on or after from' }]);
    res.json(rangeSummary(db, from, to));
  });

  // ── CSV export (payroll / billing) ────────────────────────────────────
  app.get('/api/export/profiles', (_req, res) => {
    res.json({
      profiles: EXPORT_PROFILES.map((p) => ({
        name: p.name,
        description: p.description,
        scope: p.scope,
        delimiter: p.delimiter,
        columns: p.columns.map((c) => ({ header: c.header })),
      })),
    });
  });

  app.get('/api/export/timesheets.csv', (req, res) => {
    const errors: FieldError[] = [];
    const name = typeof req.query.profile === 'string' ? req.query.profile : '';
    const profile = getProfile(name);
    if (!profile) {
      errors.push({
        field: 'profile',
        message: `profile must be one of: ${EXPORT_PROFILES.map((p) => p.name).join(', ')}`,
      });
    }
    const from = reqDate(req.query.from, 'from', errors);
    const to = reqDate(req.query.to, 'to', errors);
    if (errors.length > 0 || !profile) fail(errors);
    if (from > to) fail([{ field: 'to', message: 'to must be on or after from' }]);
    const csv = exportRange(db, profile, from, to);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="timesheet-${profile.name.toLowerCase()}-${from}_${to}.csv"`,
    );
    res.send(csv);
  });

  // ── Static client (production build) ─────────────────────────────────
  if (staticDir) {
    app.use(express.static(staticDir));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api')) {
        res.sendFile('index.html', { root: staticDir });
        return;
      }
      next();
    });
  }

  // ── Error mapping ────────────────────────────────────────────────────
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof DomainError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
