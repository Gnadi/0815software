import express, { type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { getResource, resources, type ResourceDef } from '../shared/resources.js';
import {
  checkCredentials,
  clearedCookie,
  createToken,
  requireAuth,
  sessionCookie,
  type AuthConfig,
} from './auth.js';
import { toCsv } from './csv.js';
import { noopPlatform, type PlatformHooks } from './platform.js';
import { nullVerifier, type LoginVerifier } from './sso.js';
import { validateRecord } from './validate.js';

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
      clauses.push(`(${searchable.map((f) => `"${f.name}" LIKE ?`).join(' OR ')})`);
      for (const _ of searchable) params.push(`%${search}%`);
    }
  }

  for (const field of resource.fields) {
    const value = str(query[`f_${field.name}`]);
    if (value === undefined) continue;
    switch (field.type) {
      case 'text':
        clauses.push(`"${field.name}" LIKE ?`);
        params.push(`%${value}%`);
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

function parseIds(raw: unknown): number[] | null {
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null;
  if (!values || values.length === 0) return null;
  const ids = values.map(Number);
  return ids.every((n) => Number.isInteger(n) && n > 0) ? ids : null;
}

export interface AppOptions {
  db: Database.Database;
  auth: AuthConfig;
  /** Absolute path to the built client (dist/client). Omit to serve API only. */
  staticDir?: string;
  /** Optional PS-07 Audit integration; defaults to a no-op (standalone). */
  platform?: PlatformHooks;
  verifyLogin?: LoginVerifier;
}

export function createApp({ db, auth, staticDir, platform = noopPlatform, verifyLogin = nullVerifier }: AppOptions): express.Express {
  const app = express();
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

  app.post('/api/login', async (req, res) => {
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    // SSO seam: when IDENTITY_URL is set, PS-01 validates the credentials;
    // otherwise the local admin credentials do. Either way the module mints
    // its own session below, so the rest of the request path is unchanged.
    const viaSso = await verifyLogin(username, password);
    const authed = viaSso === null ? checkCredentials(auth, username, password) : viaSso === 'ok';
    if (!authed) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    res.setHeader('Set-Cookie', sessionCookie(auth, createToken(auth)));
    res.json({ ok: true, username: auth.username });
  });

  // ── Everything below requires a valid session ────────────────────────
  app.use('/api', requireAuth(auth));

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  app.get('/api/config', (_req, res) => {
    res.json({ resources, username: auth.username });
  });

  app.get('/api/:resource/export.csv', (req, res) => {
    const resource = findResource(req, res);
    if (!resource) return;

    const ids = parseIds(req.query.ids);
    let rows: Record<string, unknown>[];
    if (ids) {
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
    void platform.audit({ actor: auth.username, action: `${resource.name}.created`, resource: `${resource.name}:${info.lastInsertRowid}`, after: row });
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
    void platform.audit({ actor: auth.username, action: `${resource.name}.updated`, resource: `${resource.name}:${req.params.id}`, after: row });
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
    void platform.audit({ actor: auth.username, action: `${resource.name}.deleted`, resource: `${resource.name}:${req.params.id}` });
    res.json({ ok: true });
  });

  app.post('/api/:resource/bulk-delete', (req, res) => {
    const resource = findResource(req, res);
    if (!resource) return;
    const ids = parseIds((req.body as Record<string, unknown> | undefined)?.ids);
    if (!ids) {
      res.status(422).json({ error: 'Body must be {"ids": [1, 2, ...]}' });
      return;
    }
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
