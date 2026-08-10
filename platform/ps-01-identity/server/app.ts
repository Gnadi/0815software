import { randomBytes } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { PERMISSIONS, type Permission } from '../shared/types.js';
import {
  clearedCookie,
  COOKIE_NAME,
  createToken,
  dummyPasswordHash,
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
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import { MIGRATIONS } from './db.js';
import { pendingCount } from './migrations.js';
import { renderMetrics, requestTelemetry, type Gauge } from './telemetry.js';
import {
  listRoles,
  mapOrg,
  mapUser,
  roleForOrg,
  rolePermissions,
  userPermissions,
  userRoles,
  type OrgRow,
  type UserRow,
} from './identity.js';
import { keySummary, mintApiKey, verifyApiKey, type ApiKeyRow } from './api-keys.js';
import { verifyProvidedToken } from './tokens.js';
import { exportSubject } from './export.js';
import {
  clearFailures,
  delayFor,
  failureCount,
  pruneThrottle,
  realSleep,
  recordFailure,
  DEFAULT_THROTTLE,
  type Sleep,
  type ThrottleConfig,
} from './throttle.js';
import {
  beginAuthorize,
  consumeState,
  fetchIdentity,
  isAllowedRedirect,
  isOAuthProvider,
  linkUser,
  mockIdentity,
  type FetchLike,
  type OAuthConfig,
} from './oauth.js';

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
  /** Configured OAuth providers; unconfigured providers use the mock IdP. */
  oauth?: OAuthConfig;
  /** Public base URL used to build OAuth redirect URIs. */
  selfBaseUrl?: string;
  /**
   * Whether an UNCONFIGURED provider may fall back to the offline mock IdP.
   * The mock resolves an identity with no credential at all, so it is a
   * development affordance only: `index.ts` turns it off in production.
   * Defaults to true so tests and `npm run dev:api` work out of the box.
   */
  allowMockIdp?: boolean;
  /**
   * Origins a post-login `redirect_uri` may point at, beyond this service's
   * own. The callback appends the session token to that URL, so anything not
   * listed here (and not a same-site path) is refused.
   */
  redirectAllowlist?: string[];
  /** Injectable clock; defaults to the wall clock. */
  now?: () => number;
  /** Per-account login backoff. */
  throttle?: ThrottleConfig;
  /** Injectable sleep so tests exercise the backoff without waiting for it. */
  sleep?: Sleep;
  /** Injectable fetch for the OAuth token/userinfo exchange (tests). */
  fetch?: FetchLike;
  /** Rate limiting / security headers / CORS; omitted in tests, set on boot. */
  hardening?: HardeningConfig;
  /** Emit one JSON log line per request (default false; index.ts passes true). */
  logRequests?: boolean;
}

