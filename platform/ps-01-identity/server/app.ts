import express, { type NextFunction, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { PERMISSIONS, type Permission } from '../shared/types.js';
import {
  clearedCookie,
  COOKIE_NAME,
  createToken,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  nowIso,
  parseBearer,
  parseCookies,
  sessionCookie,
  verifyPassword,
  verifyToken,
  type SessionConfig,
} from './auth.js';
import { DomainError, fail, reqEmail, reqText } from './errors.js';
import {
  listRoles,
  mapOrg,
  mapUser,
  roleForOrg,
  userPermissions,
  userRoles,
  type OrgRow,
  type UserRow,
} from './identity.js';
import { keySummary, mintApiKey, verifyApiKey, type ApiKeyRow } from './api-keys.js';
import { verifyProvidedToken } from './tokens.js';
import { beginAuthorize, isOAuthProvider } from './oauth.js';

const MIN_PASSWORD_LENGTH = 8;

interface Principal {
  kind: 'user' | 'api_key';
  orgId: number;
  userId: number | null;
  permissions: Set<Permission>;
}

export interface AppOptions {
  db: Database.Database;
  session: SessionConfig;
  /** Injectable clock; defaults to the wall clock. */
  now?: () => number;
}

function idParam(req: Request, name = 'id'): number | null {
  const raw = req.params[name] as string;
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

export function createApp({ db, session, now = Date.now }: AppOptions): express.Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  const orgBySlug = db.prepare('SELECT * FROM organizations WHERE slug = ?');
  const orgById = db.prepare('SELECT * FROM organizations WHERE id = ?');
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const userByOrgEmail = db.prepare('SELECT * FROM users WHERE org_id = ? AND email = ?');

  const logEvent = (
    type: string,
    orgId: number | null,
    userId: number | null,
    req: Request,
    meta: Record<string, unknown> = {},
  ): void => {
    db.prepare(
      `INSERT INTO auth_events (org_id, user_id, type, ip, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(orgId, userId, type, req.ip ?? null, JSON.stringify(meta), nowIso(now()));
  };

  const principalOf = (res: Response): Principal => res.locals.principal as Principal;
  const userRowOf = (res: Response): UserRow => res.locals.userRow as UserRow;

  const require = (res: Response, perm: Permission): void => {
    if (!principalOf(res).permissions.has(perm)) {
      fail(403, `Missing required permission: ${perm}`);
    }
  };

  const issueSession = (res: Response, user: UserRow): string => {
    const token = createToken(
      session,
      { userId: user.id, orgId: user.org_id, tokenVersion: user.token_version },
      now(),
    );
    res.setHeader('Set-Cookie', sessionCookie(session, token));
    return token;
  };

  // ── Public routes ──────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/login', (req, res) => {
    const b = body(req);
    const orgSlug = typeof b.org_slug === 'string' ? b.org_slug.trim() : '';
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    if (!orgSlug || !email || !password) {
      fail(422, 'org_slug, email and password are required');
    }

    const org = orgBySlug.get(orgSlug) as OrgRow | undefined;
    const user =
      org && org.status === 'active'
        ? (userByOrgEmail.get(org.id, email) as UserRow | undefined)
        : undefined;
    // Always run scrypt (real or dummy) so timing never reveals whether the
    // organization or email exists.
    const ok = user
      ? user.status === 'active' && verifyPassword(password, user.password_hash)
      : (verifyPassword(password, DUMMY_PASSWORD_HASH), false);

    if (!user || !ok) {
      logEvent('login_fail', org?.id ?? null, user?.id ?? null, req, { email });
      fail(401, 'Invalid organization, email or password');
    }

    const token = issueSession(res, user);
    logEvent('login_ok', user.org_id, user.id, req);
    logEvent('token_issued', user.org_id, user.id, req);
    res.json({ token, user: mapUser(user) });
  });

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  app.get('/api/oauth/:provider/authorize', (req, res) => {
    const provider = req.params.provider as string;
    if (!isOAuthProvider(provider)) fail(404, 'Unknown OAuth provider');
    const redirect = typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : null;
    res.redirect(302, beginAuthorize(db, provider, redirect, now()));
  });

  app.get('/api/oauth/:provider/callback', (req, res) => {
    const provider = req.params.provider as string;
    if (!isOAuthProvider(provider)) fail(404, 'Unknown OAuth provider');
    res.status(501).json({ error: 'OAuth callback not implemented in this release' });
  });

  // ── Authentication gate (session cookie or Bearer) ─────────────────
  app.use('/api', (req, res, next) => {
    const bearer = parseBearer(req.headers.authorization);

    // Bearer API key → machine principal with full org access.
    if (bearer && bearer.startsWith('psk_')) {
      const orgId = verifyApiKey(db, bearer, now());
      if (orgId !== null) {
        res.locals.principal = {
          kind: 'api_key',
          orgId,
          userId: null,
          permissions: new Set<Permission>(PERMISSIONS),
        } satisfies Principal;
        next();
        return;
      }
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    // Otherwise a session token from the cookie or a Bearer header.
    const token = bearer ?? parseCookies(req.headers.cookie)[COOKIE_NAME];
    const claims = token ? verifyToken(session, token, now()) : null;
    if (claims) {
      const user = userById.get(claims.userId) as UserRow | undefined;
      if (
        user &&
        user.status === 'active' &&
        user.token_version === claims.tokenVersion &&
        user.org_id === claims.orgId
      ) {
        res.locals.userRow = user;
        res.locals.principal = {
          kind: 'user',
          orgId: user.org_id,
          userId: user.id,
          permissions: new Set<Permission>(userPermissions(db, user.id)),
        } satisfies Principal;
        next();
        return;
      }
    }
    res.status(401).json({ error: 'Authentication required' });
  });

  // ── Identity ───────────────────────────────────────────────────────
  app.get('/api/me', (_req, res) => {
    const p = principalOf(res);
    if (p.kind === 'api_key') {
      res.json({ user: null, roles: [], permissions: [...p.permissions].sort() });
      return;
    }
    const user = userRowOf(res);
    res.json({
      user: mapUser(user),
      roles: userRoles(db, user.id),
      permissions: userPermissions(db, user.id),
    });
  });

  // The cross-service contract: validate a PS-01 token and return claims.
  app.post('/api/tokens/verify', (req, res) => {
    res.json(verifyProvidedToken(db, session, body(req).token, now()));
  });

  app.get('/api/permissions', (_req, res) => {
    res.json({ permissions: PERMISSIONS });
  });

  // ── Organizations (tenant-scoped) ──────────────────────────────────
  app.get('/api/orgs', (_req, res) => {
    require(res, 'org:read');
    const org = orgById.get(principalOf(res).orgId) as OrgRow;
    res.json({ organizations: [mapOrg(org)] });
  });

  app.post('/api/orgs', (req, res) => {
    require(res, 'org:write');
    const b = body(req);
    const slug = reqText(b, 'slug', 64).toLowerCase();
    const name = reqText(b, 'name', 200);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      fail(422, 'Validation failed', [{ field: 'slug', message: 'must be lowercase alphanumeric/dashes' }]);
    }
    if (orgBySlug.get(slug)) fail(409, 'An organization with that slug already exists');
    const info = db
      .prepare(`INSERT INTO organizations (slug, name, status, created_at) VALUES (?, ?, 'active', ?)`)
      .run(slug, name, nowIso(now()));
    res.status(201).json({ organization: mapOrg(orgById.get(info.lastInsertRowid) as OrgRow) });
  });

  // ── Users (always scoped to the caller's org) ──────────────────────
  const requireUserInOrg = (res: Response, id: number | null): UserRow => {
    const user = id ? (userById.get(id) as UserRow | undefined) : undefined;
    if (!user || user.org_id !== principalOf(res).orgId) fail(404, 'User not found');
    return user;
  };

  app.get('/api/users', (_req, res) => {
    require(res, 'user:read');
    const rows = db
      .prepare('SELECT * FROM users WHERE org_id = ? ORDER BY created_at, id')
      .all(principalOf(res).orgId) as UserRow[];
    res.json({ users: rows.map(mapUser) });
  });

  app.post('/api/users', (req, res) => {
    require(res, 'user:write');
    const orgId = principalOf(res).orgId;
    const b = body(req);
    const email = reqEmail(b);
    const name = reqText(b, 'name', 200);
    const password = typeof b.password === 'string' ? b.password : '';
    if (password.length < MIN_PASSWORD_LENGTH) {
      fail(422, 'Validation failed', [
        { field: 'password', message: `must be at least ${MIN_PASSWORD_LENGTH} characters` },
      ]);
    }
    if (userByOrgEmail.get(orgId, email)) {
      fail(422, 'Validation failed', [{ field: 'email', message: 'already in use' }]);
    }
    const roleKeys = Array.isArray(b.role_keys) ? (b.role_keys as unknown[]) : ['member'];

    const created = db.transaction((): UserRow => {
      const info = db
        .prepare(
          `INSERT INTO users (org_id, email, name, password_hash, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(orgId, email, name, hashPassword(password), nowIso(now()));
      const userId = Number(info.lastInsertRowid);
      for (const key of roleKeys) {
        if (typeof key !== 'string') continue;
        const role = db
          .prepare('SELECT id FROM roles WHERE key = ? AND (org_id IS NULL OR org_id = ?)')
          .get(key, orgId) as { id: number } | undefined;
        if (!role) fail(422, 'Validation failed', [{ field: 'role_keys', message: `unknown role "${key}"` }]);
        db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)').run(
          userId,
          role.id,
          nowIso(now()),
        );
      }
      return userById.get(userId) as UserRow;
    })();

    res.status(201).json({ user: mapUser(created), roles: userRoles(db, created.id) });
  });

  app.get('/api/users/:id', (req, res) => {
    require(res, 'user:read');
    const user = requireUserInOrg(res, idParam(req));
    res.json({ user: mapUser(user), roles: userRoles(db, user.id) });
  });

  app.patch('/api/users/:id', (req, res) => {
    require(res, 'user:write');
    const user = requireUserInOrg(res, idParam(req));
    const b = body(req);
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : user.name;
    let status = user.status;
    if (typeof b.status === 'string') {
      if (b.status !== 'active' && b.status !== 'disabled') {
        fail(422, 'Validation failed', [{ field: 'status', message: 'must be active or disabled' }]);
      }
      status = b.status;
    }
    db.prepare('UPDATE users SET name = ?, status = ? WHERE id = ?').run(name, status, user.id);
    res.json({ user: mapUser(userById.get(user.id) as UserRow) });
  });

  app.post('/api/users/:id/password', (req, res) => {
    const p = principalOf(res);
    const id = idParam(req);
    const isSelf = p.userId !== null && p.userId === id;
    if (!isSelf) require(res, 'user:write');
    const user = requireUserInOrg(res, id);
    const b = body(req);
    const newPassword = typeof b.new_password === 'string' ? b.new_password : '';
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      fail(422, 'Validation failed', [
        { field: 'new_password', message: `must be at least ${MIN_PASSWORD_LENGTH} characters` },
      ]);
    }
    db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(
      hashPassword(newPassword),
      user.id,
    );
    logEvent('password_changed', user.org_id, user.id, req);
    res.json({ ok: true });
  });

  // ── Roles & permissions ────────────────────────────────────────────
  app.get('/api/roles', (_req, res) => {
    require(res, 'role:read');
    res.json({ roles: listRoles(db, principalOf(res).orgId) });
  });

  app.post('/api/roles', (req, res) => {
    require(res, 'role:write');
    const orgId = principalOf(res).orgId;
    const b = body(req);
    const key = reqText(b, 'key', 64).toLowerCase();
    const name = reqText(b, 'name', 200);
    const perms = Array.isArray(b.permissions) ? (b.permissions as unknown[]) : [];
    const clean: Permission[] = [];
    for (const perm of perms) {
      if (typeof perm !== 'string' || !(PERMISSIONS as readonly string[]).includes(perm)) {
        fail(422, 'Validation failed', [{ field: 'permissions', message: `unknown permission "${String(perm)}"` }]);
      }
      clean.push(perm as Permission);
    }
    if (db.prepare('SELECT 1 FROM roles WHERE org_id = ? AND key = ?').get(orgId, key)) {
      fail(409, 'A role with that key already exists');
    }
    const roleId = db.transaction((): number => {
      const info = db
        .prepare(`INSERT INTO roles (org_id, key, name, is_system, created_at) VALUES (?, ?, ?, 0, ?)`)
        .run(orgId, key, name, nowIso(now()));
      const id = Number(info.lastInsertRowid);
      for (const perm of clean) {
        db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)').run(id, perm);
      }
      return id;
    })();
    const roles = listRoles(db, orgId);
    res.status(201).json({ role: roles.find((r) => r.id === roleId) });
  });

  app.post('/api/users/:id/roles', (req, res) => {
    require(res, 'role:write');
    const user = requireUserInOrg(res, idParam(req));
    const roleId = Number(body(req).role_id);
    if (!Number.isInteger(roleId)) {
      fail(422, 'Validation failed', [{ field: 'role_id', message: 'is required' }]);
    }
    if (!roleForOrg(db, roleId, principalOf(res).orgId)) fail(404, 'Role not found');
    db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)').run(
      user.id,
      roleId,
      nowIso(now()),
    );
    res.json({ roles: userRoles(db, user.id) });
  });

  app.delete('/api/users/:id/roles/:roleId', (req, res) => {
    require(res, 'role:write');
    const user = requireUserInOrg(res, idParam(req));
    const roleId = idParam(req, 'roleId');
    if (roleId === null) fail(404, 'Role not found');
    db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?').run(user.id, roleId);
    res.json({ roles: userRoles(db, user.id) });
  });

  // ── API keys ───────────────────────────────────────────────────────
  app.get('/api/api-keys', (_req, res) => {
    require(res, 'apikey:read');
    const rows = db
      .prepare('SELECT * FROM api_keys WHERE org_id = ? ORDER BY created_at, id')
      .all(principalOf(res).orgId) as ApiKeyRow[];
    res.json({ api_keys: rows.map(keySummary) });
  });

  app.post('/api/api-keys', (req, res) => {
    require(res, 'apikey:write');
    const p = principalOf(res);
    const name = reqText(body(req), 'name', 200);
    const minted = mintApiKey(db, p.orgId, name, p.userId, now());
    logEvent('apikey_created', p.orgId, p.userId, req, { prefix: minted.summary.prefix });
    res.status(201).json({ api_key: minted.summary, secret: minted.secret });
  });

  app.delete('/api/api-keys/:id', (req, res) => {
    require(res, 'apikey:write');
    const p = principalOf(res);
    const id = idParam(req);
    const row = id ? (db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRow | undefined) : undefined;
    if (!row || row.org_id !== p.orgId) fail(404, 'API key not found');
    if (!row.revoked_at) {
      db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(nowIso(now()), row.id);
      logEvent('apikey_revoked', p.orgId, p.userId, req, { prefix: row.prefix });
    }
    res.json({ ok: true });
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
