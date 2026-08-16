import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import {
  actorOf,
  checkCredentials,
  clearedCookie,
  createToken,
  requireAuth,
  sessionCookie,
  type AuthConfig,
} from './auth.js';
import { noopPlatform, type PlatformHooks } from './platform.js';
import { nullVerifier, type LoginVerifier } from './sso.js';
import { ABSENCE_TYPES, isAbsenceType } from './absence-config.js';
import { holidays, isCalendarDate, REGION_LABELS, REGIONS, type Region } from '../shared/calendar.js';
import { REQUEST_STATUSES, type RequestStatus } from '../shared/types.js';
import {
  allBalances,
  balanceFor,
  createEmployee,
  createRequest,
  DomainError,
  fail,
  getEmployee,
  getEntitlement,
  getRequest,
  listEmployees,
  listRequests,
  nowIso,
  offboardEmployee,
  parseRegion,
  setEntitlement,
  transitionRequest,
} from './absences.js';

export interface AppOptions {
  db: Database.Database;
  auth: AuthConfig;
  /** Optional transport hardening; omit it (as the tests do) to run unthrottled. */
  hardening?: HardeningConfig;
  /** Absolute path to the built client (dist/client). Omit to serve API only. */
  staticDir?: string;
  /** Optional PS-03/PS-07 integration; defaults to no-ops (standalone). */
  platform?: PlatformHooks;
  verifyLogin?: LoginVerifier;
  /** Injectable clock. Whether carry-over has lapsed is a question about TODAY. */
  now?: () => number;
  defaultRegion?: Region;
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

function reqText(input: Record<string, unknown>, field: string, max = 200): string {
  const value = input[field];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(422, 'Validation failed', [{ field, message: 'is required' }]);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) fail(422, 'Validation failed', [{ field, message: `must be at most ${max} characters` }]);
  return trimmed;
}

function optText(input: Record<string, unknown>, field: string, max = 500): string | null {
  const value = input[field];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail(422, 'Validation failed', [{ field, message: 'must be a string' }]);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) fail(422, 'Validation failed', [{ field, message: `must be at most ${max} characters` }]);
  return trimmed;
}

function reqDate(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (!isCalendarDate(value)) {
    fail(422, 'Validation failed', [{ field, message: 'must be a real date formatted YYYY-MM-DD' }]);
  }
  return value;
}

function idParam(req: Request): number {
  const raw = req.params.id as string;
  if (!/^\d+$/.test(raw)) fail(404, 'Not found');
  return Number(raw);
}

/** A day count off the wire: non-negative, and a whole or half day. */
function reqDays(input: Record<string, unknown>, field: string): number {
  const value = Number(input[field]);
  if (!Number.isFinite(value) || value < 0 || value > 400) {
    fail(422, 'Validation failed', [{ field, message: 'must be a number between 0 and 400' }]);
  }
  // Leave is booked in halves. Anything finer is a data-entry slip, and
  // accepting it would produce balances nobody can reconcile against a payslip.
  if (Math.round(value * 2) !== value * 2) {
    fail(422, 'Validation failed', [{ field, message: 'must be a whole or half day' }]);
  }
  return value;
}

