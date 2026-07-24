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
import { deleteDoc, indexDoc, search } from './search.js';

export interface AppOptions {
  db: Database.Database;
  auth: AuthConfig;
  now?: () => number;
  identityFetch?: SeamFetch;
  /** Rate limiting / security headers / CORS; omitted in tests, set on boot. */
  hardening?: HardeningConfig;
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

export function createApp(opts: AppOptions): express.Express {
  const { db, auth } = opts;
  const app = express();
  if (opts.hardening) app.use(hardeningMiddleware(opts.hardening));
  app.use(express.json({ limit: '512kb' }));

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

  // Index (upsert) a document.
  app.post('/api/index', requireCaller, (req, res) => {
    const b = body(req);
    indexDoc(db, {
      collection: reqText(b, 'collection', 120),
      id: reqText(b, 'id', 200),
      title: typeof b.title === 'string' ? b.title : '',
      body: typeof b.body === 'string' ? b.body : '',
      facets: (b.facets ?? {}) as Record<string, string>,
      tenant: typeof b.tenant === 'string' ? b.tenant : null,
    });
    res.status(201).json({ indexed: true });
  });

  app.delete('/api/index/:collection/:id', requireCaller, (req, res) => {
    const tenant = typeof req.query.tenant === 'string' ? req.query.tenant : null;
    const deleted = deleteDoc(db, req.params.collection as string, req.params.id as string, tenant);
    res.json({ deleted });
  });

  // Search a collection. Facet filters come in as `facet.<key>=<value>`.
  app.get('/api/search', requireCaller, (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const collection = typeof req.query.collection === 'string' ? req.query.collection : '';
    if (!collection) fail(422, 'collection is required');
    const filters: { key: string; value: string }[] = [];
    for (const [k, v] of Object.entries(req.query)) {
      if (k.startsWith('facet.') && typeof v === 'string') filters.push({ key: k.slice('facet.'.length), value: v });
    }
    res.json(
      search(db, {
        collection,
        q,
        tenant: typeof req.query.tenant === 'string' ? req.query.tenant : null,
        filters,
        limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
        offset: typeof req.query.offset === 'string' ? Number(req.query.offset) : undefined,
      }),
    );
  });

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
