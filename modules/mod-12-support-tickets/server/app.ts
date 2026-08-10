import express, { type NextFunction, type Request, type Response } from 'express';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import type Database from 'better-sqlite3';
import {
  isPriority,
  isStatus,
  type CommentVisibility,
  type FieldError,
  type Priority,
  type Status,
} from '../shared/types.js';
import {
  actorOf,
  checkCredentials,
  checkIntakeSecret,
  clearedCookie,
  createToken,
  INTAKE_HEADER,
  lookupToken,
  requireAuth,
  sessionCookie,
  verifyLookupToken,
  type AuthConfig,
} from './auth.js';
import { SLA_POLICIES, AT_RISK_MINUTES } from './sla-config.js';
import { TRANSITIONS } from './status-config.js';
import {
  addComment,
  assignTicket,
  changePriority,
  changeStatus,
  createTicket,
  dashboard,
  DomainError,
  listAgents,
  listTickets,
  nowIso,
  openTicketByRef,
  publicView,
  ticketDetail,
} from './tickets.js';
import { noopPlatform, type PlatformHooks } from './platform.js';
import { nullVerifier, type LoginVerifier } from './sso.js';

// ── Tiny validation helpers ────────────────────────────────────────────
function body(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null
    ? (req.body as Record<string, unknown>)
    : {};
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

function reqEmail(raw: unknown, field: string, errors: FieldError[]): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '' || text.length > 200 || !/^\S+@\S+\.\S+$/.test(text)) {
    errors.push({ field, message: `${field} must look like an email address` });
  }
  return text;
}

function priorityOr(raw: unknown, fallback: Priority, errors: FieldError[]): Priority {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (!isPriority(raw)) {
    errors.push({ field: 'priority', message: `priority must be one of: ${Object.keys(SLA_POLICIES).join(', ')}` });
    return fallback;
  }
  return raw;
}

interface WebIntakeInput {
  requesterName: string;
  requesterEmail: string;
  subject: string;
  bodyText: string;
  priority: Priority;
}

function validateWebIntake(input: Record<string, unknown>): WebIntakeInput {
  const errors: FieldError[] = [];
  const requesterName = reqText(input.requester_name, 'requester_name', errors, 160);
  const requesterEmail = reqEmail(input.requester_email, 'requester_email', errors);
  const subject = reqText(input.subject, 'subject', errors, 200);
  const bodyText = reqText(input.body, 'body', errors, 8000);
  const priority = priorityOr(input.priority, 'normal', errors);
  if (errors.length > 0) fail(errors);
  return { requesterName, requesterEmail, subject, bodyText, priority };
}

export interface AppOptions {
  /** Optional transport hardening; omit it (as the tests do) to run unthrottled. */
  hardening?: HardeningConfig;
  db: Database.Database;
  auth: AuthConfig;
  /** Injectable clock — drives BOTH event timestamps and SLA "now". */
  now?: () => number;
  /** Absolute path to the built client (dist/client). Omit to serve API only. */
  staticDir?: string;
  /** Optional Platform Services integration; defaults to a no-op (standalone). */
  platform?: PlatformHooks;
  verifyLogin?: LoginVerifier;
}

