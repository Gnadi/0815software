import express, { type NextFunction, type Request, type Response } from 'express';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import type Database from 'better-sqlite3';
import {
  APPLICATION_STATUSES,
  CATEGORIES,
  PROGRAM_STATUSES,
  isApplicationStatus,
  isCategory,
  isProgramStatus,
  type ApplicationStatus,
  type FieldError,
  type ProgramStatus,
} from '../shared/types.js';
import {
  actorOf,
  checkCredentials,
  clearedCookie,
  createToken,
  requireAuth,
  sessionCookie,
  type AuthConfig,
} from './auth.js';
import { createHandoff, isRedeemPath, safeServiceTokenEqual } from './handoff.js';
import { parseSummaryContext } from '../shared/summary.js';
import { moduleSummary } from './summary.js';
import { noopPlatform, type PlatformHooks } from './platform.js';
import { LOCAL_LOGIN, nullVerifier, type LoginMode, type LoginVerifier } from './sso.js';
import {
  addObligation,
  applicationDetail,
  createApplication,
  dashboard,
  deleteApplication,
  listApplications,
  recordTranche,
  toggleObligation,
  transitionApplication,
  updateApplication,
  type ApplicationInput,
} from './applications.js';
import { DomainError, nowIso } from './core.js';
import { exportApplicationsCsv } from './csv.js';
import {
  createProgram,
  deleteProgram,
  listPrograms,
  programDetail,
  updateProgram,
  type ProgramInput,
} from './programs.js';
import { AT_RISK_DAYS } from './reporting-config.js';
import { TRANSITIONS } from './status-config.js';

// ── Tiny validation helpers ────────────────────────────────────────────
function body(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : {};
}

function fail(details: FieldError[]): never {
  throw new DomainError(422, 'Validation failed', details);
}

function reqText(raw: unknown, field: string, errors: FieldError[], maxLength: number): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '' || text.length > maxLength) {
    errors.push({ field, message: `${field} is required (max ${maxLength} characters)` });
  }
  return text;
}

function optText(raw: unknown, field: string, errors: FieldError[], maxLength = 2000): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    errors.push({ field, message: `${field} must be a string` });
    return null;
  }
  const text = raw.trim();
  if (text.length > maxLength) errors.push({ field, message: `${field} must be at most ${maxLength} characters` });
  return text === '' ? null : text;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function reqDate(raw: unknown, field: string, errors: FieldError[]): string {
  if (typeof raw !== 'string' || !DATE_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    errors.push({ field, message: `${field} must be a date in YYYY-MM-DD format` });
    return '';
  }
  return raw;
}

function optDate(raw: unknown, field: string, errors: FieldError[]): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  return reqDate(raw, field, errors);
}

/** A strictly-positive integer amount in cents. */
function posCents(raw: unknown, field: string, errors: FieldError[]): number {
  const n = Number(raw);
  if (typeof raw === 'boolean' || !Number.isInteger(n) || n <= 0 || n > 1_000_000_000_00) {
    errors.push({ field, message: `${field} must be a positive integer amount in cents` });
  }
  return n;
}

function percent(raw: unknown, field: string, errors: FieldError[]): number {
  const n = Number(raw);
  if (typeof raw === 'boolean' || !Number.isInteger(n) || n < 0 || n > 100) {
    errors.push({ field, message: `${field} must be an integer percentage between 0 and 100` });
  }
  return n;
}

function id(raw: unknown, field: string, errors: FieldError[]): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) errors.push({ field, message: `${field} must be a positive integer id` });
  return n;
}

function validateProgram(input: Record<string, unknown>): ProgramInput {
  const errors: FieldError[] = [];
  const name = reqText(input.name, 'name', errors, 200);
  const fundingBody = reqText(input.funding_body, 'funding_body', errors, 200);
  const category = typeof input.category === 'string' ? input.category : '';
  if (!isCategory(category)) {
    errors.push({ field: 'category', message: `category must be one of: ${CATEGORIES.map((c) => c.value).join(', ')}` });
  }
  const description = optText(input.description, 'description', errors, 4000);
  const fundingRate = percent(input.funding_rate, 'funding_rate', errors);
  const maxGrantCents = posCents(input.max_grant_cents, 'max_grant_cents', errors);
  const applicationDeadline = optDate(input.application_deadline, 'application_deadline', errors);
  const rawStatus = input.status === undefined || input.status === '' ? 'open' : input.status;
  if (!isProgramStatus(rawStatus)) {
    errors.push({ field: 'status', message: `status must be one of: ${PROGRAM_STATUSES.join(', ')}` });
  }
  if (errors.length > 0) fail(errors);
  return {
    name,
    fundingBody,
    category,
    description,
    fundingRate,
    maxGrantCents,
    applicationDeadline,
    status: rawStatus as ProgramStatus,
  };
}

