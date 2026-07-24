import express, { type NextFunction, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import {
  checkCredentials,
  checkServiceToken,
  clearedCookie,
  createToken,
  requireAuth,
  SERVICE_HEADER,
  sessionCookie,
  type AuthConfig,
  type SeamFetch,
} from './auth.js';
import { DomainError, fail, reqText } from './errors.js';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import { listEvents, recordEvent, verifyChain } from './audit.js';

export interface AppOptions {
  db: Database.Database;
  auth: AuthConfig;
  now?: () => number;
  /** Injectable fetch for the identity-seam verification call (tests). */
  identityFetch?: SeamFetch;
  /** Rate limiting / security headers / CORS; omitted in tests, set on boot. */
  hardening?: HardeningConfig;
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

export function createApp(opts: AppOptions): express.Express {
  const { db, auth, now = Date.now } = opts;
  const app = express();
  if (opts.hardening) app.use(hardeningMiddleware(opts.hardening));
  app.use(express.json({ limit: '512kb' }));

  // ── Public ─────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/api/login', (req, res) => {
    const b = body(req);
    if (!checkCredentials(auth, b.username, b.password)) fail(401, 'Invalid username or password');
    const token = createToken(auth);
    res.setHeader('Set-Cookie', sessionCookie(auth, token));
    res.json({ token });
  });
  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  // Record an event — service-token gated, so any module can emit.
  app.post('/api/events', (req, res) => {
    const verdict = checkServiceToken(auth, req.headers[SERVICE_HEADER]);
    if (verdict === 'missing') fail(401, 'Service token required');
    if (verdict === 'bad') fail(403, 'Invalid service token');
    const b = body(req);
    const actor = reqText(b, 'actor', 200);
    const action = reqText(b, 'action', 200);
    const resource = reqText(b, 'resource', 400);
    const event = recordEvent(
      db,
      {
        actor,
        action,
        resource,
        org: typeof b.org === 'string' ? b.org : null,
        before: b.before,
        after: b.after,
        metadata: (b.metadata ?? {}) as Record<string, unknown>,
      },
      now(),
    );
    res.status(201).json(event);
  });

  // ── Admin gate (reads + integrity) ─────────────────────────────────
  app.use('/api', requireAuth(auth, { fetch: opts.identityFetch }));

  app.get('/api/events', (req, res) => {
    const q = req.query;
    const events = listEvents(db, {
      actor: typeof q.actor === 'string' ? q.actor : undefined,
      resource: typeof q.resource === 'string' ? q.resource : undefined,
      action: typeof q.action === 'string' ? q.action : undefined,
      org: typeof q.org === 'string' ? q.org : undefined,
      since: typeof q.since === 'string' ? q.since : undefined,
      limit: typeof q.limit === 'string' ? Number(q.limit) : undefined,
    });
    res.json({ events });
  });

  app.get('/api/verify', (_req, res) => {
    res.json(verifyChain(db));
  });

  // ── Terminal error middleware ──────────────────────────────────────
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