export function createApp({ db, hardening, auth, now = Date.now, staticDir, platform = noopPlatform, verifyLogin = nullVerifier }: AppOptions): express.Express {
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
  app.use(express.json({ limit: '512kb' }));

  const stamp = (): string => nowIso(now());

  // Best-effort platform notification on ticket creation — never fails intake.
  const notifyCreated = async (info: {
    ref: string;
    subject: string;
    requesterName: string;
    requesterEmail: string;
  }): Promise<void> => {
    try {
      await platform.ticketCreated(info);
    } catch (err) {
      console.warn('[mod-12] platform.ticketCreated failed:', err);
    }
  };

  // ══ PUBLIC — web & email intake, requester status page (no login) ═════

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

  // Web intake: anyone can open a ticket. Returns the ref + a signed
  // lookup token the requester uses to check status later.
  app.post('/api/intake/web', async (req, res) => {
    const input = validateWebIntake(body(req));
    const ref = createTicket(db, {
      requesterName: input.requesterName,
      requesterEmail: input.requesterEmail,
      subject: input.subject,
      body: input.bodyText,
      priority: input.priority,
      channel: 'web',
      actor: input.requesterEmail,
      actorType: 'requester',
      at: stamp(),
    });
    await notifyCreated({ ref, subject: input.subject, requesterName: input.requesterName, requesterEmail: input.requesterEmail });
    res.status(201).json({ ref, token: lookupToken(auth, ref), status: 'new' });
  });

  // Email intake: an authenticated bridge (see scripts/simulate-inbound.mjs
  // and the README) POSTs a parsed email here with the shared secret. A
  // matching in-reply-to ref on a non-closed ticket appends a public
  // comment (reopening it if resolved); otherwise a new ticket is opened.
  app.post('/api/intake/email', async (req, res) => {
    const verdict = checkIntakeSecret(auth, req.headers[INTAKE_HEADER]);
    if (verdict === 'missing') {
      res.status(401).json({ error: 'Missing X-Intake-Secret header' });
      return;
    }
    if (verdict === 'bad') {
      res.status(403).json({ error: 'Invalid intake secret' });
      return;
    }
    const input = body(req);
    const errors: FieldError[] = [];
    const from = reqEmail(input.from, 'from', errors);
    const subject = reqText(input.subject, 'subject', errors, 200);
    const bodyText = reqText(input.body, 'body', errors, 8000);
    if (errors.length > 0) fail(errors);
    const inReplyTo = typeof input.in_reply_to === 'string' ? input.in_reply_to.trim() : '';

    const existing = inReplyTo ? openTicketByRef(db, inReplyTo) : null;
    if (existing) {
      addComment(db, existing.ref, {
        body: bodyText,
        visibility: 'public',
        actor: from,
        actorType: 'requester',
        at: stamp(),
      });
      res.status(200).json({ ref: existing.ref, action: 'appended' });
      return;
    }
    const ref = createTicket(db, {
      requesterName: from,
      requesterEmail: from,
      subject,
      body: bodyText,
      priority: 'normal',
      channel: 'email',
      actor: from,
      actorType: 'requester',
      at: stamp(),
    });
    await notifyCreated({ ref, subject, requesterName: from, requesterEmail: from });
    res.status(201).json({ ref, action: 'created' });
  });

  // Requester status page. The token gates access; a wrong/missing token
  // is a 404 (indistinguishable from "no such ticket").
  const requireLookup = (req: Request, res: Response): string | null => {
    const ref = req.params.ref as string;
    if (!verifyLookupToken(auth, ref, req.query.token)) {
      res.status(404).json({ error: 'Ticket not found' });
      return null;
    }
    // The token is valid FOR THIS ref; confirm the ticket exists.
    const exists = db.prepare('SELECT 1 FROM tickets WHERE ref = ?').get(ref);
    if (!exists) {
      res.status(404).json({ error: 'Ticket not found' });
      return null;
    }
    return ref;
  };

  app.get('/api/public/tickets/:ref', (req, res) => {
    const ref = requireLookup(req, res);
    if (ref === null) return;
    res.json(publicView(db, ref));
  });

  app.post('/api/public/tickets/:ref/comment', (req, res) => {
    const ref = requireLookup(req, res);
    if (ref === null) return;
    const ticket = db.prepare('SELECT requester_email FROM tickets WHERE ref = ?').get(ref) as {
      requester_email: string;
    };
    const errors: FieldError[] = [];
    const text = reqText(body(req).body, 'body', errors, 8000);
    if (errors.length > 0) fail(errors);
    addComment(db, ref, {
      body: text,
      visibility: 'public',
      actor: ticket.requester_email,
      actorType: 'requester',
      at: stamp(),
    });
    res.json(publicView(db, ref));
  });

  // ══ AGENT LOGIN ═══════════════════════════════════════════════════════
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
    res.json({ ok: true, agent: actor });
  });

  // ══ Everything below requires a valid agent session ═══════════════════
  app.use('/api', requireAuth(auth));

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  app.get('/api/me', (_req, res) => {
    res.json({ agent: actorOf(res, auth) });
  });

  // Config: the ONE source the UI renders the workflow + SLA policy from.
  app.get('/api/config', (_req, res) => {
    res.json({
      agent: actorOf(res, auth),
      statuses: Object.keys(TRANSITIONS),
      priorities: Object.keys(SLA_POLICIES),
      transitions: TRANSITIONS,
      sla: Object.fromEntries(
        Object.entries(SLA_POLICIES).map(([p, v]) => [
          p,
          { first_response_minutes: v.firstResponseMinutes, resolution_minutes: v.resolutionMinutes },
        ]),
      ),
      at_risk_minutes: AT_RISK_MINUTES,
    });
  });

  app.get('/api/agents', (_req, res) => {
    res.json({ agents: listAgents(db) });
  });

  app.get('/api/dashboard', (_req, res) => {
    res.json(dashboard(db, now()));
  });

  app.get('/api/tickets', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status && !isStatus(status)) {
      fail([{ field: 'status', message: `status must be one of: ${Object.keys(TRANSITIONS).join(', ')}` }]);
    }
    const priority = typeof req.query.priority === 'string' ? req.query.priority : undefined;
    if (priority && !isPriority(priority)) {
      fail([{ field: 'priority', message: `priority must be one of: ${Object.keys(SLA_POLICIES).join(', ')}` }]);
    }
    let assignee: number | 'unassigned' | undefined;
    const rawAssignee = req.query.assignee;
    if (rawAssignee === 'unassigned') assignee = 'unassigned';
    else if (typeof rawAssignee === 'string' && /^\d+$/.test(rawAssignee)) assignee = Number(rawAssignee);

    res.json({
      tickets: listTickets(
        db,
        {
          status: status as Status | undefined,
          priority: priority as Priority | undefined,
          assignee,
          search: typeof req.query.search === 'string' ? req.query.search : undefined,
        },
        now(),
      ),
    });
  });

  app.get('/api/tickets/:ref', (req, res) => {
    res.json(ticketDetail(db, req.params.ref, now()));
  });

  app.post('/api/tickets/:ref/status', (req, res) => {
    const raw = body(req).to;
    if (!isStatus(raw)) {
      fail([{ field: 'to', message: `to must be one of: ${Object.keys(TRANSITIONS).join(', ')}` }]);
    }
    changeStatus(db, req.params.ref, raw, actorOf(res, auth), 'agent', stamp());
    res.json(ticketDetail(db, req.params.ref, now()));
  });

  // AI-drafted reply suggestion (PS-04). 501 when no AI platform is configured.
  app.post('/api/tickets/:ref/suggest-reply', async (req, res) => {
    const detail = ticketDetail(db, req.params.ref, now());
    const thread = [
      `${detail.requester_name}: ${detail.body}`,
      ...detail.events
        .filter((e) => e.type === 'comment' && e.payload.body)
        .map((e) => `${e.actor}: ${e.payload.body}`),
    ].join('\n');
    const reply = await platform.suggestReply({ ref: detail.ref, subject: detail.subject, thread });
    if (reply === null) {
      res.status(501).json({ error: 'AI suggestions are not configured (set AI_URL)' });
      return;
    }
    res.json({ ref: detail.ref, suggestion: reply });
  });

  app.post('/api/tickets/:ref/priority', (req, res) => {
    const raw = body(req).priority;
    if (!isPriority(raw)) {
      fail([{ field: 'priority', message: `priority must be one of: ${Object.keys(SLA_POLICIES).join(', ')}` }]);
    }
    changePriority(db, req.params.ref, raw, actorOf(res, auth), stamp());
    res.json(ticketDetail(db, req.params.ref, now()));
  });

  app.post('/api/tickets/:ref/assign', (req, res) => {
    const raw = body(req).assignee_id;
    let assigneeId: number | null;
    if (raw === null || raw === undefined || raw === '') assigneeId = null;
    else if ((typeof raw === 'number' || typeof raw === 'string') && /^\d+$/.test(String(raw))) {
      assigneeId = Number(raw);
    } else {
      fail([{ field: 'assignee_id', message: 'assignee_id must be an agent id or null' }]);
    }
    assignTicket(db, req.params.ref, assigneeId, actorOf(res, auth), stamp());
    res.json(ticketDetail(db, req.params.ref, now()));
  });

  app.post('/api/tickets/:ref/comment', (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const text = reqText(input.body, 'body', errors, 8000);
    const visibility: CommentVisibility = input.visibility === 'internal' ? 'internal' : 'public';
    if (input.visibility !== undefined && input.visibility !== 'internal' && input.visibility !== 'public') {
      errors.push({ field: 'visibility', message: "visibility must be 'public' or 'internal'" });
    }
    if (errors.length > 0) fail(errors);
    addComment(db, req.params.ref, {
      body: text,
      visibility,
      actor: actorOf(res, auth),
      actorType: 'agent',
      at: stamp(),
    });
    res.json(ticketDetail(db, req.params.ref, now()));
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
