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
import { DomainError, fail } from './errors.js';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import { MIGRATIONS } from './db.js';
import { pendingCount } from './migrations.js';
import { renderMetrics, requestTelemetry, type Gauge } from './telemetry.js';
import {
  archiveParty,
  cleanInput,
  countParties,
  createPartyIdempotent,
  eraseParty,
  getSelf,
  linkRef,
  listParties,
  listRefs,
  mergeParties,
  nowIso,
  putSelf,
  requireParty,
  resolveMerged,
  resolveParty,
  updateParty,
} from './parties.js';
import { PARTY_KINDS, type PartyKind } from '../shared/types.js';

export interface AppOptions {
  db: Database.Database;
  auth: AuthConfig;
  now?: () => number;
  identityFetch?: SeamFetch;
  /** Rate limiting / security headers / CORS; omitted in tests, set on boot. */
  hardening?: HardeningConfig;
  /** Emit one JSON log line per request (default false; index.ts passes true). */
  logRequests?: boolean;
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) fail(404, 'Party not found');
  return id;
}

export function createApp(opts: AppOptions): express.Express {
  const { db, auth, now = Date.now } = opts;
  const app = express();
  if (opts.hardening) app.use(hardeningMiddleware(opts.hardening));
  app.use(requestTelemetry({ service: 'ps-11', log: opts.logRequests === true }));
  app.use(express.json({ limit: '64kb' }));

  const at = (): string => nowIso(now());

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

  const gauges: Gauge[] = [
    {
      name: 'customers_parties_total',
      help: 'Live customer parties (not archived, not merged away).',
      value: () => countParties(db, 'customer'),
    },
    {
      name: 'customers_suppliers_total',
      help: 'Live supplier parties (not archived, not merged away).',
      value: () => countParties(db, 'supplier'),
    },
  ];

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
    res.type('text/plain').send(renderMetrics('ps-11', gauges));
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

  // ── The self party: the stack owner's own identity (the seller) ──────
  // One home for what MOD-04 and MOD-13 otherwise each read from their own
  // SELLER_* environment variables.
  app.get('/api/self', requireCaller, (_req, res) => {
    res.json({ party: getSelf(db) });
  });

  app.put('/api/self', requireCaller, (req, res) => {
    res.json({ party: putSelf(db, body(req), at()) });
  });

  // ── Parties ─────────────────────────────────────────────────────────
  // Find-or-create. Declared before /api/parties/:id so "resolve" is never
  // mistaken for an id.
  app.post('/api/parties/resolve', requireCaller, (req, res) => {
    const result = resolveParty(db, body(req) as never, at());
    res.status(result.created ? 201 : 200).json(result);
  });

  app.get('/api/parties', requireCaller, (req, res) => {
    const kind = typeof req.query.kind === 'string' ? (req.query.kind as PartyKind) : undefined;
    if (kind !== undefined && !(PARTY_KINDS as readonly string[]).includes(kind)) {
      fail(422, `kind must be one of: ${PARTY_KINDS.join(', ')}`);
    }
    res.json({
      parties: listParties(db, {
        q: typeof req.query.q === 'string' && req.query.q !== '' ? req.query.q : undefined,
        kind,
        includeArchived: req.query.include_archived === 'true',
        limit: req.query.limit !== undefined ? Number(req.query.limit) : undefined,
      }),
    });
  });

  app.post('/api/parties', requireCaller, (req, res) => {
    const input = cleanInput(body(req));
    const key = req.headers['idempotency-key'];
    const { party, replayed } = createPartyIdempotent(db, input, typeof key === 'string' ? key : null, at());
    res.status(replayed ? 200 : 201).json({ party });
  });

  // Reading a party follows any merge: a consumer holding a pre-merge id gets
  // the surviving record, with `requested_id` saying so, rather than a stale one.
  app.get('/api/parties/:id', requireCaller, (req, res) => {
    const requested = idParam(req);
    const party = resolveMerged(db, requested);
    res.json({
      party,
      refs: listRefs(db, party.id),
      ...(party.id === requested ? {} : { requested_id: requested }),
    });
  });

  app.patch('/api/parties/:id', requireCaller, (req, res) => {
    res.json({ party: updateParty(db, idParam(req), body(req), at()) });
  });

  app.post('/api/parties/:id/archive', requireCaller, (req, res) => {
    res.json({ party: archiveParty(db, idParam(req), at()) });
  });

  // GDPR erasure: anonymize in place, keep the id so module references hold.
  app.post('/api/parties/:id/erase', requireCaller, (req, res) => {
    res.json({ party: eraseParty(db, idParam(req), at()) });
  });

  // Reconcile two records for one company: :id is merged INTO `into`. The
  // loser's row is kept as a redirect, so no module's reference breaks.
  app.post('/api/parties/:id/merge', requireCaller, (req, res) => {
    const into = Number(body(req).into);
    if (!Number.isInteger(into) || into <= 0) {
      fail(422, 'Validation failed', [{ field: 'into', message: 'must be the id of the surviving party' }]);
    }
    res.json(mergeParties(db, idParam(req), into, at()));
  });

  // ── References: a module's own id for a party ────────────────────────
  app.get('/api/parties/:id/refs', requireCaller, (req, res) => {
    const party = requireParty(db, idParam(req));
    res.json({ refs: listRefs(db, party.id) });
  });

  app.post('/api/parties/:id/refs', requireCaller, (req, res) => {
    const b = body(req);
    const source = typeof b.source === 'string' ? b.source.trim() : '';
    const externalId = typeof b.external_id === 'string' ? b.external_id.trim() : '';
    if (source === '' || externalId === '') {
      fail(422, 'Validation failed', [
        ...(source === '' ? [{ field: 'source', message: 'is required' }] : []),
        ...(externalId === '' ? [{ field: 'external_id', message: 'is required' }] : []),
      ]);
    }
    res.status(201).json({ ref: linkRef(db, idParam(req), source, externalId, at()) });
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