function validateApplication(input: Record<string, unknown>): ApplicationInput {
  const errors: FieldError[] = [];
  const programId = id(input.program_id, 'program_id', errors);
  const title = reqText(input.title, 'title', errors, 200);
  const eligibleCostsCents = posCents(input.eligible_costs_cents, 'eligible_costs_cents', errors);
  const requestedAmountCents = posCents(input.requested_amount_cents, 'requested_amount_cents', errors);
  const submissionDate = optDate(input.submission_date, 'submission_date', errors);
  const reference = optText(input.reference, 'reference', errors, 120);
  const notes = optText(input.notes, 'notes', errors, 4000);
  if (errors.length > 0) fail(errors);
  return { programId, title, eligibleCostsCents, requestedAmountCents, submissionDate, reference, notes };
}

export interface AppOptions {
  /** Optional transport hardening; omit it (as the tests do) to run unthrottled. */
  hardening?: HardeningConfig;
  db: Database.Database;
  auth: AuthConfig;
  /** Injectable clock — drives BOTH event timestamps and deadline "now". */
  now?: () => number;
  /** Absolute path to the built client (dist/client). Omit to serve API only. */
  staticDir?: string;
  /** Optional Platform Services integration; defaults to a no-op (standalone). */
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
   * The MOD-15 Workspace origin allowed to embed this module and to sign users
   * into it (SHELL_ORIGIN). Unset — the default — leaves the handoff routes
   * unmounted entirely and keeps `X-Frame-Options: DENY` in `hardening.ts`.
   */
  shellOrigin?: string;
  /**
   * Which credentials the login form should name, served as-is from
   * GET /api/auth-mode. Defaults to this module's own — the standalone case.
   */
  loginMode?: LoginMode;
}

