import express, { type Request, type Response } from 'express';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import type Database from 'better-sqlite3';
import { getResource, resources, type ResourceDef } from '../shared/resources.js';
import {
  actorOf,
  checkCredentials,
  clearedCookie,
  createToken,
  requireAuth,
  sessionCookie,
  type AuthConfig,
} from './auth.js';
import { toCsv } from './csv.js';
import { noopPlatform, type PlatformHooks } from './platform.js';
import { LOCAL_LOGIN, nullVerifier, type LoginMode, type LoginVerifier } from './sso.js';
import { validateRecord } from './validate.js';

/** A LIKE pattern that matches the term literally — see the ESCAPE clauses below. */
function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

interface ListQuery {
  where: string;
  params: (string | number)[];
  orderBy: string;
  page: number;
  pageSize: number;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Build WHERE/ORDER BY from query params. Column names are whitelisted. */
function buildListQuery(resource: ResourceDef, query: Request['query']): ListQuery {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  const search = str(query.search);
  if (search) {
    const searchable = resource.fields.filter((f) => f.type === 'text' || f.type === 'select');
    if (searchable.length > 0) {
      clauses.push(`(${searchable.map((f) => `"${f.name}" LIKE ? ESCAPE \'\\\'`).join(' OR ')})`);
      for (const _ of searchable) params.push(likeTerm(search));
    }
  }

  for (const field of resource.fields) {
    const value = str(query[`f_${field.name}`]);
    if (value === undefined) continue;
    switch (field.type) {
      case 'text':
        clauses.push(`"${field.name}" LIKE ? ESCAPE \'\\\'`);
        params.push(likeTerm(value));
        break;
      case 'number':
        clauses.push(`"${field.name}" = ?`);
        params.push(Number(value));
        break;
      case 'boolean':
        clauses.push(`"${field.name}" = ?`);
        params.push(value === 'true' || value === '1' ? 1 : 0);
        break;
      default:
        clauses.push(`"${field.name}" = ?`);
        params.push(value);
    }
  }

  const sortable = new Set(['id', ...resource.fields.map((f) => f.name)]);
  const sort = str(query.sort);
  const column = sort && sortable.has(sort) ? sort : 'id';
  const dir = str(query.dir) === 'desc' ? 'DESC' : 'ASC';

  const page = Math.max(1, Number(str(query.page)) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(str(query.pageSize)) || 25));

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
    orderBy: `ORDER BY "${column}" ${dir}`,
    page,
    pageSize,
  };
}

/**
 * The most ids one request may address. Every id becomes a bound parameter in
 * an `IN (...)`, and SQLite refuses a statement carrying more than 32766 of
 * them by THROWING — which reached the client as a 500 on a request whose only
 * fault was being too large. The cap is well under that and well over the
 * 200-row maximum page, so no selection the UI can make ever hits it.
 */
const MAX_IDS = 1000;

/**
 * An `ids` batch: the query parameter of the CSV export, or the body of
 * bulk-delete.
 *
 * Three outcomes, not two. `absent` and `invalid` used to collapse into the
 * same `null`, and the export read that as "no filter" — so `?ids=1,abc`
 * quietly exported the WHOLE table instead of refusing a malformed filter. A
 * request that asks for something impossible is told so; a request that asks
 * for nothing gets the unfiltered list it asked for.
 */
type IdBatch =
  | { kind: 'absent' }
  | { kind: 'ids'; ids: number[] }
  | { kind: 'invalid'; message: string };

function parseIds(raw: unknown): IdBatch {
  if (raw === undefined || raw === null || raw === '') return { kind: 'absent' };
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null;
  if (values === null) return { kind: 'invalid', message: 'ids must be a list of positive integers' };
  if (values.length === 0) return { kind: 'absent' };
  if (values.length > MAX_IDS) {
    return { kind: 'invalid', message: `ids must hold at most ${MAX_IDS} entries (got ${values.length})` };
  }
  const ids = values.map(Number);
  if (!ids.every((n) => Number.isInteger(n) && n > 0)) {
    return { kind: 'invalid', message: 'ids must be a list of positive integers' };
  }
  return { kind: 'ids', ids };
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
   * Which credentials the login form should name, served as-is from
   * GET /api/auth-mode. Defaults to this module's own — the standalone case.
   */
  loginMode?: LoginMode;
}

