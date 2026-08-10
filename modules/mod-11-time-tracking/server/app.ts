import express, { type NextFunction, type Request, type Response } from 'express';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import type Database from 'better-sqlite3';
import { weekStartOf } from '../shared/time.js';
import type { FieldError } from '../shared/types.js';
import {
  actorOf,
  checkCredentials,
  clearedCookie,
  createToken,
  requireAuth,
  sessionCookie,
  type AuthConfig,
} from './auth.js';
import { exportRange } from './csv.js';
import { noopPlatform, type PlatformHooks } from './platform.js';
import { nullVerifier, type LoginVerifier } from './sso.js';
import { EXPORT_PROFILES, getProfile } from './export-profiles.js';
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
  if (errors.length > 0) fail(errors);
  return { name, client, billableDefault, rateCents, active };
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
}

export function createApp({ db, hardening, auth, staticDir, platform = noopPlatform, verifyLogin = nullVerifier }: AppOptions): express.Express {
  const app = express();

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
    res.setHeader('Set-Cookie', sessionCookie(auth, createToken(auth, actor)));
    res.json({ ok: true, username: actor });
  });

  // ── Everything below requires a valid session ────────────────────────
  app.use('/api', requireAuth(auth));

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  app.get('/api/me', (_req, res) => {
    res.json({ username: actorOf(res, auth) });
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

  // ── Time entries & daily grid ─────────────────────────────────────────
  app.get('/api/day', (req, res) => {
    const errors: FieldError[] = [];
    const employeeId = reqId(req.query.employee_id, 'employee_id', errors);
    const date = reqDate(req.query.date ?? todayIso(), 'date', errors);
    if (errors.length > 0) fail(errors);
    res.json(daySheet(db, employeeId, date));
  });

  app.post('/api/entries', (req, res) => {
    const id = createEntry(db, validateEntry(body(req)));
    res.status(201).json(getEntry(db, id));
  });

  app.get('/api/entries/:id', (req, res) => {
    res.json(getEntry(db, Number(req.params.id)));
  });

  app.put('/api/entries/:id', (req, res) => {
    updateEntry(db, Number(req.params.id), validateEntry(body(req)));
    res.json(getEntry(db, Number(req.params.id)));
  });

  app.delete('/api/entries/:id', (req, res) => {
    deleteEntry(db, Number(req.params.id));
    res.json({ ok: true });
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