export function createApp({ db, hardening, auth, now = Date.now, staticDir, platform = noopPlatform, verifyLogin = nullVerifier, loginMode = LOCAL_LOGIN, serviceToken, shellOrigin }: AppOptions): express.Express {
  const app = express();
  const handoff = shellOrigin ? createHandoff(auth) : null;

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

  const stamp = (): string => nowIso(now());

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
    res.setHeader('Set-Cookie', sessionCookie(auth, createToken(auth, actor)));
    res.json({ ok: true, admin: actor });
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
    // This module takes an injectable clock; the summary must read the SAME
    // one, or a widget would disagree with the screens beside it about what
    // is overdue.
    res.json(moduleSummary(db, parseSummaryContext(req.query as Record<string, unknown>), { now: () => new Date(now()) }));
  });

  // ── Shell handoff ────────────────────────────────────────────────────
  // Mounted only when the operator named a shell in SHELL_ORIGIN, so a
  // standalone module has no such surface at all. See handoff.ts for why the
  // destination is signed into the ticket rather than passed alongside it.
  if (handoff) {
    app.post('/api/session/handoff', (req, res) => {
      requireServiceToken(req);
      const { actor, path } = body(req);
      if (typeof actor !== 'string' || actor.trim() === '') throw new DomainError(422, 'actor is required');
      const target = path === undefined ? '/' : path;
      if (!isRedeemPath(target)) throw new DomainError(422, 'path must be module-relative');
      res.json(handoff.issue(actor.trim(), target));
    });

    app.post('/api/session/issue', (req, res) => {
      requireServiceToken(req);
      const { actor } = body(req);
      if (typeof actor !== 'string' || actor.trim() === '') throw new DomainError(422, 'actor is required');
      res.json(handoff.issueSession(actor.trim()));
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
    res.json({ admin: actorOf(res, auth) });
  });

  // ── Config: the ONE source the UI renders the workflow from ──────────
  app.get('/api/config', (_req, res) => {
    res.json({
      admin: actorOf(res, auth),
      statuses: APPLICATION_STATUSES,
      transitions: TRANSITIONS,
      program_statuses: PROGRAM_STATUSES,
      categories: CATEGORIES.map((c) => ({ value: c.value, label: c.label })),
      at_risk_days: AT_RISK_DAYS,
    });
  });

  // ── Deadlines dashboard + portfolio ──────────────────────────────────
  app.get('/api/dashboard', (_req, res) => {
    res.json(dashboard(db, now()));
  });

  // ── Funding programs ─────────────────────────────────────────────────
  app.get('/api/programs', (req, res) => {
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (rawStatus && !isProgramStatus(rawStatus)) {
      fail([{ field: 'status', message: `status must be one of: ${PROGRAM_STATUSES.join(', ')}` }]);
    }
    const rawCategory = typeof req.query.category === 'string' ? req.query.category : undefined;
    if (rawCategory && !isCategory(rawCategory)) {
      fail([{ field: 'category', message: `category must be one of: ${CATEGORIES.map((c) => c.value).join(', ')}` }]);
    }
    res.json({
      programs: listPrograms(db, {
        status: rawStatus as ProgramStatus | undefined,
        category: rawCategory,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
      }),
    });
  });

  app.post('/api/programs', (req, res) => {
    const values = validateProgram(body(req));
    const programId = createProgram(db, { ...values, createdAt: stamp() });
    res.status(201).json(programDetail(db, programId));
  });

  app.get('/api/programs/:id', (req, res) => {
    res.json(programDetail(db, Number(req.params.id)));
  });

  app.put('/api/programs/:id', (req, res) => {
    updateProgram(db, Number(req.params.id), validateProgram(body(req)));
    res.json(programDetail(db, Number(req.params.id)));
  });

  app.delete('/api/programs/:id', (req, res) => {
    deleteProgram(db, Number(req.params.id));
    res.json({ ok: true });
  });

  // ── Applications ─────────────────────────────────────────────────────
  app.get('/api/applications', (req, res) => {
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (rawStatus && !isApplicationStatus(rawStatus)) {
      fail([{ field: 'status', message: `status must be one of: ${APPLICATION_STATUSES.join(', ')}` }]);
    }
    const rawProgram = typeof req.query.program_id === 'string' ? Number(req.query.program_id) : undefined;
    res.json({
      applications: listApplications(db, {
        status: rawStatus as ApplicationStatus | undefined,
        programId: rawProgram && Number.isInteger(rawProgram) ? rawProgram : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
      }),
    });
  });

  app.post('/api/applications', (req, res) => {
    const appId = createApplication(db, { ...validateApplication(body(req)), createdAt: stamp() });
    res.status(201).json(applicationDetail(db, appId, now()));
  });

  app.get('/api/applications/:id', (req, res) => {
    res.json(applicationDetail(db, Number(req.params.id), now()));
  });

  app.put('/api/applications/:id', (req, res) => {
    updateApplication(db, Number(req.params.id), validateApplication(body(req)));
    res.json(applicationDetail(db, Number(req.params.id), now()));
  });

  app.delete('/api/applications/:id', (req, res) => {
    deleteApplication(db, Number(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/applications/:id/transition', (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const to = typeof input.to === 'string' ? input.to : '';
    if (!isApplicationStatus(to)) {
      errors.push({ field: 'to', message: `to must be one of: ${APPLICATION_STATUSES.join(', ')}` });
    }
    const note = optText(input.note, 'note', errors, 500);
    // approved_amount_cents is validated in the domain layer against the
    // program's max grant; here we only coerce it when present.
    let approvedAmountCents: number | null = null;
    if (input.approved_amount_cents !== undefined && input.approved_amount_cents !== null && input.approved_amount_cents !== '') {
      approvedAmountCents = Number(input.approved_amount_cents);
    }
    if (errors.length > 0) fail(errors);
    transitionApplication(db, Number(req.params.id), {
      to: to as ApplicationStatus,
      actor: actorOf(res, auth),
      note,
      approvedAmountCents,
      at: stamp(),
    });
    void platform.audit({ actor: actorOf(res, auth), action: 'application.transitioned', resource: `application:${req.params.id}`, after: { to } });
    res.json(applicationDetail(db, Number(req.params.id), now()));
  });

  app.post('/api/applications/:id/tranches', (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const disbursedOn = reqDate(input.disbursed_on, 'disbursed_on', errors);
    const amountCents = posCents(input.amount_cents, 'amount_cents', errors);
    const reference = optText(input.reference, 'reference', errors, 120);
    const note = optText(input.note, 'note', errors, 500);
    if (errors.length > 0) fail(errors);
    recordTranche(db, Number(req.params.id), { disbursedOn, amountCents, reference, note, at: stamp() });
    res.json(applicationDetail(db, Number(req.params.id), now()));
  });

  app.post('/api/applications/:id/obligations', (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const title = reqText(input.title, 'title', errors, 200);
    const dueDate = reqDate(input.due_date, 'due_date', errors);
    if (errors.length > 0) fail(errors);
    addObligation(db, Number(req.params.id), { title, dueDate, at: stamp() });
    res.json(applicationDetail(db, Number(req.params.id), now()));
  });

  app.post('/api/obligations/:id/toggle', (req, res) => {
    const appId = toggleObligation(db, Number(req.params.id), stamp());
    res.json(applicationDetail(db, appId, now()));
  });

  // ── CSV export ───────────────────────────────────────────────────────
  app.get('/api/export/applications.csv', (_req, res) => {
    const csv = exportApplicationsCsv(db);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="applications.csv"');
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