function idParam(req: Request, name = 'id'): number | null {
  const raw = req.params[name] as string;
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

export function createApp({
  db,
  session,
  oauth = {},
  selfBaseUrl = `http://localhost:4001`,
  allowMockIdp = true,
  redirectAllowlist = [],
  now = Date.now,
  throttle = DEFAULT_THROTTLE,
  sleep = realSleep,
  fetch: injectedFetch,
  hardening,
  logRequests,
}: AppOptions): express.Express {
  // Compute the equal-work dummy hash now, at startup and off the event loop,
  // so no request ever pays for generating it. Otherwise the first login
  // against an unknown account would be measurably slower than every later
  // one — a timing difference this hash exists to remove.
  void dummyPasswordHash();

  const app = express();
  if (hardening) {
    // Behind the stack's reverse proxy every socket peer is the proxy, so the
    // forwarded chain is what per-IP limiting and audit logging must read.
    if (hardening.trustProxy > 0) app.set('trust proxy', hardening.trustProxy);
    app.use(hardeningMiddleware(hardening));
  }
  app.use(requestTelemetry({ service: 'ps-01', log: logRequests === true }));
  app.use(express.json({ limit: '256kb' }));

  const doFetch: FetchLike =
    injectedFetch ?? (globalThis.fetch as unknown as FetchLike);

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

  /**
   * No principal may hand out authority it does not itself hold.
   *
   * `role:write` and `apikey:write` are permissions to ADMINISTER grants, not
   * to invent them. Without this cap an Administrator — who deliberately lacks
   * `org:write` — could reach it three ways: mint an unscoped API key (which
   * carried the whole catalogue), define a custom role granting it, or simply
   * assign themselves the Owner role. Each turned "may manage roles and keys"
   * into "may become the Owner", which is the escalation the role split exists
   * to prevent.
   */
  const requireGrantable = (res: Response, granted: readonly Permission[]): void => {
    const held = principalOf(res).permissions;
    const excess = [...new Set(granted)].filter((p) => !held.has(p)).sort();
    if (excess.length > 0) {
      fail(403, `Cannot grant a permission you do not hold: ${excess.join(', ')}`);
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
    res.type('text/plain').send(renderMetrics('ps-01', gauges));
  });

  app.post('/api/login', (req, res, next) => {
    void (async () => {
      const b = body(req);
      const orgSlug = typeof b.org_slug === 'string' ? b.org_slug.trim() : '';
      const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
      const password = typeof b.password === 'string' ? b.password : '';
      if (!orgSlug || !email || !password) {
        fail(422, 'org_slug, email and password are required');
      }

      // Guessing at ONE account has to get expensive, however many addresses
      // the guesses come from — the per-IP limiter cannot see that. The wait
      // is paid before the attempt is judged, so every guess costs it, and it
      // is keyed on what was submitted, so the delay cannot be used to tell a
      // real account from an invented one. See server/throttle.ts.
      const waited = delayFor(failureCount(db, orgSlug, email, throttle, now()), throttle);
      if (waited > 0) await sleep(waited);

      const org = orgBySlug.get(orgSlug) as OrgRow | undefined;
      const user =
        org && org.status === 'active'
          ? (userByOrgEmail.get(org.id, email) as UserRow | undefined)
          : undefined;
      // Always run scrypt exactly once — against the real hash when there is a
      // usable account, against the dummy otherwise — so response timing never
      // reveals whether the organization, the email, or an ACTIVE account
      // exists. (The previous form short-circuited on `status !== 'active'`,
      // which skipped the hash and made a suspended account answer measurably
      // faster than a live one.) The await puts that work on the threadpool
      // instead of the event loop; see server/auth.ts.
      const account = user && user.status === 'active' ? user : undefined;
      const ok = await verifyPassword(password, account ? account.password_hash : await dummyPasswordHash());

      if (!account || !ok) {
        recordFailure(db, orgSlug, email, throttle, now());
        logEvent('login_fail', org?.id ?? null, user?.id ?? null, req, { email, delayed_ms: waited });
        fail(401, 'Invalid organization, email or password');
      }

      // A correct password ends the backoff: the legitimate owner pays the
      // wait once, not for as long as someone else keeps guessing.
      clearFailures(db, orgSlug, email);
      pruneThrottle(db, throttle, now());
      const token = issueSession(res, account);
      logEvent('login_ok', account.org_id, account.id, req);
      logEvent('token_issued', account.org_id, account.id, req);
      res.json({ token, user: mapUser(account) });
    })().catch(next);
  });

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  // The cross-service contract: validate a PS-01 credential (session token or
  // psk_ API key) and return its claims + permissions. PUBLIC — the presented
  // token IS the credential; downstream services call this unauthenticated,
  // and an invalid token yields only { valid: false }.
  app.post('/api/tokens/verify', (req, res, next) => {
    void (async () => {
      res.json(await verifyProvidedToken(db, session, body(req).token, now()));
    })().catch(next);
  });

  app.get('/api/oauth/:provider/authorize', (req, res) => {
    const provider = req.params.provider as string;
    if (!isOAuthProvider(provider)) fail(404, 'Unknown OAuth provider');
    const orgSlug = typeof req.query.org_slug === 'string' ? req.query.org_slug.trim() : '';
    if (!orgSlug) fail(422, 'org_slug query parameter is required');
    const org = orgBySlug.get(orgSlug) as OrgRow | undefined;
    if (!org || org.status !== 'active') fail(404, 'Unknown organization');
    const redirect = typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : null;
    // The callback hands the session token to this URL — only ever to an
    // origin the operator vouched for.
    if (redirect !== null && !isAllowedRedirect(redirect, redirectAllowlist, selfBaseUrl)) {
      fail(422, 'redirect_uri is not an allowed redirect target');
    }
    res.redirect(
      302,
      beginAuthorize(
        db,
        provider,
        { orgSlug, redirectUri: redirect, providerConfig: oauth[provider], selfBaseUrl, allowMockIdp },
        now(),
      ),
    );
  });

  app.get('/api/oauth/:provider/callback', (req, res, next) => {
    void (async () => {
      const provider = req.params.provider as string;
      if (!isOAuthProvider(provider)) fail(404, 'Unknown OAuth provider');

      const stateRow = consumeState(db, provider, req.query.state, now());
      if (!stateRow) fail(400, 'Invalid or expired OAuth state');
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!code) fail(422, 'code is required');

      const org = stateRow.org_slug ? (orgBySlug.get(stateRow.org_slug) as OrgRow | undefined) : undefined;
      if (!org || org.status !== 'active') fail(400, 'Organization no longer available');

      const cfg = oauth[provider];
      // Defence in depth: authorize already refuses to mint a state for an
      // unconfigured provider when the mock is off, so this cannot normally be
      // reached — but the mock resolves an identity with no credential, and
      // that must never be one stale row away from issuing a session.
      if (!cfg && !allowMockIdp) fail(501, `OAuth provider "${provider}" is not configured`);
      const identity = cfg
        ? await fetchIdentity(cfg, code, `${selfBaseUrl}/api/oauth/${provider}/callback`, doFetch)
        : mockIdentity(provider, org.slug);

      const user = await linkUser(db, org.id, identity, now());
      const token = issueSession(res, user);
      logEvent('login_ok', user.org_id, user.id, req, { via: `oauth:${provider}` });
      logEvent('token_issued', user.org_id, user.id, req);

      if (stateRow.redirect_uri && isAllowedRedirect(stateRow.redirect_uri, redirectAllowlist, selfBaseUrl)) {
        const sep = stateRow.redirect_uri.includes('?') ? '&' : '?';
        res.redirect(302, `${stateRow.redirect_uri}${sep}token=${encodeURIComponent(token)}`);
      } else {
        res.json({ token, user: mapUser(user) });
      }
    })().catch(next);
  });

  // ── Authentication gate (session cookie or Bearer) ─────────────────
  app.use('/api', (req, res, next) => {
    void (async () => {
      const bearer = parseBearer(req.headers.authorization);

      // Bearer API key → machine principal carrying the key's scopes
      // (an unscoped key keeps the historical full-permission behaviour).
      // Verifying one costs a scrypt, hence the await: on the threadpool it
      // does not stall every other request in flight.
      if (bearer && bearer.startsWith('psk_')) {
        const key = await verifyApiKey(db, bearer, now());
        if (key !== null) {
          res.locals.principal = {
            kind: 'api_key',
            orgId: key.orgId,
            userId: null,
            permissions: new Set<Permission>(key.scopes ?? PERMISSIONS),
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
    })().catch(next);
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

  /**
   * Revoke every session of a user — the "I lost my laptop" button.
   *
   * Sessions are stateless HMAC tokens, so there is nothing to delete: what
   * invalidates them is `token_version`, and until now only a password change
   * bumped it. Someone who suspects a stolen token but has no reason to change
   * their password had no way to act on it, and an administrator had none at
   * all short of resetting the account's password.
   *
   * The caller's own new session is issued in the same response, so revoking
   * does not log you out of the browser you are asking from.
   */
  const revokeSessions = (req: Request, res: Response, target: UserRow): void => {
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(target.id);
    logEvent('sessions_revoked', target.org_id, target.id, req);
    const fresh = userById.get(target.id) as UserRow;
    const p = principalOf(res);
    const isSelf = p.kind === 'user' && p.userId === target.id;
    res.json({ revoked: true, token: isSelf ? issueSession(res, fresh) : null });
  };

  app.post('/api/me/sessions/revoke', (req, res) => {
    const p = principalOf(res);
    if (p.kind !== 'user') fail(403, 'An API key has no sessions to revoke');
    revokeSessions(req, res, userRowOf(res));
  });

  app.post('/api/users/:id/sessions/revoke', (req, res) => {
    require(res, 'user:write');
    revokeSessions(req, res, requireUserInOrg(res, idParam(req)));
  });

  /**
   * Subject access / portability: everything this service holds about one
   * person, by email. See server/export.ts for what is included and what is
   * deliberately not.
   */
  app.get('/api/export', (req, res) => {
    // `user:write`, not `user:read`: every role down to viewer holds the read
    // permission because it is the directory, and this is not directory data —
    // it copies out auth events with IP addresses. Disclosing someone's record
    // is an administrative act.
    require(res, 'user:write');
    const subject = typeof req.query.subject === 'string' ? req.query.subject.trim() : '';
    if (!subject) fail(422, 'subject query parameter is required');
    res.json(exportSubject(db, principalOf(res).orgId, subject, nowIso(now())));
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

  app.post('/api/orgs', (req, res, next) => {
    void (async () => {
    require(res, 'org:write');
    const b = body(req);
    const slug = reqText(b, 'slug', 64).toLowerCase();
    const name = reqText(b, 'name', 200);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      fail(422, 'Validation failed', [{ field: 'slug', message: 'must be lowercase alphanumeric/dashes' }]);
    }
    if (orgBySlug.get(slug)) fail(409, 'An organization with that slug already exists');

    /**
     * An organization with no user is a dead end: `POST /api/users` always
     * creates into the CALLER's org, and login needs a user inside the new
     * one — so nothing could ever enter an org created bare. An `owner` block
     * is therefore how a usable org is provisioned. It stays optional for the
     * caller who really does want an empty shell (a migration filling users in
     * by another route), and that case now says so out loud in the response.
     */
    let owner: { email: string; name: string; password: string } | null = null;
    if (b.owner !== undefined && b.owner !== null) {
      if (typeof b.owner !== 'object') {
        fail(422, 'Validation failed', [{ field: 'owner', message: 'must be an object' }]);
      }
      const o = b.owner as Record<string, unknown>;
      const password = typeof o.password === 'string' ? o.password : '';
      if (password.length < MIN_PASSWORD_LENGTH) {
        fail(422, 'Validation failed', [
          { field: 'owner.password', message: `must be at least ${MIN_PASSWORD_LENGTH} characters` },
        ]);
      }
      owner = { email: reqEmail(o, 'email'), name: reqText(o, 'name', 200), password };
    }

    // Hashed up front: the insert below runs inside a better-sqlite3
    // transaction, which is synchronous and cannot contain an await.
    const ownerHash = owner ? await hashPassword(owner.password) : null;

    const created = db.transaction((): { org: OrgRow; user: UserRow | null } => {
      const at = nowIso(now());
      const info = db
        .prepare(`INSERT INTO organizations (slug, name, status, created_at) VALUES (?, ?, 'active', ?)`)
        .run(slug, name, at);
      const org = orgById.get(info.lastInsertRowid) as OrgRow;
      if (!owner || ownerHash === null) return { org, user: null };

      const userInfo = db
        .prepare(`INSERT INTO users (org_id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(org.id, owner.email, owner.name, ownerHash, at);
      const role = db.prepare('SELECT id FROM roles WHERE key = ? AND org_id IS NULL').get('owner') as
        | { id: number }
        | undefined;
      if (!role) fail(500, 'The system "owner" role is missing — the database was not seeded');
      db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)').run(
        Number(userInfo.lastInsertRowid),
        role.id,
        at,
      );
      return { org, user: userById.get(userInfo.lastInsertRowid) as UserRow };
    })();

    res.status(201).json({
      organization: mapOrg(created.org),
      owner: created.user ? mapUser(created.user) : null,
      ...(created.user
        ? {}
        : { warning: 'Created with no user: nobody can log into this organization until one exists.' }),
    });
    })().catch(next);
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

  app.post('/api/users', (req, res, next) => {
    void (async () => {
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

    // Hashed before the (synchronous) transaction opens — see POST /api/orgs.
    const passwordHash = await hashPassword(password);

    const created = db.transaction((): UserRow => {
      const info = db
        .prepare(
          `INSERT INTO users (org_id, email, name, password_hash, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(orgId, email, name, passwordHash, nowIso(now()));
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
    })().catch(next);
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

  app.post('/api/users/:id/password', (req, res, next) => {
    void (async () => {
    const p = principalOf(res);
    const id = idParam(req);
    const isSelf = p.userId !== null && p.userId === id;
    if (!isSelf) require(res, 'user:write');
    const user = requireUserInOrg(res, id);
    const b = body(req);
    // Changing your OWN password proves you still know the old one, so a
    // stolen session token cannot be turned into permanent account takeover.
    // An administrator resetting SOMEONE ELSE's password does not know it and
    // is authorized by `user:write` instead — that is the reset path.
    if (isSelf) {
      const current = typeof b.current_password === 'string' ? b.current_password : '';
      if (!(await verifyPassword(current, user.password_hash))) {
        logEvent('password_change_denied', user.org_id, user.id, req);
        fail(422, 'Validation failed', [{ field: 'current_password', message: 'is incorrect' }]);
      }
    }
    const newPassword = typeof b.new_password === 'string' ? b.new_password : '';
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      fail(422, 'Validation failed', [
        { field: 'new_password', message: `must be at least ${MIN_PASSWORD_LENGTH} characters` },
      ]);
    }
    db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(
      await hashPassword(newPassword),
      user.id,
    );
    logEvent('password_changed', user.org_id, user.id, req);
    res.json({ ok: true });
    })().catch(next);
  });

  // GDPR erasure hook: anonymize the user's PII in place while keeping the row
  // and id (so downstream audit trails and records stay referentially intact),
  // scramble the password, bump token_version to kill any live sessions, and
  // disable the account so it can never log in again.
  app.post('/api/users/:id/erase', (req, res, next) => {
    void (async () => {
    require(res, 'user:write');
    const id = idParam(req);
    const user = requireUserInOrg(res, id);
    db.prepare(
      `UPDATE users
         SET email = ?, name = 'Erased User', password_hash = ?,
             token_version = token_version + 1, status = 'disabled'
       WHERE id = ?`,
    ).run(`erased+${user.id}@invalid.example`, await hashPassword(randomBytes(24).toString('hex')), user.id);
    logEvent('user_erased', user.org_id, user.id, req);
    res.json({ erased: true, user: mapUser(userById.get(user.id) as UserRow) });
    })().catch(next);
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
    requireGrantable(res, clean);
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
    // Assigning a role hands its permissions to the target — including, when
    // the target is the caller, to the caller.
    requireGrantable(res, rolePermissions(db, roleId));
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

  app.post('/api/api-keys', (req, res, next) => {
    void (async () => {
    require(res, 'apikey:write');
    const p = principalOf(res);
    const b = body(req);
    const name = reqText(b, 'name', 200);
    // Optional scopes restrict the key to a permission subset; omitted = all.
    let scopes: Permission[] | null = null;
    if (Array.isArray(b.scopes)) {
      scopes = [];
      for (const s of b.scopes) {
        if (typeof s !== 'string' || !(PERMISSIONS as readonly string[]).includes(s)) {
          fail(422, 'Validation failed', [{ field: 'scopes', message: `unknown permission "${String(s)}"` }]);
        }
        scopes.push(s as Permission);
      }
      requireGrantable(res, scopes);
    } else if (![...PERMISSIONS].every((perm) => p.permissions.has(perm))) {
      // "Unscoped" means "everything the creator can do", not "everything there
      // is". A principal holding every permission still mints the historical
      // unscoped key (stored as ''); anyone else gets their own set pinned onto
      // the key, so it can never outrank them.
      scopes = [...p.permissions].sort();
    }
    const minted = await mintApiKey(db, p.orgId, name, p.userId, now(), scopes);
    logEvent('apikey_created', p.orgId, p.userId, req, { prefix: minted.summary.prefix });
    res.status(201).json({ api_key: minted.summary, secret: minted.secret });
    })().catch(next);
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
