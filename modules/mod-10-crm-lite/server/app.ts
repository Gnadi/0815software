import express, { type NextFunction, type Request, type Response } from 'express';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import type Database from 'better-sqlite3';
import { ACTIVITY_TYPES, type ActivityType, type FieldError } from '../shared/types.js';
import {
  activeStages,
  isStageKey,
  STAGES,
  stagePosition,
} from './pipeline-config.js';
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
import { dealTransfer } from './transfer-export.js';
import { DomainError } from './domain.js';
import { noopPlatform, type PlatformHooks } from './platform.js';
import { LOCAL_LOGIN, nullVerifier, type LoginMode, type LoginVerifier } from './sso.js';
import {
  createCompany,
  deleteCompany,
  getCompany,
  listCompanies,
  updateCompany,
  type CompanyInput,
} from './companies.js';
import {
  createContact,
  deleteContact,
  getContact,
  listContacts,
  updateContact,
  type ContactInput,
} from './contacts.js';
import {
  createDeal,
  dealDetail,
  dealRow,
  listDeals,
  moveStage,
  reopenDeal,
  updateDeal,
  type DealInput,
} from './deals.js';
import {
  activitiesForContact,
  createActivity,
  listActivities,
  listFollowUps,
  setFollowUpDone,
  type ActivityInput,
} from './activities.js';
import { computeMetrics } from './metrics.js';
import { exportDealsCsv } from './csv.js';

// ── Tiny validation helpers ────────────────────────────────────────────

function body(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null
    ? (req.body as Record<string, unknown>)
    : {};
}

function fail(details: FieldError[]): never {
  throw new DomainError(422, 'Validation failed', details);
}

function requiredText(raw: unknown, field: string, errors: FieldError[], max = 200): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '' || text.length > max) {
    errors.push({ field, message: `${field} is required (max ${max} characters)` });
  }
  return text;
}

function optText(raw: unknown, field: string, errors: FieldError[], max = 500): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    errors.push({ field, message: `${field} must be a string` });
    return null;
  }
  const text = raw.trim();
  if (text.length > max) errors.push({ field, message: `${field} must be at most ${max} characters` });
  return text === '' ? null : text;
}

function optEmail(raw: unknown, field: string, errors: FieldError[]): string | null {
  const text = optText(raw, field, errors, 160);
  if (text !== null && !/^\S+@\S+\.\S+$/.test(text)) {
    errors.push({ field, message: `${field} must look like an email address` });
  }
  return text;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function optDate(raw: unknown, field: string, errors: FieldError[]): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !DATE_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    errors.push({ field, message: `${field} must be a date in YYYY-MM-DD format` });
    return null;
  }
  return raw;
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

function requiredId(raw: unknown, field: string, errors: FieldError[]): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) errors.push({ field, message: `${field} must be a positive integer id` });
  return n;
}

function valueCents(raw: unknown, field: string, errors: FieldError[]): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000_000_000) {
    errors.push({ field, message: `${field} must be a non-negative integer amount in cents` });
    return 0;
  }
  return n;
}

// ── Domain-shaped validators ───────────────────────────────────────────

function validateCompany(input: Record<string, unknown>): CompanyInput {
  const errors: FieldError[] = [];
  const name = requiredText(input.name, 'name', errors, 160);
  const domain = optText(input.domain, 'domain', errors, 160);
  const notes = optText(input.notes, 'notes', errors, 1000);
  if (errors.length > 0) fail(errors);
  return { name, domain, notes };
}

function validateContact(input: Record<string, unknown>): ContactInput {
  const errors: FieldError[] = [];
  const name = requiredText(input.name, 'name', errors, 160);
  const email = optEmail(input.email, 'email', errors);
  const phone = optText(input.phone, 'phone', errors, 60);
  const title = optText(input.title, 'title', errors, 120);
  const companyId = optId(input.company_id, 'company_id', errors);
  if (errors.length > 0) fail(errors);
  return { name, email, phone, title, companyId };
}

function validateDeal(input: Record<string, unknown>): DealInput {
  const errors: FieldError[] = [];
  const title = requiredText(input.title, 'title', errors, 200);
  const companyId = requiredId(input.company_id, 'company_id', errors);
  const primaryContactId = optId(input.primary_contact_id, 'primary_contact_id', errors);
  const value = valueCents(input.value_cents, 'value_cents', errors);
  const note = optText(input.note, 'note', errors, 1000);
  let stage: string | undefined;
  if (input.stage !== undefined && input.stage !== null && input.stage !== '') {
    if (typeof input.stage !== 'string' || !isStageKey(input.stage)) {
      errors.push({ field: 'stage', message: `stage must be one of: ${STAGES.map((s) => s.key).join(', ')}` });
    } else {
      stage = input.stage;
    }
  }
  if (errors.length > 0) fail(errors);
  return { title, companyId, primaryContactId, valueCents: value, note, stage };
}

