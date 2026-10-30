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
  accessOf,
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
import { createHandoff, isRedeemPath, requestedAccess, safeServiceTokenEqual } from './handoff.js';
import { parseSummaryContext } from '../shared/summary.js';
import { moduleSummary } from './summary.js';
import { SLA_POLICIES } from './sla-config.js';
import { TRANSITIONS } from './status-config.js';
import { DEFAULT_ATTACHMENT_LIMITS, parseUploads, readAttachment, type AttachmentLimits } from './attachments.js';
import { createCanned, deleteCanned, getCanned, listCanned, renderTemplate, updateCanned } from './canned.js';
import { rateTicket, rateableResolution } from './csat.js';
import { createMailboxPoller } from './mailbox.js';
import { currentPolicy, policyVersions, readSettings, savePolicy, settingsStamp, writeSettings } from './policy.js';
import {
  addComment,
  assignTicket,
  changePriority,
  changeStatus,
  createTicket,
  dashboard,
  DomainError,
  eventsOf,
  listAgents,
  listTickets,
  nowIso,
  openTicketByRef,
  publicView,
  ticketDetail,
} from './tickets.js';
import { noopPlatform, type PlatformHooks } from './platform.js';
import { LOCAL_LOGIN, nullVerifier, type LoginMode, type LoginVerifier } from './sso.js';

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

function numericId(raw: string, what: string): number {
  if (!/^\d+$/.test(raw)) throw new DomainError(404, `${what} not found`);
  return Number(raw);
}

function attachmentId(req: Request): number {
  return numericId(req.params.id as string, 'Attachment');
}

/**
 * Serve a stored file as a download, never inline: an uploaded HTML or SVG
 * file opened in this origin would run its script with the agent's session.
 * Attachment disposition, nosniff and a sandboxing CSP make sure it does not.
 */
function sendFile(res: Response, info: { filename: string; content_type: string; size: number }, content: Buffer): void {
  const ascii = info.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', info.content_type);
  res.setHeader('Content-Length', String(content.length));
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(info.filename)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(content);
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
  /** Per-file size and files-per-message (ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_MESSAGE). */
  attachmentLimits?: AttachmentLimits;
  /** Where requesters reach this module — the links in mails (PUBLIC_BASE_URL). */
  publicBaseUrl?: string;
}

