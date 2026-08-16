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
import { lookupLimiter } from './throttle.js';
import { CATEGORIES, isCategory, isOutcome, OUTCOMES } from './case-config.js';
import { CASE_STATUSES, MESSAGE_VISIBILITIES, type CaseStatus, type MessageVisibility } from '../shared/types.js';
import {
  addMessage,
  caseByCode,
  createCase,
  DomainError,
  eraseCase,
  fail,
  getCase,
  listCases,
  nowIso,
  overview,
  reporterViewOf,
  transitionCase,
} from './cases.js';

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
  /** Injectable clock. Every deadline in this module is a question about now. */
  now?: () => number;
  organisation?: string;
  /** Per-IP access-code lookups per minute; 0 disables. Tests pass 0. */
  lookupRateLimitRpm?: number;
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

function reqText(input: Record<string, unknown>, field: string, max: number): string {
  const value = input[field];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(422, 'Validation failed', [{ field, message: 'is required' }]);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) fail(422, 'Validation failed', [{ field, message: `must be at most ${max} characters` }]);
  return trimmed;
}

function optText(input: Record<string, unknown>, field: string, max: number): string | null {
  const value = input[field];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail(422, 'Validation failed', [{ field, message: 'must be a string' }]);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) fail(422, 'Validation failed', [{ field, message: `must be at most ${max} characters` }]);
  return trimmed;
}