export function createApp(opts: AppOptions): express.Express {
  const { db, auth, platform = noopPlatform, verifyLogin = nullVerifier, now = Date.now } = opts;
  const app = express();

  if (opts.hardening) {
    if (opts.hardening.trustProxy > 0) app.set('trust proxy', opts.hardening.trustProxy);
    app.use(hardeningMiddleware(opts.hardening));
  }
  app.use(express.json({ limit: '256kb' }));

  const at = (): string => nowIso(now());
  const today = (): string => at().slice(0, 10);

  // ── Public ───────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/ready', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ ready: true });
    } catch {
      res.status(503).json({ ready: false });
    }
  });

  app.post('/api/login', (req, res, next) => {
    void (async () => {
      const { username, password } = body(req);
      const viaSso = await verifyLogin(username, password);
      if (viaSso !== null && !viaSso.ok && viaSso.reason === 'unavailable') {
        res.status(503).json({ error: 'Identity service unavailable' });
        return;
      }
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
    })().catch(next);
  });

  // ── Everything below requires a session ──────────────────────────────
  app.use('/api', requireAuth(auth));

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  /**
   * The configuration the client needs to render forms: the absence types and
   * the regions, both straight from the single files that define them, so the
   * UI cannot offer an option the server would reject.
   */
  app.get('/api/config', (_req, res) => {
    res.json({
      username: actorOf(res, auth),
      types: ABSENCE_TYPES,
      regions: REGIONS.map((region) => ({ code: region, label: REGION_LABELS[region] })),
      default_region: opts.defaultRegion ?? 'DE-BY',
      today: today(),
    });
  });

  // ── Employees ────────────────────────────────────────────────────────
  app.get('/api/employees', (req, res) => {
    res.json({ employees: listEmployees(db, req.query.include_left === 'true') });
  });

  app.post('/api/employees', (req, res) => {
    const b = body(req);
    const employee = createEmployee(
      db,
      {
        name: reqText(b, 'name', 160),
        email: reqText(b, 'email', 320).toLowerCase(),
        region: parseRegion(b.region),
        startedOn: reqDate(b, 'started_on'),
      },
      at(),
    );
    void platform.audit({
      actor: actorOf(res, auth),
      action: 'employee.created',
      resource: `employee:${employee.id}`,
      after: employee,
    });
    res.status(201).json(employee);
  });

  app.get('/api/employees/:id', (req, res) => {
    res.json(getEmployee(db, idParam(req)));
  });

  app.post('/api/employees/:id/offboard', (req, res) => {
    const employee = offboardEmployee(db, idParam(req), reqDate(body(req), 'left_on'));
    void platform.audit({
      actor: actorOf(res, auth),
      action: 'employee.offboarded',
      resource: `employee:${employee.id}`,
      after: employee,
    });
    res.json(employee);
  });

  // ── Entitlements ─────────────────────────────────────────────────────
  app.get('/api/employees/:id/entitlement', (req, res) => {
    const year = req.query.year !== undefined ? Number(req.query.year) : Number(today().slice(0, 4));
    res.json({ entitlement: getEntitlement(db, idParam(req), year) });
  });

  app.put('/api/employees/:id/entitlement', (req, res) => {
    const b = body(req);
    const year = Number(b.year);
    if (!Number.isInteger(year) || year < 1900 || year > 2200) {
      fail(422, 'Validation failed', [{ field: 'year', message: 'must be a four-digit year' }]);
    }
    const entitlement = setEntitlement(
      db,
      {
        employeeId: idParam(req),
        year,
        baseDays: reqDays(b, 'base_days'),
        carryOverDays: b.carry_over_days === undefined ? 0 : reqDays(b, 'carry_over_days'),
        carryOverExpiresOn:
          b.carry_over_expires_on === undefined || b.carry_over_expires_on === null || b.carry_over_expires_on === ''
            ? null
            : reqDate(b, 'carry_over_expires_on'),
      },
      at(),
    );
    void platform.audit({
      actor: actorOf(res, auth),
      action: 'entitlement.set',
      resource: `employee:${entitlement.employee_id}:${entitlement.year}`,
      after: entitlement,
    });
    res.json(entitlement);
  });

  // ── Requests ─────────────────────────────────────────────────────────
  app.get('/api/requests', (req, res) => {
    const status = req.query.status;
    if (status !== undefined && !(REQUEST_STATUSES as readonly string[]).includes(String(status))) {
      fail(422, `status must be one of: ${REQUEST_STATUSES.join(', ')}`);
    }
    res.json({
      requests: listRequests(db, {
        employeeId: req.query.employee_id !== undefined ? Number(req.query.employee_id) : undefined,
        status: status === undefined ? undefined : (String(status) as RequestStatus),
        from: typeof req.query.from === 'string' && req.query.from !== '' ? req.query.from : undefined,
        to: typeof req.query.to === 'string' && req.query.to !== '' ? req.query.to : undefined,
      }),
    });
  });

  app.post('/api/requests', (req, res) => {
    const b = body(req);
    const type = reqText(b, 'type', 40);
    if (!isAbsenceType(type)) {
      fail(422, 'Validation failed', [
        { field: 'type', message: `must be one of: ${ABSENCE_TYPES.map((t) => t.key).join(', ')}` },
      ]);
    }
    const request = createRequest(
      db,
      {
        employeeId: Number(b.employee_id),
        type,
        fromDate: reqDate(b, 'from_date'),
        toDate: reqDate(b, 'to_date'),
        halfStart: b.half_start === true,
        halfEnd: b.half_end === true,
        note: optText(b, 'note'),
        actor: actorOf(res, auth),
      },
      at(),
    );
    void platform.audit({
      actor: actorOf(res, auth),
      action: 'absence.requested',
      resource: `request:${request.id}`,
      after: { type: request.type, from: request.from_date, to: request.to_date, days: request.days },
    });
    res.status(201).json(request);
  });

  app.get('/api/requests/:id', (req, res) => {
    res.json(getRequest(db, idParam(req)));
  });

  /**
   * The three decisions, each its own route rather than a PATCH of `status`.
   *
   * A verb says what happened; a status field only says what is now true. The
   * event trail is the point of this module, so the API is shaped around the
   * transitions rather than around the column.
   */
  for (const [path, target] of [
    ['approve', 'approved'],
    ['reject', 'rejected'],
    ['withdraw', 'withdrawn'],
  ] as const) {
    app.post(`/api/requests/:id/${path}`, (req, res) => {
      const actor = actorOf(res, auth);
      const request = transitionRequest(db, idParam(req), target, actor, optText(body(req), 'note'), at());
      void platform.audit({
        actor,
        action: `absence.${target}`,
        resource: `request:${request.id}`,
        after: { status: request.status, days: request.days },
      });
      res.json(request);
    });
  }

  // ── Balances and calendar ────────────────────────────────────────────
  app.get('/api/balances', (req, res) => {
    const year = req.query.year !== undefined ? Number(req.query.year) : Number(today().slice(0, 4));
    res.json({ year, balances: allBalances(db, year, today()) });
  });

  app.get('/api/employees/:id/balance', (req, res) => {
    const year = req.query.year !== undefined ? Number(req.query.year) : Number(today().slice(0, 4));
    res.json(balanceFor(db, idParam(req), year, today()));
  });

  /**
   * The public holidays for a region and year — the same computation the
   * booking maths uses, exposed so the UI can grey out the days it will not
   * charge for. One source, so the calendar an employee sees and the number
   * they are charged cannot disagree.
   */
  app.get('/api/holidays', (req, res) => {
    const region = parseRegion(req.query.region);
    const year = req.query.year !== undefined ? Number(req.query.year) : Number(today().slice(0, 4));
    if (!Number.isInteger(year) || year < 1900 || year > 2200) {
      fail(422, 'Validation failed', [{ field: 'year', message: 'must be a four-digit year' }]);
    }
    res.json({ region, year, holidays: holidays(year, region) });
  });

  // ── Static client (production build) ─────────────────────────────────
  if (opts.staticDir) {
    const staticDir = opts.staticDir;
    app.use(express.static(staticDir));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api') && existsSync(resolve(staticDir, 'index.html'))) {
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