export function createApp({ db, hardening, auth, now = Date.now, staticDir, platform = noopPlatform, verifyLogin = nullVerifier, loginMode = LOCAL_LOGIN, serviceToken, shellOrigins = [], attachmentLimits = DEFAULT_ATTACHMENT_LIMITS, publicBaseUrl = 'http://localhost:3012' }: AppOptions): express.Express {
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
  // The routes that carry files take base64 in their JSON — a third larger
  // than the files themselves. Everything else keeps the small limit.
  const withFiles = express.json({ limit: Math.ceil((attachmentLimits.maxBytes * 4) / 3) * attachmentLimits.perMessage + 512 * 1024 });
  app.use(['/api/intake/web', '/api/intake/email', '/api/public/tickets/:ref/comment', '/api/tickets/:ref/comment'], withFiles);
  app.use(express.json({ limit: '512kb' }));

  const stamp = (): string => nowIso(now());
  const statusUrl = (ref: string): string => `${publicBaseUrl.replace(/\/+$/, '')}/ticket/${encodeURIComponent(ref)}?token=${lookupToken(auth, ref)}`;

  // Best-effort platform notification on ticket creation — never fails intake.
  const notifyCreated = async (info: {
    ref: string;
    subject: string;
    requesterName: string;
    requesterEmail: string;
  }): Promise<void> => {
    try {
      await platform.ticketCreated({ ...info, statusUrl: statusUrl(info.ref) });
    } catch (err) {
      console.warn('[mod-12] platform.ticketCreated failed:', err);
    }
  };

  // A copy of a new event's files to PS-06 — best-effort; the local row is
  // the one that is served, so an outage there loses nothing here.
  const mirrorFiles = async (ref: string, eventId: number): Promise<void> => {
    if (!platform.attachmentStored) return;
    const rows = db.prepare('SELECT id, filename, content_type, content FROM attachments WHERE event_id = ? ORDER BY id').all(eventId) as {
      id: number;
      filename: string;
      content_type: string;
      content: Buffer;
    }[];
    for (const r of rows) {
      try {
        await platform.attachmentStored({ ref, id: r.id, filename: r.filename, contentType: r.content_type, bytes: r.content });
      } catch (err) {
        console.warn(`[mod-12] copying attachment ${r.id} to PS-06 failed:`, err);
      }
    }
  };
  const createdEventOf = (ref: string): number =>
    (db.prepare("SELECT e.id FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id WHERE t.ref = ? AND e.type = 'created'").get(ref) as { id: number }).id;

  // Mail to a requester through PS-03, when the settings ask for it —
  // best-effort: the reply or the resolution is recorded either way.
  const mailRequester = async (mail: { to: string; subject: string; body: string; idempotencyKey: string }): Promise<void> => {
    if (!platform.mailRequester) return;
    try {
      await platform.mailRequester(mail);
    } catch (err) {
      console.warn('[mod-12] mail to the requester failed:', err);
    }
  };

  const poller = createMailboxPoller({
    db,
    platform,
    now,
    limits: attachmentLimits,
    ticketCreated: async (info) => {
      await notifyCreated(info);
      await mirrorFiles(info.ref, createdEventOf(info.ref));
    },
  });
  app.locals.mailboxPoller = poller;

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
    const files = parseUploads(body(req).attachments, attachmentLimits);
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
      attachments: files,
    });
    await notifyCreated({ ref, subject: input.subject, requesterName: input.requesterName, requesterEmail: input.requesterEmail });
    if (files.length > 0) await mirrorFiles(ref, createdEventOf(ref));
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
    const files = parseUploads(input.attachments, attachmentLimits);
    const inReplyTo = typeof input.in_reply_to === 'string' ? input.in_reply_to.trim() : '';

    const existing = inReplyTo ? openTicketByRef(db, inReplyTo) : null;
    if (existing) {
      const eventId = addComment(db, existing.ref, {
        body: bodyText,
        visibility: 'public',
        actor: from,
        actorType: 'requester',
        at: stamp(),
        attachments: files,
      });
      if (files.length > 0) await mirrorFiles(existing.ref, eventId);
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
      attachments: files,
    });
    await notifyCreated({ ref, subject, requesterName: from, requesterEmail: from });
    if (files.length > 0) await mirrorFiles(ref, createdEventOf(ref));
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

  const publicOf = (ref: string) => publicView(db, ref, { ratings: readSettings(db).csat.enabled });

  // What the public forms need to know before they send: the file limits.
  app.get('/api/public/config', (_req, res) => {
    res.json({ attachments: { max_bytes: attachmentLimits.maxBytes, per_message: attachmentLimits.perMessage } });
  });

  app.get('/api/public/tickets/:ref', (req, res) => {
    const ref = requireLookup(req, res);
    if (ref === null) return;
    res.json(publicOf(ref));
  });

  app.post('/api/public/tickets/:ref/comment', async (req, res) => {
    const ref = requireLookup(req, res);
    if (ref === null) return;
    const ticket = db.prepare('SELECT requester_email FROM tickets WHERE ref = ?').get(ref) as {
      requester_email: string;
    };
    const errors: FieldError[] = [];
    const text = reqText(body(req).body, 'body', errors, 8000);
    if (errors.length > 0) fail(errors);
    const files = parseUploads(body(req).attachments, attachmentLimits);
    const eventId = addComment(db, ref, {
      body: text,
      visibility: 'public',
      actor: ticket.requester_email,
      actorType: 'requester',
      at: stamp(),
      attachments: files,
    });
    if (files.length > 0) await mirrorFiles(ref, eventId);
    res.json(publicOf(ref));
  });

  // A file the requester may see: on the opening request or a public reply.
  // One on an internal note answers exactly as a file that does not exist.
  app.get('/api/public/tickets/:ref/attachments/:id', (req, res) => {
    const ref = requireLookup(req, res);
    if (ref === null) return;
    const file = readAttachment(db, ref, attachmentId(req));
    if (file.visibility !== 'public') throw new DomainError(404, 'Attachment not found');
    sendFile(res, file.info, file.content);
  });

  // The requester rates a resolved ticket, once per resolution.
  app.post('/api/public/tickets/:ref/rating', (req, res) => {
    const ref = requireLookup(req, res);
    if (ref === null) return;
    if (!readSettings(db).csat.enabled) throw new DomainError(409, 'Ratings are not collected');
    const ticket = db.prepare('SELECT id, created_at FROM tickets WHERE ref = ?').get(ref) as { id: number; created_at: string };
    const events = eventsOf(db, ticket.id);
    const detail = ticketDetail(db, ref, now());
    rateTicket(db, ticket.id, rateableResolution(db, ticket.id, events, detail.status), body(req), stamp());
    res.status(201).json(publicOf(ref));
  });

  // Which credentials this deployment accepts, read by the login form before
  // anyone is signed in — hence public. With SSO configured, PS-01 validates
  // logins and this module's own admin credentials are rejected, so a form
  // advertising them would send people at a password that cannot work. The org
  // slug is deployment configuration, not a secret.
  app.get('/api/auth-mode', (_req, res) => {
    res.json(loginMode);
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
    // The level rides in the token next to the actor: the local admin manages,
    // a PS-01 identity gets what its module permissions grant.
    const access = viaSso !== null && viaSso.ok ? viaSso.access : 'manage';
    res.setHeader('Set-Cookie', sessionCookie(auth, createToken(auth, actor, Date.now(), access)));
    res.json({ ok: true, agent: actor, access });
  });

  // ══ Everything below requires a valid agent session ═══════════════════
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
    res.json(moduleSummary(db, parseSummaryContext(req.query as Record<string, unknown>), { now: now() }));
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

  app.use('/api', requireAuth(auth));

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  app.get('/api/me', (_req, res) => {
    res.json({ agent: actorOf(res, auth), access: accessOf(res) });
  });

  // Config: the ONE source the UI renders the workflow + SLA policy from.
  app.get('/api/config', (_req, res) => {
    const { policy } = currentPolicy(db);
    res.json({
      agent: actorOf(res, auth),
      statuses: Object.keys(TRANSITIONS),
      priorities: Object.keys(SLA_POLICIES),
      transitions: TRANSITIONS,
      sla: policy.targets,
      at_risk_minutes: policy.at_risk_minutes,
      attachments: { max_bytes: attachmentLimits.maxBytes, per_message: attachmentLimits.perMessage },
    });
  });

  // ── The SLA policy (versions; writes are `manage`) ───────────────────
  app.get('/api/sla-policy', (_req, res) => {
    res.json({ current: currentPolicy(db), versions: policyVersions(db).reverse() });
  });

  app.put('/api/sla-policy', (req, res) => {
    savePolicy(db, body(req), actorOf(res, auth), stamp());
    res.json({ current: currentPolicy(db), versions: policyVersions(db).reverse() });
  });

  // ── Settings (writes are `manage`) ───────────────────────────────────
  const settingsView = () => ({
    settings: readSettings(db),
    ...settingsStamp(db),
    notification_configured: platform.notificationConfigured === true,
    mailbox_configured: platform.mailbox !== undefined,
    files_configured: platform.attachmentStored !== undefined,
    public_base_url: publicBaseUrl,
  });

  app.get('/api/settings', (_req, res) => {
    res.json(settingsView());
  });

  app.put('/api/settings', (req, res) => {
    writeSettings(db, body(req), actorOf(res, auth), stamp());
    res.json(settingsView());
  });

  // ── The mailbox (PS-05; `manage`) ────────────────────────────────────
  app.get('/api/mailbox', async (_req, res) => {
    res.json(await poller.status());
  });

  app.post('/api/mailbox/test', async (_req, res) => {
    if (!platform.mailbox) throw new DomainError(501, 'The mailbox needs PS-05 — set INTEGRATION_URL and PLATFORM_SERVICE_TOKEN');
    const { connection_id } = readSettings(db).mailbox;
    if (connection_id === null) throw new DomainError(409, 'Choose the mailbox to read first');
    try {
      res.json(await platform.mailbox.probe(connection_id));
    } catch (err) {
      throw new DomainError(502, `The mailbox could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  app.post('/api/mailbox/poll', async (_req, res) => {
    res.json(await poller.poll());
  });

  // ── Canned responses (writes are `manage`) ───────────────────────────
  app.get('/api/canned-responses', (_req, res) => {
    res.json({ canned_responses: listCanned(db) });
  });

  app.post('/api/canned-responses', (req, res) => {
    res.status(201).json(createCanned(db, body(req), actorOf(res, auth), stamp()));
  });

  app.put('/api/canned-responses/:id', (req, res) => {
    res.json(updateCanned(db, numericId(req.params.id as string, 'Canned response'), body(req), actorOf(res, auth), stamp()));
  });

  app.delete('/api/canned-responses/:id', (req, res) => {
    deleteCanned(db, numericId(req.params.id as string, 'Canned response'));
    res.json({ ok: true });
  });

  // The template filled for one ticket — the text the reply box starts from.
  app.post('/api/tickets/:ref/canned/:id/render', (req, res) => {
    const ticket = ticketDetail(db, req.params.ref as string, now());
    const canned = getCanned(db, numericId(req.params.id as string, 'Canned response'));
    if (!canned.active) throw new DomainError(409, 'This canned response is switched off');
    res.json({
      canned_id: canned.id,
      body: renderTemplate(canned.body, { requesterName: ticket.requester_name, ticketRef: ticket.ref, subject: ticket.subject, agentName: actorOf(res, auth) }),
    });
  });

  app.get('/api/tickets/:ref/attachments/:id', (req, res) => {
    const file = readAttachment(db, req.params.ref as string, attachmentId(req));
    sendFile(res, file.info, file.content);
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

  app.post('/api/tickets/:ref/status', async (req, res) => {
    const raw = body(req).to;
    if (!isStatus(raw)) {
      fail([{ field: 'to', message: `to must be one of: ${Object.keys(TRANSITIONS).join(', ')}` }]);
    }
    const eventId = changeStatus(db, req.params.ref, raw, actorOf(res, auth), 'agent', stamp());
    const detail = ticketDetail(db, req.params.ref, now());
    const { csat } = readSettings(db);
    if (raw === 'resolved' && csat.enabled && csat.invite_by_email) {
      await mailRequester({
        to: detail.requester_email,
        subject: `How did we do? [${detail.ref}]`,
        body: `Hi ${detail.requester_name},\n\nyour request "${detail.subject}" (${detail.ref}) is resolved. Would you tell us how we did? It takes one click:\n\n${statusUrl(detail.ref)}#rating\n\nThank you.`,
        idempotencyKey: `mod-12:csat:${eventId}`,
      });
    }
    res.json(detail);
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

  app.post('/api/tickets/:ref/comment', async (req, res) => {
    const input = body(req);
    const errors: FieldError[] = [];
    const text = reqText(input.body, 'body', errors, 8000);
    const visibility: CommentVisibility = input.visibility === 'internal' ? 'internal' : 'public';
    if (input.visibility !== undefined && input.visibility !== 'internal' && input.visibility !== 'public') {
      errors.push({ field: 'visibility', message: "visibility must be 'public' or 'internal'" });
    }
    let cannedId: number | undefined;
    if (input.canned_id !== undefined && input.canned_id !== null) {
      if (typeof input.canned_id !== 'number' || !Number.isInteger(input.canned_id)) errors.push({ field: 'canned_id', message: 'must be a canned response id' });
      else cannedId = getCanned(db, input.canned_id).id;
    }
    if (errors.length > 0) fail(errors);
    const files = parseUploads(input.attachments, attachmentLimits);
    const ref = req.params.ref as string;
    const actor = actorOf(res, auth);
    const eventId = addComment(db, ref, { body: text, visibility, actor, actorType: 'agent', at: stamp(), attachments: files, cannedId });
    if (files.length > 0) await mirrorFiles(ref, eventId);
    const detail = ticketDetail(db, ref, now());
    if (visibility === 'public' && readSettings(db).reply_by_email) {
      const mailbox = readSettings(db).mailbox;
      const names = files.map((f) => f.filename);
      await mailRequester({
        to: detail.requester_email,
        subject: `Re: [${detail.ref}] ${detail.subject}`,
        body: [
          text,
          names.length > 0 ? `\nAttached on your status page: ${names.join(', ')}` : '',
          `\n—\nYour request ${detail.ref}: ${statusUrl(detail.ref)}`,
          mailbox.enabled ? `Reply to this email to answer — keep [${detail.ref}] in the subject.` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        idempotencyKey: `mod-12:reply:${eventId}`,
      });
    }
    res.json(detail);
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
