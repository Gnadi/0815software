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
import { configure, getConfig, listConfigs, next, peek } from './numbering.js';

export interface AppOptions {
  db: Database.Database;
  auth: AuthConfig;
  now?: () => number;
  identityFetch?: SeamFetch;
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

export function createApp(opts: AppOptions): express.Express {
  const { db, auth, now = Date.now } = opts;
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  const callerOk = (req: Request): boolean => {
    const token = parseBearer(req.headers.authorization) ?? parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token && verifyToken(auth, token)) return true;
    return checkServiceToken(auth, req.headers[SERVICE_HEADER]) === 'ok';
  };
  const requireCaller = (req: Request, res: Response, nextFn: NextFunction): void => {
    if (callerOk(req)) {
      nextFn();
      return;
    }
    const token = parseBearer(req.headers.authorization) ?? parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token && auth.identityUrl) {
      const doFetch = opts.identityFetch ?? (globalThis.fetch as unknown as SeamFetch);
      void verifyIdentityToken(auth.identityUrl, token, doFetch)
        .then((ok) => (ok ? nextFn() : res.status(401).json({ error: 'Authentication required' })))
        .catch(() => res.status(401).json({ error: 'Authentication required' }));
      return;
    }
    res.status(401).json({ error: 'Authentication required' });
  };

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

  // Allocate the next number for a scope (atomic, gapless).
  app.post('/api/next', requireCaller, (req, res) => {
    const scope = reqText(body(req), 'scope', 120);
    res.status(201).json(next(db, scope, now()));
  });

  // Configure a scope's format + period.
  app.post('/api/sequences', requireCaller, (req, res) => {
    const b = body(req);
    const scope = reqText(b, 'scope', 120);
    const format = reqText(b, 'format', 200);
    res.status(201).json(configure(db, scope, format, b.period ?? 'none', now()));
  });

  app.get('/api/sequences', requireCaller, (_req, res) => {
    res.json({ sequences: listConfigs(db) });
  });

  app.get('/api/sequences/:scope', requireCaller, (req, res) => {
    const scope = req.params.scope as string;
    const config = getConfig(db, scope);
    res.json({ config: config ?? null, current: peek(db, scope, now()) });
  });

  app.use((err: unknown, _req: Request, res: Response, nextFn: NextFunction) => {
    if (res.headersSent) {
      nextFn(err);
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
