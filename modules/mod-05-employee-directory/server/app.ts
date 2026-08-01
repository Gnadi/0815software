import express, { type NextFunction, type Request, type Response } from 'express';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import type Database from 'better-sqlite3';
import { EMPLOYEE_STATUSES, type EmployeeStatus, type FieldError } from '../shared/types.js';
import {
  checkCredentials,
  clearedCookie,
  createToken,
  requireAuth,
  sessionCookie,
  type AuthConfig,
} from './auth.js';
import { directoryCsv } from './csv.js';
import { noopPlatform, type PlatformHooks } from './platform.js';
import { nullVerifier, type LoginVerifier } from './sso.js';
import {
  createDepartment,
  createEmployee,
  deleteDepartment,
  DomainError,
  employeeDetail,
  getDepartment,
  listDepartments,
  listEmployees,
  listLocations,
  offboardEmployee,
  onboardingLists,
  orgChart,
  reactivateEmployee,
  setOnboardingFlags,
  todayIso,
  updateDepartment,
  updateEmployee,
  type DepartmentInput,
  type EmployeeInput,
} from './directory.js';

// ── Tiny validation helpers ────────────────────────────────────────────

function body(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null
    ? (req.body as Record<string, unknown>)
    : {};
}

function fail(details: FieldError[]): never {
  throw new DomainError(422, 'Validation failed', details);
}

function reqText(raw: unknown, field: string, errors: FieldError[], maxLength = 120): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '' || value.length > maxLength) {
    errors.push({ field, message: `${field} is required (max ${maxLength} characters)` });
  }
  return value;
}

function optText(raw: unknown, field: string, errors: FieldError[], maxLength = 120): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    errors.push({ field, message: `${field} must be a string` });
    return null;
  }
  const value = raw.trim();
  if (value === '') return null;
  if (value.length > maxLength) {
    errors.push({ field, message: `${field} must be at most ${maxLength} characters` });
  }
  return value;
}

function optId(raw: unknown, field: string, errors: FieldError[]): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    errors.push({ field, message: `${field} must be a positive integer id` });
    return null;
  }
  return n;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function reqDate(raw: unknown, field: string, errors: FieldError[]): string {
  if (typeof raw !== 'string' || !DATE_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    errors.push({ field, message: `${field} must be a date in YYYY-MM-DD format` });
    return '';
  }
  return raw;
}

function validateDepartment(input: Record<string, unknown>): DepartmentInput {
  const errors: FieldError[] = [];
  const name = reqText(input.name, 'name', errors);
  const rawCode = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
  if (!/^[A-Z0-9][A-Z0-9-]{1,11}$/.test(rawCode)) {
    errors.push({ field: 'code', message: 'code must be 2–12 characters (letters, digits, dashes)' });
  }
  const parentId = optId(input.parent_id, 'parent_id', errors);
  if (errors.length > 0) fail(errors);
  return { name, code: rawCode, parentId };
}

function validateEmployee(input: Record<string, unknown>): EmployeeInput {
  const errors: FieldError[] = [];
  const name = reqText(input.name, 'name', errors);
  const email = reqText(input.email, 'email', errors, 160);
  if (email !== '' && !/^\S+@\S+\.\S+$/.test(email)) {
    errors.push({ field: 'email', message: 'email must look like an email address' });
  }
  const jobTitle = reqText(input.job_title, 'job_title', errors);
  const departmentId = optId(input.department_id, 'department_id', errors);
  if (departmentId === null) errors.push({ field: 'department_id', message: 'department_id is required' });
  const managerId = optId(input.manager_id, 'manager_id', errors);
  const phone = optText(input.phone, 'phone', errors, 40);
  const location = optText(input.location, 'location', errors, 80);
  const startDate = reqDate(input.start_date, 'start_date', errors);
  if (errors.length > 0) fail(errors);
  return { name, email, jobTitle, departmentId: departmentId!, managerId, phone, location, startDate };
}