function idParam(req: Request): number {
  const raw = req.params.id as string;
  if (!/^\d+$/.test(raw)) fail(404, 'Not found');
  return Number(raw);
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

  /**
   * Audit records carry the REF AND THE VERB, never the content.
   *
   * PS-07 is a different service with a different audience, and a report's
   * text is the one thing in this module that must not travel. "WB-2026-0007
   * was acknowledged by anna" is what an audit trail needs; the allegation
   * itself is not part of it.
   */
  const record = (actor: string, action: string, ref: string, extra?: Record<string, unknown>): void => {
    void platform.audit({ actor, action, resource: `case:${ref}`, after: extra });
  };

  // ── Public: unauthenticated, and deliberately so ─────────────────────
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

  /**
   * What the intake form needs to render — and what a reporter is entitled
   * to know before they file: who receives this, and by when they will hear
   * back (§ 17 Abs. 1 HinSchG).
   */
  app.get('/api/public/config', (_req, res) => {
    res.json({
      organisation: opts.organisation ?? 'Example GmbH',
      categories: CATEGORIES,
      acknowledge_days: 7,
      feedback_months: 3,
    });
  });

  app.post('/api/public/reports', (req, res) => {
    const b = body(req);
    const result = createCase(
      db,
      {
        category: typeof b.category === 'string' ? b.category : '',
        subject: reqText(b, 'subject', 200),
        body: reqText(b, 'body', 20_000),
        // Never required, and never nudged for. A reporter who gives nothing
        // still gets the full two-way channel through their access code.
        contact: optText(b, 'contact', 500),
      },
      at(),
    );
    // The actor is 'reporter', not a name — there is no name to log, and the
    // audit entry must not become the identifier the schema refuses to keep.
    record('reporter', 'case.received', result.ref);
    res.status(201).json(result);
  });

  const limitLookups = lookupLimiter(opts.lookupRateLimitRpm ?? 20, now);

  /**
   * The reporter's way back in. POST rather than GET so the access code never
   * lands in a URL — request logs, browser history, `Referer` headers on any
   * outbound link and the proxy in between all keep query strings, and this
   * code is the only thing standing between a whistleblower and exposure.
   */
  app.post('/api/public/case', limitLookups, (req, res) => {
    const found = caseByCode(db, body(req).code);
    if (!found) {
      res.status(404).json({ error: 'No case matches that access code' });
      return;
    }
    res.json(reporterViewOf(db, found, at()));
  });

  app.post('/api/public/case/messages', limitLookups, (req, res) => {
    const b = body(req);
    const found = caseByCode(db, b.code);
    if (!found) {
      res.status(404).json({ error: 'No case matches that access code' });
      return;
    }
    const message = reqText(b, 'body', 20_000);
    addMessage(db, found.id, { actor: 'reporter', actorType: 'reporter', visibility: 'reporter', body: message }, at());
    record('reporter', 'case.reporter_message', found.ref);
    res.status(201).json(reporterViewOf(db, found, at()));
  });

  // ── Session ──────────────────────────────────────────────────────────
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

  // ── Everything below is the designated case handler ──────────────────
  app.use('/api', requireAuth(auth));

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      username: actorOf(res, auth),
      organisation: opts.organisation ?? 'Example GmbH',
      categories: CATEGORIES,
      outcomes: OUTCOMES,
      statuses: CASE_STATUSES,
      now: at(),
    });
  });

  app.get('/api/overview', (_req, res) => {
    res.json(overview(db, at()));
  });

  app.get('/api/cases', (req, res) => {
    const status = req.query.status;
    if (status !== undefined && !(CASE_STATUSES as readonly string[]).includes(String(status))) {
      fail(422, `status must be one of: ${CASE_STATUSES.join(', ')}`);
    }
    const category = req.query.category;
    if (category !== undefined && !isCategory(String(category))) {
      fail(422, 'category is not a known category');
    }
    res.json({
      cases: listCases(
        db,
        {
          status: status === undefined ? undefined : (String(status) as CaseStatus),
          category: category === undefined ? undefined : (String(category) as never),
          attention: req.query.attention === 'true',
        },
        at(),
      ),
    });
  });

  app.get('/api/cases/:id', (req, res) => {
    res.json(getCase(db, idParam(req), at()));
  });

  /**
   * The lifecycle, as verb routes rather than a PATCH of `status`.
   *
   * `acknowledge` is not a synonym for "set status": it is the § 17 Abs. 1
   * act, it is what starts the three-month feedback clock, and naming it
   * that way is the difference between a UI that reads like the law and one
   * that reads like a database.
   */
  for (const [path, target] of [
    ['acknowledge', 'acknowledged'],
    ['investigate', 'investigating'],
  ] as const) {
    app.post(`/api/cases/:id/${path}`, (req, res) => {
      const actor = actorOf(res, auth);
      const detail = transitionCase(db, idParam(req), target, actor, null, at());
      record(actor, `case.${target}`, detail.ref);
      res.json(detail);
    });
  }

  app.post('/api/cases/:id/close', (req, res) => {
    const actor = actorOf(res, auth);
    const outcome = body(req).outcome;
    if (!isOutcome(outcome)) {
      fail(422, 'Validation failed', [
        { field: 'outcome', message: `must be one of: ${OUTCOMES.map((o) => o.key).join(', ')}` },
      ]);
    }
    const detail = transitionCase(db, idParam(req), 'closed', actor, outcome, at());
    record(actor, 'case.closed', detail.ref, { outcome });
    res.json(detail);
  });

  app.post('/api/cases/:id/messages', (req, res) => {
    const b = body(req);
    const visibility = b.visibility;
    if (!(MESSAGE_VISIBILITIES as readonly unknown[]).includes(visibility)) {
      fail(422, 'Validation failed', [
        { field: 'visibility', message: `must be one of: ${MESSAGE_VISIBILITIES.join(', ')}` },
      ]);
    }
    const actor = actorOf(res, auth);
    const detail = addMessage(
      db,
      idParam(req),
      {
        actor,
        actorType: 'handler',
        visibility: visibility as MessageVisibility,
        body: reqText(b, 'body', 20_000),
      },
      at(),
    );
    // Only the fact and its visibility — never the text. An internal note
    // about a named colleague is exactly what must not leave this database.
    record(actor, 'case.message', detail.ref, { visibility });
    res.json(detail);
  });

  app.post('/api/cases/:id/erase', (req, res) => {
    const actor = actorOf(res, auth);
    const detail = eraseCase(db, idParam(req), actor, body(req).force === true, at());
    record(actor, 'case.erased', detail.ref);
    res.json(detail);
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