export function createApp({ db, hardening, auth, staticDir, platform = noopPlatform, verifyLogin = nullVerifier, loginMode = LOCAL_LOGIN }: AppOptions): express.Express {
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
  app.use(express.json({ limit: '1mb' }));

  const findResource = (req: Request, res: Response): ResourceDef | undefined => {
    const resource = getResource(req.params.resource as string);
    if (!resource) res.status(404).json({ error: 'Unknown resource' });
    return resource;
  };

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
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
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

  // ── Everything below requires a valid session ────────────────────────
  app.use('/api', requireAuth(auth));

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  app.get('/api/config', (_req, res) => {
    res.json({ resources, username: actorOf(res, auth) });
  });

  app.get('/api/:resource/export.csv', (req, res) => {
    const resource = findResource(req, res);
    if (!resource) return;

    const batch = parseIds(req.query.ids);
    if (batch.kind === 'invalid') {
      res.status(422).json({ error: batch.message });
      return;
    }
    let rows: Record<string, unknown>[];
    if (batch.kind === 'ids') {
      const { ids } = batch;
      rows = db
        .prepare(`SELECT * FROM "${resource.name}" WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
        .all(...ids) as Record<string, unknown>[];
    } else {
      const q = buildListQuery(resource, req.query);
      rows = db
        .prepare(`SELECT * FROM "${resource.name}" ${q.where} ${q.orderBy}`)
        .all(...q.params) as Record<string, unknown>[];
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${resource.name}.csv"`);
    res.send(toCsv(resource, rows));
  });

  app.get('/api/:resource', (req, res) => {
    const resource = findResource(req, res);
    if (!resource) return;

    const q = buildListQuery(resource, req.query);
    const { total } = db
      .prepare(`SELECT COUNT(*) AS total FROM "${resource.name}" ${q.where}`)
      .get(...q.params) as { total: number };
    const rows = db
      .prepare(`SELECT * FROM "${resource.name}" ${q.where} ${q.orderBy} LIMIT ? OFFSET ?`)
      .all(...q.params, q.pageSize, (q.page - 1) * q.pageSize);
    res.json({ rows, total, page: q.page, pageSize: q.pageSize });
  });

  app.get('/api/:resource/:id', (req, res) => {
    const resource = findResource(req, res);
    if (!resource) return;
    const row = db.prepare(`SELECT * FROM "${resource.name}" WHERE id = ?`).get(req.params.id);
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(row);
  });

  app.post('/api/:resource', (req, res) => {
    const resource = findResource(req, res);
    if (!resource) return;

    const { errors, values } = validateRecord(resource, req.body);
    if (errors.length > 0) {
      res.status(422).json({ error: 'Validation failed', details: errors });
      return;
    }
    const columns = resource.fields.map((f) => f.name);
    const info = db
      .prepare(
        `INSERT INTO "${resource.name}" (${columns.map((c) => `"${c}"`).join(',')})
         VALUES (${columns.map(() => '?').join(',')})`,
      )
      .run(...columns.map((c) => values[c]));
    const row = db.prepare(`SELECT * FROM "${resource.name}" WHERE id = ?`).get(info.lastInsertRowid);
    void platform.audit({ actor: actorOf(res, auth), action: `${resource.name}.created`, resource: `${resource.name}:${info.lastInsertRowid}`, after: row });
    res.status(201).json(row);
  });

  app.put('/api/:resource/:id', (req, res) => {
    const resource = findResource(req, res);
    if (!resource) return;

    const existing = db.prepare(`SELECT id FROM "${resource.name}" WHERE id = ?`).get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const { errors, values } = validateRecord(resource, req.body);
    if (errors.length > 0) {
      res.status(422).json({ error: 'Validation failed', details: errors });
      return;
    }
    const columns = resource.fields.map((f) => f.name);
    db.prepare(
      `UPDATE "${resource.name}" SET ${columns.map((c) => `"${c}" = ?`).join(', ')} WHERE id = ?`,
    ).run(...columns.map((c) => values[c]), req.params.id);
    const row = db.prepare(`SELECT * FROM "${resource.name}" WHERE id = ?`).get(req.params.id);
    void platform.audit({ actor: actorOf(res, auth), action: `${resource.name}.updated`, resource: `${resource.name}:${req.params.id}`, after: row });
    res.json(row);
  });

  app.delete('/api/:resource/:id', (req, res) => {
    const resource = findResource(req, res);
    if (!resource) return;
    const info = db.prepare(`DELETE FROM "${resource.name}" WHERE id = ?`).run(req.params.id);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    void platform.audit({ actor: actorOf(res, auth), action: `${resource.name}.deleted`, resource: `${resource.name}:${req.params.id}` });
    res.json({ ok: true });
  });

  app.post('/api/:resource/bulk-delete', (req, res) => {
    const resource = findResource(req, res);
    if (!resource) return;
    const batch = parseIds((req.body as Record<string, unknown> | undefined)?.ids);
    if (batch.kind !== 'ids') {
      res.status(422).json({
        error: batch.kind === 'invalid' ? batch.message : 'Body must be {"ids": [1, 2, ...]}',
      });
      return;
    }
    const { ids } = batch;
    const info = db
      .prepare(`DELETE FROM "${resource.name}" WHERE id IN (${ids.map(() => '?').join(',')})`)
      .run(...ids);
    res.json({ ok: true, deleted: info.changes });
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

  return app;
}