function optBool(raw: unknown, field: string, errors: FieldError[]): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') {
    errors.push({ field, message: `${field} must be a boolean` });
    return undefined;
  }
  return raw;
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
    const authed = viaSso === null ? checkCredentials(auth, username, password) : viaSso === 'ok';
    if (!authed) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    res.setHeader('Set-Cookie', sessionCookie(auth, createToken(auth)));
    res.json({ ok: true, username: auth.username });
  });

  // ── Everything below requires a valid session ────────────────────────
  app.use('/api', requireAuth(auth));

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  app.get('/api/me', (_req, res) => {
    res.json({ username: auth.username });
  });

  // ── Departments ──────────────────────────────────────────────────────
  app.get('/api/departments', (_req, res) => {
    res.json({ departments: listDepartments(db) });
  });

  app.post('/api/departments', (req, res) => {
    const id = createDepartment(db, validateDepartment(body(req)));
    res.status(201).json(getDepartment(db, id));
  });

  app.get('/api/departments/:id', (req, res) => {
    res.json(getDepartment(db, Number(req.params.id)));
  });

  app.put('/api/departments/:id', (req, res) => {
    updateDepartment(db, Number(req.params.id), validateDepartment(body(req)));
    res.json(getDepartment(db, Number(req.params.id)));
  });

  app.delete('/api/departments/:id', (req, res) => {
    deleteDepartment(db, Number(req.params.id));
    res.json({ ok: true });
  });

  // ── Employees / directory ────────────────────────────────────────────
  function filtersFrom(req: Request) {
    const errors: FieldError[] = [];
    const rawStatus = typeof req.query.status === 'string' && req.query.status !== '' ? req.query.status : undefined;
    if (rawStatus && !(EMPLOYEE_STATUSES as readonly string[]).includes(rawStatus)) {
      errors.push({ field: 'status', message: `status must be one of: ${EMPLOYEE_STATUSES.join(', ')}` });
    }
    const departmentId =
      typeof req.query.department === 'string' && req.query.department !== ''
        ? optId(req.query.department, 'department', errors) ?? undefined
        : undefined;
    if (errors.length > 0) fail(errors);
    return {
      search: typeof req.query.search === 'string' && req.query.search.trim() !== '' ? req.query.search.trim() : undefined,
      departmentId,
      location: typeof req.query.location === 'string' && req.query.location !== '' ? req.query.location : undefined,
      status: rawStatus as EmployeeStatus | undefined,
    };
  }

  app.get('/api/employees', (req, res) => {
    res.json({ employees: listEmployees(db, filtersFrom(req)), today: todayIso() });
  });

  app.get('/api/locations', (_req, res) => {
    res.json({ locations: listLocations(db) });
  });

  // NOTE: registered before /api/employees/:id so "export.csv" never
  // matches as an id.
  app.get('/api/employees/export.csv', (req, res) => {
    const rows = listEmployees(db, filtersFrom(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="employee-directory.csv"');
    res.send(directoryCsv(rows));
  });

  app.post('/api/employees', (req, res) => {
    const id = createEmployee(db, validateEmployee(body(req)));
    void platform.audit({ actor: auth.username, action: 'employee.created', resource: `employee:${id}` });
    res.status(201).json(employeeDetail(db, id));
  });

  app.get('/api/employees/:id', (req, res) => {
    res.json(employeeDetail(db, Number(req.params.id)));
  });

  app.put('/api/employees/:id', (req, res) => {
    updateEmployee(db, Number(req.params.id), validateEmployee(body(req)));
    res.json(employeeDetail(db, Number(req.params.id)));
  });

  app.post('/api/employees/:id/offboard', (req, res) => {
    offboardEmployee(db, Number(req.params.id));
    void platform.audit({ actor: auth.username, action: 'employee.offboarded', resource: `employee:${req.params.id}` });
    res.json(employeeDetail(db, Number(req.params.id)));
  });

  app.post('/api/employees/:id/reactivate', (req, res) => {
    reactivateEmployee(db, Number(req.params.id));
    res.json(employeeDetail(db, Number(req.params.id)));
  });

  app.patch('/api/employees/:id/onboarding', (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const patch = {
      account_created: optBool(input.account_created, 'account_created', errors),
      hardware_issued: optBool(input.hardware_issued, 'hardware_issued', errors),
      intro_meeting_booked: optBool(input.intro_meeting_booked, 'intro_meeting_booked', errors),
    };
    if (errors.length > 0) fail(errors);
    res.json(setOnboardingFlags(db, Number(req.params.id), patch));
  });

  // ── Org chart & onboarding views ─────────────────────────────────────
  app.get('/api/orgchart', (_req, res) => {
    res.json({ roots: orgChart(db) });
  });

  app.get('/api/onboarding', (_req, res) => {
    res.json(onboardingLists(db));
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