function validateActivity(input: Record<string, unknown>): ActivityInput {
  const errors: FieldError[] = [];
  const type = typeof input.type === 'string' && (ACTIVITY_TYPES as readonly string[]).includes(input.type)
    ? (input.type as ActivityType)
    : (() => {
        errors.push({ field: 'type', message: `type must be one of: ${ACTIVITY_TYPES.join(', ')}` });
        return 'note' as ActivityType;
      })();
  const subject = requiredText(input.subject, 'subject', errors, 200);
  const bodyText = optText(input.body, 'body', errors, 2000);
  const contactId = optId(input.contact_id, 'contact_id', errors);
  const dealId = optId(input.deal_id, 'deal_id', errors);
  const dueDate = optDate(input.due_date, 'due_date', errors);
  if (contactId === null && dealId === null) {
    errors.push({ field: 'link', message: 'An activity must be linked to a contact and/or a deal' });
  }
  if (errors.length > 0) fail(errors);
  return { type, subject, body: bodyText, contactId, dealId, dueDate };
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
    res.setHeader('Set-Cookie', sessionCookie(auth, createToken(auth, actor)));
    res.json({ ok: true, username: actor });
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

  // Hand a deal still in play to whatever quotes it. The response is the
  // neutral shape in shared/transfer.ts — no MOD-10 ids, stages or internals —
  // the same one MOD-13 uses to hand an accepted offer to whatever bills it.
  //
  // This is a READ. It changes nothing here: a deal that has been quoted is
  // still exactly where it was in the pipeline, and moving it is the
  // salesperson's call, made in this module's own UI.
  app.get('/api/deals/:id/transfer', (req, res) => {
    requireServiceToken(req);
    // No party override: the company's own `party_id` is what PS-11 resolved
    // when this module registered it, so the export already carries the id the
    // rest of the stack knows this customer by.
    res.json(dealTransfer(db, Number(req.params.id)));
  });

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
    res.json({ username: actorOf(res, auth) });
  });

  // ── Config: the ONE source the UI renders the pipeline from ──────────
  app.get('/api/config', (_req, res) => {
    res.json({
      stages: STAGES.map((s) => ({
        key: s.key,
        label: s.label,
        probability: s.probability,
        terminal: s.terminal,
        position: stagePosition(s.key),
      })),
      activity_types: ACTIVITY_TYPES,
    });
  });

  // ── Companies ────────────────────────────────────────────────────────
  app.get('/api/companies', (req, res) => {
    res.json({ companies: listCompanies(db, typeof req.query.search === 'string' ? req.query.search : undefined) });
  });

  app.post('/api/companies', (req, res) => {
    const values = validateCompany(body(req));
    const id = createCompany(db, values);
    void platform.audit({ actor: actorOf(res, auth), action: 'company.created', resource: `company:${id}` });
    // Register the company with PS-11 so a module that later quotes or invoices
    // it resolves the same party. Best-effort: the local row is already written,
    // and the party id is stored when the answer arrives.
    void platform
      .resolveParty({ name: values.name, email: null, localId: id })
      .then((partyId) => {
        if (partyId !== null) db.prepare('UPDATE companies SET party_id = ? WHERE id = ?').run(partyId, id);
      })
      .catch(() => {
        /* buildPlatform already logs; the local row stands either way */
      });
    res.status(201).json(getCompany(db, id));
  });

  app.get('/api/companies/:id', (req, res) => {
    const id = Number(req.params.id);
    const company = getCompany(db, id);
    res.json({
      ...company,
      contacts: listContacts(db, { companyId: id }),
      deals: listDeals(db, { companyId: id }),
    });
  });

  app.put('/api/companies/:id', (req, res) => {
    const id = Number(req.params.id);
    updateCompany(db, id, validateCompany(body(req)));
    res.json(getCompany(db, id));
  });

  app.delete('/api/companies/:id', (req, res) => {
    deleteCompany(db, Number(req.params.id));
    res.json({ ok: true });
  });

  // ── Contacts ─────────────────────────────────────────────────────────
  app.get('/api/contacts', (req, res) => {
    const errors: FieldError[] = [];
    const companyId = optId(req.query.company_id, 'company_id', errors);
    if (errors.length > 0) fail(errors);
    res.json({
      contacts: listContacts(db, {
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        companyId: companyId ?? undefined,
      }),
    });
  });

  app.post('/api/contacts', (req, res) => {
    const id = createContact(db, validateContact(body(req)));
    res.status(201).json(getContact(db, id));
  });

  app.get('/api/contacts/:id', (req, res) => {
    const id = Number(req.params.id);
    const contact = getContact(db, id);
    const company = contact.company_id === null ? null : getCompany(db, contact.company_id);
    res.json({
      ...contact,
      company_name: company ? company.name : null,
      company,
      deals: listDeals(db, { contactId: id }),
      activities: activitiesForContact(db, id),
    });
  });

  app.put('/api/contacts/:id', (req, res) => {
    const id = Number(req.params.id);
    updateContact(db, id, validateContact(body(req)));
    res.json(getContact(db, id));
  });

  app.delete('/api/contacts/:id', (req, res) => {
    deleteContact(db, Number(req.params.id));
    res.json({ ok: true });
  });

  // ── Deals ────────────────────────────────────────────────────────────
  app.get('/api/deals', (req, res) => {
    const rawStage = typeof req.query.stage === 'string' ? req.query.stage : undefined;
    if (rawStage && !isStageKey(rawStage)) {
      fail([{ field: 'stage', message: `stage must be one of: ${STAGES.map((s) => s.key).join(', ')}` }]);
    }
    res.json({
      deals: listDeals(db, {
        stage: rawStage,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
      }),
    });
  });

  app.post('/api/deals', (req, res) => {
    const id = createDeal(db, validateDeal(body(req)));
    res.status(201).json(dealDetail(db, id));
  });

  app.get('/api/deals/:id', (req, res) => {
    res.json(dealDetail(db, Number(req.params.id)));
  });

  app.put('/api/deals/:id', (req, res) => {
    const id = Number(req.params.id);
    const input = validateDeal(body(req));
    updateDeal(db, id, input);
    res.json(dealDetail(db, id));
  });

  app.delete('/api/deals/:id', (req, res) => {
    const id = Number(req.params.id);
    dealRow(db, id); // 404 if missing
    db.prepare('DELETE FROM deals WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  app.post('/api/deals/:id/stage', (req, res) => {
    const id = Number(req.params.id);
    const input = body(req);
    const errors: FieldError[] = [];
    const stage = requiredText(input.stage, 'stage', errors, 40);
    const note = optText(input.note, 'note', errors, 500);
    if (errors.length > 0) fail(errors);
    moveStage(db, id, stage, note);
    void platform.audit({ actor: actorOf(res, auth), action: 'deal.stage_changed', resource: `deal:${id}`, after: { stage } });
    res.json(dealDetail(db, id));
  });

  app.post('/api/deals/:id/reopen', (req, res) => {
    const id = Number(req.params.id);
    const input = body(req);
    const errors: FieldError[] = [];
    // Default reopen target: the first active stage.
    const stageRaw = input.stage;
    const stage = stageRaw === undefined || stageRaw === null || stageRaw === ''
      ? activeStages()[0]!.key
      : requiredText(stageRaw, 'stage', errors, 40);
    const note = optText(input.note, 'note', errors, 500);
    if (errors.length > 0) fail(errors);
    reopenDeal(db, id, stage, note);
    res.json(dealDetail(db, id));
  });

  // ── Activities & follow-ups ──────────────────────────────────────────
  app.get('/api/activities', (_req, res) => {
    res.json({ activities: listActivities(db) });
  });

  app.post('/api/activities', (req, res) => {
    const id = createActivity(db, validateActivity(body(req)));
    res.status(201).json(db.prepare(
      `SELECT a.*, k.name AS contact_name, d.title AS deal_title
       FROM activities a
       LEFT JOIN contacts k ON k.id = a.contact_id
       LEFT JOIN deals d ON d.id = a.deal_id
       WHERE a.id = ?`,
    ).get(id));
  });

  app.get('/api/followups', (req, res) => {
    res.json({ followups: listFollowUps(db, { includeDone: req.query.include_done === 'true' }) });
  });

  app.post('/api/activities/:id/done', (req, res) => {
    const id = Number(req.params.id);
    const done = body(req).done;
    setFollowUpDone(db, id, done === undefined ? true : done === true || done === 'true');
    res.json(db.prepare(
      `SELECT a.*, k.name AS contact_name, d.title AS deal_title
       FROM activities a
       LEFT JOIN contacts k ON k.id = a.contact_id
       LEFT JOIN deals d ON d.id = a.deal_id
       WHERE a.id = ?`,
    ).get(id));
  });

  // ── Pipeline metrics (all derived) ───────────────────────────────────
  app.get('/api/metrics', (req, res) => {
    const errors: FieldError[] = [];
    const from = optDate(req.query.from, 'from', errors);
    const to = optDate(req.query.to, 'to', errors);
    if (errors.length > 0) fail(errors);
    res.json(computeMetrics(db, { from: from ?? undefined, to: to ?? undefined }));
  });

  // ── CSV export of deals ──────────────────────────────────────────────
  app.get('/api/deals.csv', (_req, res) => {
    const csv = exportDealsCsv(db);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="deals.csv"');
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
