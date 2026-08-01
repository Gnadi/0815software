import express, { type NextFunction, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import {
  checkCredentials,
  checkServiceToken,
  clearedCookie,
  COOKIE_NAME,
  createToken,
  parseBearer,
  parseCookies,
  SERVICE_HEADER,
  sessionCookie,
  verifyIdentityToken,
  verifyToken,
  type AuthConfig,
  type SeamFetch,
} from './auth.js';
import { DomainError, fail, reqText } from './errors.js';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import { MIGRATIONS } from './db.js';
import { pendingCount } from './migrations.js';
import { renderMetrics, requestTelemetry, type Gauge } from './telemetry.js';
import {
  createBucket,
  deleteObject,
  getObject,
  listBuckets,
  listObjects,
  putObject,
  signDownloadUrl,
  statObject,
  verifyDownload,
} from './storage.js';

export interface AppOptions {
  db: Database.Database;
  auth: AuthConfig;
  signingSecret: string;
  maxObjectBytes?: number;
  now?: () => number;
  /** Injectable fetch for the identity-seam verification call (tests). */
  identityFetch?: SeamFetch;
  /** Rate limiting / security headers / CORS; omitted in tests, set on boot. */
  hardening?: HardeningConfig;
  /** Emit one JSON log line per request (default false; index.ts passes true). */
  logRequests?: boolean;
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

export function createApp(opts: AppOptions): express.Express {
  const { db, auth, signingSecret, now = Date.now } = opts;
  const maxBytes = opts.maxObjectBytes ?? 10 * 1024 * 1024;
  const app = express();
  if (opts.hardening) {
    // Behind the stack's reverse proxy every socket peer is the proxy, so the
    // forwarded chain is what per-IP limiting and audit logging must read.
    if (opts.hardening.trustProxy > 0) app.set('trust proxy', opts.hardening.trustProxy);
    app.use(hardeningMiddleware(opts.hardening));
  }
  app.use(requestTelemetry({ service: 'ps-06', log: opts.logRequests === true }));
  app.use(express.json({ limit: `${Math.ceil((maxBytes * 1.4) / (1024 * 1024)) + 1}mb` }));

  // A caller is either the admin (session) or a module (service token), with
  // the optional PS-01 identity seam layered on the session path.
  const callerOk = (req: Request): boolean => {
    const token = parseBearer(req.headers.authorization) ?? parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token && verifyToken(auth, token)) return true;
    return checkServiceToken(auth, req.headers[SERVICE_HEADER]) === 'ok';
  };
  const requireCaller = (req: Request, res: Response, next: NextFunction): void => {
    if (callerOk(req)) {
      next();
      return;
    }
    const token = parseBearer(req.headers.authorization) ?? parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token && auth.identityUrl) {
      const doFetch = opts.identityFetch ?? (globalThis.fetch as unknown as SeamFetch);
      void verifyIdentityToken(auth.identityUrl, token, doFetch)
        .then((ok) => (ok ? next() : res.status(401).json({ error: 'Authentication required' })))
        .catch(() => res.status(401).json({ error: 'Authentication required' }));
      return;
    }
    res.status(401).json({ error: 'Authentication required' });
  };

  // ── Public ─────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  const gauges: Gauge[] = [];

  // Readiness: DB reachable and schema fully migrated (liveness is /api/health).
  app.get('/api/ready', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      const pending = pendingCount(db, MIGRATIONS);
      if (pending > 0) {
        res.status(503).json({ ready: false, pending_migrations: pending });
        return;
      }
      res.json({ ready: true });
    } catch {
      res.status(503).json({ ready: false });
    }
  });

  app.get('/api/metrics', (_req, res) => {
    res.type('text/plain').send(renderMetrics('ps-06', gauges));
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

  // Signed download — PUBLIC, but the HMAC signature must be valid and fresh.
  app.get('/api/download', (req, res) => {
    if (!verifyDownload(signingSecret, req.query, now())) fail(403, 'Invalid or expired signature');
    const { info, content } = getObject(db, String(req.query.bucket), String(req.query.key));
    res.setHeader('Content-Type', info.content_type);
    res.setHeader('Content-Length', String(info.size));
    res.send(content);
  });

  // ── Buckets ────────────────────────────────────────────────────────
  app.post('/api/buckets', requireCaller, (req, res) => {
    const name = reqText(body(req), 'name', 200);
    res.status(201).json(createBucket(db, name, now()));
  });
  app.get('/api/buckets', requireCaller, (_req, res) => {
    res.json({ buckets: listBuckets(db) });
  });
  app.get('/api/objects/:bucket', requireCaller, (req, res) => {
    res.json({ objects: listObjects(db, req.params.bucket as string) });
  });

  // ── Objects ────────────────────────────────────────────────────────
  app.put('/api/objects/:bucket/:key', requireCaller, (req, res) => {
    const b = body(req);
    const base64 = typeof b.content_base64 === 'string' ? b.content_base64 : '';
    if (!base64) fail(422, 'content_base64 is required');
    const content = Buffer.from(base64, 'base64');
    if (content.length > maxBytes) fail(413, `Object exceeds the ${maxBytes}-byte limit`);
    const info = putObject(
      db,
      {
        bucket: req.params.bucket as string,
        key: req.params.key as string,
        content,
        contentType: typeof b.content_type === 'string' ? b.content_type : undefined,
        metadata: (b.metadata ?? {}) as Record<string, string>,
      },
      now(),
    );
    res.status(201).json(info);
  });

  app.get('/api/objects/:bucket/:key', requireCaller, (req, res) => {
    const { info, content } = getObject(db, req.params.bucket as string, req.params.key as string);
    res.json({ ...info, content_base64: content.toString('base64') });
  });

  app.get('/api/objects/:bucket/:key/meta', requireCaller, (req, res) => {
    res.json(statObject(db, req.params.bucket as string, req.params.key as string));
  });

  app.post('/api/objects/:bucket/:key/sign', requireCaller, (req, res) => {
    statObject(db, req.params.bucket as string, req.params.key as string); // 404 if missing
    const ttl = typeof body(req).ttl_seconds === 'number' ? (body(req).ttl_seconds as number) : 300;
    res.json(signDownloadUrl(signingSecret, req.params.bucket as string, req.params.key as string, ttl, now()));
  });

  app.delete('/api/objects/:bucket/:key', requireCaller, (req, res) => {
    const deleted = deleteObject(db, req.params.bucket as string, req.params.key as string);
    if (!deleted) fail(404, 'Object not found');
    res.json({ deleted: true });
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
