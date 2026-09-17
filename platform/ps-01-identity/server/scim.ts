import { randomBytes } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import type Database from 'better-sqlite3';
import { hashPassword, nowIso } from './auth.js';
import { DomainError } from './errors.js';
import { userRoles, type RoleRow, type UserRow } from './identity.js';
import type { Permission } from '../shared/types.js';

/**
 * SCIM 2.0 (RFC 7643 / 7644) — the provisioning half of enterprise SSO.
 *
 * OIDC answers "who is signing in"; it says nothing about the accounts that
 * exist before anybody signs in, and nothing at all about the ones that should
 * stop existing. That second half is what an IT department actually asks for:
 * when somebody leaves the company, their access here ends without anyone
 * remembering to come and switch it off. This module is the endpoint Entra ID
 * and Okta push that lifecycle to.
 *
 * Three decisions worth stating up front:
 *
 * 1. **Authentication is an ordinary PS-01 API key.** SCIM specifies no
 *    credential of its own — an operator mints a key with `user:write` and
 *    pastes it into the IdP. That means the key's scopes and the key's
 *    organization already do tenancy and authorization, and no new
 *    credential path was invented for this.
 * 2. **Nothing is ever hard-deleted.** A SCIM DELETE deactivates. Tearing the
 *    row out would take its audit trail, its role history and the foreign keys
 *    pointing at it along with it — and a directory that de-provisions by
 *    accident (a mis-scoped group, a bad sync) would be unrecoverable.
 * 3. **Deactivation revokes sessions immediately.** Marking a user inactive
 *    bumps `token_version`, so every token they hold dies on the next request.
 *    Without that step de-provisioning would only prevent the NEXT login, and
 *    the person walking out of the building keeps a working session until it
 *    expires — which is the exact thing the customer bought this for.
 */

export const SCIM_BASE = '/scim/v2';

const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCHEMA_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCHEMA_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const SCHEMA_SPC = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';

export const DEFAULT_COUNT = 100;
export const MAX_COUNT = 200;

/** SCIM content type. Clients send it; some of them also insist on receiving it. */
const SCIM_CONTENT_TYPE = 'application/scim+json';

// ── Errors ─────────────────────────────────────────────────────────────

export class ScimError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly scimType?: string,
  ) {
    super(message);
    this.name = 'ScimError';
  }
}

export function scimErrorBody(status: number, detail: string, scimType?: string): Record<string, unknown> {
  const body: Record<string, unknown> = { schemas: [SCHEMA_ERROR], status: String(status), detail };
  if (scimType) body.scimType = scimType;
  return body;
}

// ── Filters ────────────────────────────────────────────────────────────

export interface ScimFilter {
  attribute: string;
  value: string;
}

/**
 * Parse the sliver of the SCIM filter grammar that provisioning actually uses.
 *
 * RFC 7644 defines a whole expression language — `and`, `or`, `not`, `co`,
 * `sw`, grouping, nested attribute paths. Entra ID and Okta send exactly one
 * shape when they sync: `userName eq "someone@example.com"`, to ask whether
 * they need to create or update. Supporting one operator honestly beats
 * half-supporting ten, so anything else is refused with `invalidFilter` rather
 * than silently matching everything — which, for a de-provisioning client, is
 * the difference between "no results" and "disable the whole directory".
 */
export function parseFilter(raw: string, allowed: readonly string[]): ScimFilter {
  const m = /^\s*([A-Za-z][A-Za-z0-9_.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(raw);
  if (!m) {
    throw new ScimError(400, `Only simple 'attribute eq "value"' filters are supported — got: ${raw}`, 'invalidFilter');
  }
  const attribute = m[1]!;
  const canonical = allowed.find((a) => a.toLowerCase() === attribute.toLowerCase());
  if (!canonical) {
    throw new ScimError(
      400,
      `Filtering on "${attribute}" is not supported (try: ${allowed.join(', ')})`,
      'invalidFilter',
    );
  }
  return { attribute: canonical, value: m[2]!.replace(/\\(.)/g, '$1') };
}

/**
 * Read a positive integer query parameter, refusing anything that is not one.
 *
 * `?count=abc` used to be a 500 in three services on this platform. Here it is
 * a 400 that says which parameter was wrong.
 */
export function intParam(raw: unknown, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string') throw new ScimError(400, `${name} must be a single integer`, 'invalidValue');
  if (!/^-?\d+$/.test(raw.trim())) throw new ScimError(400, `${name} must be an integer — got ${raw}`, 'invalidValue');
  const n = Number(raw.trim());
  // count=0 is legal in SCIM (a count-only probe); startIndex is 1-based.
  return Math.min(Math.max(n, min), max);
}

// ── Mapping ────────────────────────────────────────────────────────────

function isoOrNull(value: string | null): string | undefined {
  return value ?? undefined;
}

export function toScimUser(db: Database.Database, row: UserRow, baseUrl: string): Record<string, unknown> {
  const roles = userRoles(db, row.id);
  return {
    schemas: [SCHEMA_USER],
    id: String(row.id),
    externalId: isoOrNull(row.external_id),
    userName: row.email,
    displayName: row.name,
    name: { formatted: row.name },
    emails: [{ value: row.email, primary: true, type: 'work' }],
    active: row.status === 'active',
    groups: roles.map((r) => ({ value: String(r.id), display: r.name, $ref: `${baseUrl}${SCIM_BASE}/Groups/${r.id}` })),
    meta: {
      resourceType: 'User',
      created: row.created_at,
      lastModified: row.created_at,
      location: `${baseUrl}${SCIM_BASE}/Users/${row.id}`,
    },
  };
}

export function toScimGroup(db: Database.Database, row: RoleRow, baseUrl: string, orgId: number): Record<string, unknown> {
  const members = db
    .prepare(
      `SELECT u.id, u.name FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       WHERE ur.role_id = ? AND u.org_id = ?
       ORDER BY u.id`,
    )
    .all(row.id, orgId) as { id: number; name: string }[];
  return {
    schemas: [SCHEMA_GROUP],
    id: String(row.id),
    displayName: row.name,
    members: members.map((m) => ({ value: String(m.id), display: m.name, $ref: `${baseUrl}${SCIM_BASE}/Users/${m.id}` })),
    meta: {
      resourceType: 'Group',
      created: row.created_at,
      lastModified: row.created_at,
      location: `${baseUrl}${SCIM_BASE}/Groups/${row.id}`,
    },
  };
}

// ── PATCH ──────────────────────────────────────────────────────────────

export interface PatchOperation {
  op: 'add' | 'remove' | 'replace';
  path?: string;
  value?: unknown;
}

/** Validate a PatchOp envelope and normalise its operations. */
export function parsePatchOps(body: unknown): PatchOperation[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const schemas = Array.isArray(b.schemas) ? b.schemas.map(String) : [];
  if (!schemas.includes(SCHEMA_PATCH)) {
    throw new ScimError(400, `PATCH body must declare the ${SCHEMA_PATCH} schema`, 'invalidSyntax');
  }
  if (!Array.isArray(b.Operations)) throw new ScimError(400, 'PATCH body has no Operations array', 'invalidSyntax');
  return b.Operations.map((raw): PatchOperation => {
    const o = (raw ?? {}) as Record<string, unknown>;
    // The op verb is case-insensitive in the wild: Entra sends "Replace".
    const op = String(o.op ?? '').toLowerCase();
    if (op !== 'add' && op !== 'remove' && op !== 'replace') {
      throw new ScimError(400, `Unsupported PATCH op: ${String(o.op)}`, 'invalidSyntax');
    }
    const parsed: PatchOperation = { op };
    if (typeof o.path === 'string' && o.path !== '') parsed.path = o.path;
    if ('value' in o) parsed.value = o.value;
    return parsed;
  });
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  // Entra ID sends active as the STRING "False" on a de-provision. Reading
  // that with Boolean() yields true — the user stays enabled, and the only
  // sign anything went wrong is that nothing happened.
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return undefined;
}

/** The user attributes a PATCH may change, flattened out of the op list. */
export interface UserChanges {
  email?: string;
  name?: string;
  active?: boolean;
  externalId?: string;
}

export function changesFromPatch(ops: readonly PatchOperation[]): UserChanges {
  const changes: UserChanges = {};
  const applyMap = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (key === 'active') {
        const b = asBoolean(v);
        if (b !== undefined) changes.active = b;
      } else if (key === 'username' && typeof v === 'string') changes.email = v;
      else if ((key === 'displayname' || key === 'name.formatted') && typeof v === 'string') changes.name = v;
      else if (key === 'externalid' && typeof v === 'string') changes.externalId = v;
      else if (key === 'name' && typeof v === 'object' && v !== null) {
        const formatted = (v as Record<string, unknown>).formatted;
        if (typeof formatted === 'string') changes.name = formatted;
      }
    }
  };

  for (const op of ops) {
    if (op.op === 'remove' && op.path?.toLowerCase() === 'active') {
      changes.active = false;
      continue;
    }
    if (!op.path) {
      // A pathless add/replace carries a partial resource object.
      applyMap(op.value);
      continue;
    }
    applyMap({ [op.path]: op.value });
  }
  return changes;
}

// ── Router ─────────────────────────────────────────────────────────────

export interface ScimPrincipal {
  orgId: number;
  permissions: Set<Permission>;
}

export interface ScimDeps {
  db: Database.Database;
  now: () => number;
  selfBaseUrl: string;
  /** Resolve the caller, or null. Reuses the service's own credential handling. */
  authenticate: (req: Request, res: Response) => Promise<ScimPrincipal | null>;
  /** Containment check: refuse to act on an account that outranks the caller. */
  requireNotAbove: (principal: ScimPrincipal, target: UserRow) => void;
  /** Cap check: refuse to hand out authority the caller does not itself hold. */
  requireGrantable: (principal: ScimPrincipal, granted: readonly Permission[]) => void;
  logEvent: (type: string, orgId: number | null, userId: number | null, req: Request, meta?: Record<string, unknown>) => void;
}

const ok = (res: Response, status: number, body: unknown): void => {
  res.status(status).type(SCIM_CONTENT_TYPE).send(JSON.stringify(body));
};

export function createScimRouter(deps: ScimDeps): Router {
  const { db, now, selfBaseUrl, authenticate, requireNotAbove, requireGrantable, logEvent } = deps;
  const router = express.Router();

  // SCIM clients send application/scim+json; express.json() would ignore it.
  router.use(express.json({ limit: '256kb', type: ['application/json', 'application/scim+json'] }));

  const principalOf = (res: Response): ScimPrincipal => res.locals.scimPrincipal as ScimPrincipal;

  const require = (res: Response, perm: Permission): void => {
    if (!principalOf(res).permissions.has(perm)) {
      throw new ScimError(403, `Missing required permission: ${perm}`);
    }
  };

  router.use((req, res, next) => {
    void (async () => {
      const principal = await authenticate(req, res);
      if (!principal) {
        // A SCIM client reads this body, so it has to be SCIM-shaped even here.
        ok(res, 401, scimErrorBody(401, 'Authentication required'));
        return;
      }
      res.locals.scimPrincipal = principal;
      next();
    })().catch(next);
  });

  // ── Discovery ────────────────────────────────────────────────────────
  router.get('/ServiceProviderConfig', (_req, res) => {
    ok(res, 200, {
      schemas: [SCHEMA_SPC],
      documentationUri: 'https://github.com/Gnadi/0815software/tree/main/platform/ps-01-identity',
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: MAX_COUNT },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'PS-01 API key',
          description: 'Mint a key with POST /api/api-keys and present it as: Authorization: Bearer psk_...',
          primary: true,
        },
      ],
      meta: { resourceType: 'ServiceProviderConfig', location: `${selfBaseUrl}${SCIM_BASE}/ServiceProviderConfig` },
    });
  });

  router.get('/ResourceTypes', (_req, res) => {
    const types = [
      { id: 'User', name: 'User', endpoint: '/Users', schema: SCHEMA_USER },
      { id: 'Group', name: 'Group', endpoint: '/Groups', schema: SCHEMA_GROUP },
    ].map((t) => ({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      ...t,
      meta: { resourceType: 'ResourceType', location: `${selfBaseUrl}${SCIM_BASE}/ResourceTypes/${t.id}` },
    }));
    ok(res, 200, { schemas: [SCHEMA_LIST], totalResults: types.length, itemsPerPage: types.length, startIndex: 1, Resources: types });
  });

  router.get('/Schemas', (_req, res) => {
    const schemas = [
      { id: SCHEMA_USER, name: 'User', description: 'SCIM core User' },
      { id: SCHEMA_GROUP, name: 'Group', description: 'SCIM core Group, mapped to a PS-01 role' },
    ];
    ok(res, 200, { schemas: [SCHEMA_LIST], totalResults: schemas.length, itemsPerPage: schemas.length, startIndex: 1, Resources: schemas });
  });

  // ── Users ────────────────────────────────────────────────────────────

  const USER_FILTER_ATTRS = ['userName', 'externalId', 'emails.value', 'id'] as const;

  const userOr404 = (res: Response, id: string): UserRow => {
    if (!/^\d+$/.test(id)) throw new ScimError(404, `User ${id} not found`);
    const row = db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(Number(id), principalOf(res).orgId) as
      | UserRow
      | undefined;
    // A user in another tenant is NOT FOUND here, never forbidden — the same
    // answer the rest of the service gives, so a SCIM key cannot be used to
    // enumerate which ids exist elsewhere.
    if (!row) throw new ScimError(404, `User ${id} not found`);
    return row;
  };

  router.get('/Users', (req, res) => {
    require(res, 'user:read');
    const orgId = principalOf(res).orgId;
    const startIndex = intParam(req.query.startIndex, 'startIndex', 1, 1, Number.MAX_SAFE_INTEGER);
    const count = intParam(req.query.count, 'count', DEFAULT_COUNT, 0, MAX_COUNT);

    const where: string[] = ['org_id = ?'];
    const args: unknown[] = [orgId];
    if (typeof req.query.filter === 'string' && req.query.filter !== '') {
      const f = parseFilter(req.query.filter, USER_FILTER_ATTRS);
      if (f.attribute === 'externalId') {
        where.push('external_id = ?');
        args.push(f.value);
      } else if (f.attribute === 'id') {
        where.push('id = ?');
        args.push(/^\d+$/.test(f.value) ? Number(f.value) : -1);
      } else {
        // userName and emails.value are both the address, matched the way the
        // rest of the service matches it: lower-cased.
        where.push('email = ?');
        args.push(f.value.trim().toLowerCase());
      }
    }
    const clause = where.join(' AND ');
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${clause}`).get(...args) as { n: number }).n;
    const rows =
      count === 0
        ? []
        : (db
            .prepare(`SELECT * FROM users WHERE ${clause} ORDER BY id LIMIT ? OFFSET ?`)
            .all(...args, count, startIndex - 1) as UserRow[]);

    ok(res, 200, {
      schemas: [SCHEMA_LIST],
      totalResults: total,
      itemsPerPage: rows.length,
      startIndex,
      Resources: rows.map((r) => toScimUser(db, r, selfBaseUrl)),
    });
  });

  router.get('/Users/:id', (req, res) => {
    require(res, 'user:read');
    ok(res, 200, toScimUser(db, userOr404(res, req.params.id as string), selfBaseUrl));
  });

  router.post('/Users', (req, res, next) => {
    void (async () => {
      require(res, 'user:write');
      const orgId = principalOf(res).orgId;
      const b = (req.body ?? {}) as Record<string, unknown>;

      const emails = Array.isArray(b.emails) ? (b.emails as Record<string, unknown>[]) : [];
      const primary = emails.find((e) => e && e.primary === true) ?? emails[0];
      const raw =
        (typeof b.userName === 'string' && b.userName) ||
        (primary && typeof primary.value === 'string' ? primary.value : '');
      const email = raw.trim().toLowerCase();
      if (!email) throw new ScimError(400, 'userName is required', 'invalidValue');

      const nameObj = (b.name ?? {}) as Record<string, unknown>;
      const name =
        (typeof b.displayName === 'string' && b.displayName) ||
        (typeof nameObj.formatted === 'string' && nameObj.formatted) ||
        [nameObj.givenName, nameObj.familyName].filter((s) => typeof s === 'string' && s).join(' ') ||
        email;
      const externalId = typeof b.externalId === 'string' && b.externalId !== '' ? b.externalId : null;
      const active = asBoolean(b.active) ?? true;

      const existing = db.prepare('SELECT * FROM users WHERE org_id = ? AND email = ?').get(orgId, email) as
        | UserRow
        | undefined;
      // SCIM says a conflicting create is 409 with scimType "uniqueness" — the
      // client is expected to follow it with a PATCH rather than treat it as
      // a hard failure, so answering 422 here would break a normal re-sync.
      if (existing) throw new ScimError(409, `A user with userName ${email} already exists`, 'uniqueness');
      if (externalId) {
        const clash = db.prepare('SELECT id FROM users WHERE org_id = ? AND external_id = ?').get(orgId, externalId);
        if (clash) throw new ScimError(409, `A user with externalId ${externalId} already exists`, 'uniqueness');
      }

      // The new account gets the default `member` role, and that role carries
      // permissions — so the same cap the /api/users route applies has to apply
      // here. Without it a key scoped to `user:write` alone could provision an
      // account holding more than the key does, then set its password and use
      // it: exactly the escalation `requireGrantable` exists to close.
      const member = db
        .prepare('SELECT id FROM roles WHERE key = ? AND (org_id IS NULL OR org_id = ?)')
        .get('member', orgId) as { id: number } | undefined;
      if (member) {
        const granted = db
          .prepare('SELECT permission FROM role_permissions WHERE role_id = ?')
          .all(member.id) as { permission: string }[];
        requireGrantable(principalOf(res), granted.map((g) => g.permission as Permission));
      }

      // A directory-provisioned account has no password: it signs in through
      // the IdP. The column is NOT NULL, so it gets a random hash nobody holds
      // the input for — the same thing the OAuth link path does.
      const placeholderHash = await hashPassword(randomBytes(24).toString('hex'));

      const created = db.transaction((): UserRow => {
        const info = db
          .prepare(
            `INSERT INTO users (org_id, email, name, password_hash, status, external_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(orgId, email, name, placeholderHash, active ? 'active' : 'disabled', externalId, nowIso(now()));
        const userId = Number(info.lastInsertRowid);
        if (member) {
          db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)').run(
            userId,
            member.id,
            nowIso(now()),
          );
        }
        return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow;
      })();

      logEvent('scim_user_created', orgId, created.id, req, { external_id: externalId });
      res.setHeader('Location', `${selfBaseUrl}${SCIM_BASE}/Users/${created.id}`);
      ok(res, 201, toScimUser(db, created, selfBaseUrl));
    })().catch(next);
  });

  /**
   * Apply a set of changes to a user.
   *
   * The single place where deactivation happens, so the token-version bump
   * cannot be forgotten on one of the three routes that can deactivate.
   */
  const applyChanges = (req: Request, res: Response, target: UserRow, changes: UserChanges): UserRow => {
    const orgId = principalOf(res).orgId;
    requireNotAbove(principalOf(res), target);

    const sets: string[] = [];
    const args: unknown[] = [];
    if (changes.email !== undefined) {
      const email = changes.email.trim().toLowerCase();
      if (!email) throw new ScimError(400, 'userName cannot be empty', 'invalidValue');
      if (email !== target.email) {
        const clash = db.prepare('SELECT id FROM users WHERE org_id = ? AND email = ?').get(orgId, email) as
          | { id: number }
          | undefined;
        if (clash) throw new ScimError(409, `A user with userName ${email} already exists`, 'uniqueness');
        sets.push('email = ?');
        args.push(email);
      }
    }
    if (changes.name !== undefined && changes.name !== '') {
      sets.push('name = ?');
      args.push(changes.name);
    }
    if (changes.externalId !== undefined && changes.externalId !== target.external_id) {
      const clash = db
        .prepare('SELECT id FROM users WHERE org_id = ? AND external_id = ? AND id != ?')
        .get(orgId, changes.externalId, target.id) as { id: number } | undefined;
      if (clash) throw new ScimError(409, `A user with externalId ${changes.externalId} already exists`, 'uniqueness');
      sets.push('external_id = ?');
      args.push(changes.externalId);
    }

    let deactivated = false;
    if (changes.active !== undefined) {
      const status = changes.active ? 'active' : 'disabled';
      if (status !== target.status) {
        sets.push('status = ?');
        args.push(status);
        if (!changes.active) {
          // The point of the whole feature: an account switched off in the
          // directory loses its LIVE sessions, not just its next login.
          sets.push('token_version = token_version + 1');
          deactivated = true;
        }
      }
    }

    if (sets.length > 0) {
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`).run(...args, target.id, orgId);
    }
    if (deactivated) logEvent('scim_user_deactivated', orgId, target.id, req);
    else if (sets.length > 0) logEvent('scim_user_updated', orgId, target.id, req);

    return db.prepare('SELECT * FROM users WHERE id = ?').get(target.id) as UserRow;
  };

  /**
   * PUT replaces the resource.
   *
   * Strictly, an attribute the client omits should revert to its default. That
   * is honoured for `active` (absent means active — an IdP that means to
   * disable someone always says so) but NOT for the name, because a client
   * that omits `displayName` on an otherwise unrelated update would otherwise
   * blank it. Documented here because it is a deliberate divergence.
   */
  router.put('/Users/:id', (req, res) => {
    require(res, 'user:write');
    const target = userOr404(res, req.params.id as string);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const nameObj = (b.name ?? {}) as Record<string, unknown>;
    const changes: UserChanges = { active: asBoolean(b.active) ?? true };
    if (typeof b.userName === 'string') changes.email = b.userName;
    const name =
      (typeof b.displayName === 'string' && b.displayName) ||
      (typeof nameObj.formatted === 'string' && nameObj.formatted) ||
      '';
    if (name) changes.name = name;
    if (typeof b.externalId === 'string' && b.externalId !== '') changes.externalId = b.externalId;
    ok(res, 200, toScimUser(db, applyChanges(req, res, target, changes), selfBaseUrl));
  });

  router.patch('/Users/:id', (req, res) => {
    require(res, 'user:write');
    const target = userOr404(res, req.params.id as string);
    const changes = changesFromPatch(parsePatchOps(req.body));
    ok(res, 200, toScimUser(db, applyChanges(req, res, target, changes), selfBaseUrl));
  });

  router.delete('/Users/:id', (req, res) => {
    require(res, 'user:write');
    const target = userOr404(res, req.params.id as string);
    applyChanges(req, res, target, { active: false });
    // 204 with no body is what RFC 7644 specifies for a successful delete.
    res.status(204).end();
  });

  // ── Groups (PS-01 roles) ─────────────────────────────────────────────

  const GROUP_FILTER_ATTRS = ['displayName', 'id'] as const;

  const roleOr404 = (res: Response, id: string): RoleRow => {
    if (!/^\d+$/.test(id)) throw new ScimError(404, `Group ${id} not found`);
    const row = db
      .prepare('SELECT * FROM roles WHERE id = ? AND (org_id IS NULL OR org_id = ?)')
      .get(Number(id), principalOf(res).orgId) as RoleRow | undefined;
    if (!row) throw new ScimError(404, `Group ${id} not found`);
    return row;
  };

  router.get('/Groups', (req, res) => {
    require(res, 'role:read');
    const orgId = principalOf(res).orgId;
    const startIndex = intParam(req.query.startIndex, 'startIndex', 1, 1, Number.MAX_SAFE_INTEGER);
    const count = intParam(req.query.count, 'count', DEFAULT_COUNT, 0, MAX_COUNT);

    const where: string[] = ['(org_id IS NULL OR org_id = ?)'];
    const args: unknown[] = [orgId];
    if (typeof req.query.filter === 'string' && req.query.filter !== '') {
      const f = parseFilter(req.query.filter, GROUP_FILTER_ATTRS);
      if (f.attribute === 'id') {
        where.push('id = ?');
        args.push(/^\d+$/.test(f.value) ? Number(f.value) : -1);
      } else {
        where.push('name = ?');
        args.push(f.value);
      }
    }
    const clause = where.join(' AND ');
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM roles WHERE ${clause}`).get(...args) as { n: number }).n;
    const rows =
      count === 0
        ? []
        : (db
            .prepare(`SELECT * FROM roles WHERE ${clause} ORDER BY id LIMIT ? OFFSET ?`)
            .all(...args, count, startIndex - 1) as RoleRow[]);

    ok(res, 200, {
      schemas: [SCHEMA_LIST],
      totalResults: total,
      itemsPerPage: rows.length,
      startIndex,
      Resources: rows.map((r) => toScimGroup(db, r, selfBaseUrl, orgId)),
    });
  });

  router.get('/Groups/:id', (req, res) => {
    require(res, 'role:read');
    const orgId = principalOf(res).orgId;
    ok(res, 200, toScimGroup(db, roleOr404(res, req.params.id as string), selfBaseUrl, orgId));
  });

  /**
   * Group membership, which is how an IdP grants and removes a role.
   *
   * Only `members` is writable. Creating and deleting roles through SCIM is
   * deliberately absent: a role here carries PERMISSIONS, and letting a
   * directory sync invent one would let whoever administers the IdP mint
   * authority inside this service. Membership in a role an operator already
   * defined is the whole of what provisioning needs.
   */
  router.patch('/Groups/:id', (req, res) => {
    require(res, 'role:write');
    const orgId = principalOf(res).orgId;
    const role = roleOr404(res, req.params.id as string);
    const ops = parsePatchOps(req.body);

    const memberIds = (value: unknown): number[] => {
      // A pathless operation carries a partial resource — `{members: [...]}` —
      // rather than the member list itself. Reading only the outer object here
      // used to resolve to nothing and report success, so the IdP believed it
      // had granted a role that was never granted.
      const unwrapped =
        !Array.isArray(value) && value && typeof value === 'object' && 'members' in (value as Record<string, unknown>)
          ? (value as Record<string, unknown>).members
          : value;
      const list = Array.isArray(unwrapped) ? unwrapped : [unwrapped];
      return list
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          if (entry && typeof entry === 'object') return String((entry as Record<string, unknown>).value ?? '');
          return '';
        })
        .filter((v) => /^\d+$/.test(v))
        .map(Number);
    };

    let touched = 0;
    for (const op of ops) {
      const path = op.path?.toLowerCase() ?? '';
      // `members[value eq "7"]` is how a removal of one member arrives.
      const bracket = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/.exec(op.path ?? '');
      const ids = bracket ? memberIds(bracket[1]!) : path === 'members' || path === '' ? memberIds(op.value) : [];
      if (!bracket && path !== 'members' && path !== '') {
        throw new ScimError(400, `Only the "members" attribute is writable on a Group — got "${op.path}"`, 'invalidPath');
      }
      if (ids.length === 0) {
        throw new ScimError(400, 'No usable member ids in this operation', 'invalidValue');
      }
      for (const userId of ids) {
        // Scoped to the tenant: a member id from another org simply is not one.
        const user = db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(userId, orgId) as
          | UserRow
          | undefined;
        if (!user) throw new ScimError(400, `Member ${userId} is not a user in this organization`, 'invalidValue');
        if (op.op === 'remove') {
          db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?').run(userId, role.id);
        } else {
          // Granting a role hands out its permissions, so the caller must not
          // be able to grant what it does not itself hold.
          const granted = db
            .prepare('SELECT permission FROM role_permissions WHERE role_id = ?')
            .all(role.id) as { permission: string }[];
          const held = principalOf(res).permissions;
          const excess = granted.map((g) => g.permission).filter((p) => !held.has(p as Permission));
          if (excess.length > 0) {
            throw new ScimError(403, `Cannot grant a permission you do not hold: ${[...new Set(excess)].sort().join(', ')}`);
          }
          db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)').run(
            userId,
            role.id,
            nowIso(now()),
          );
        }
        touched++;
      }
    }
    if (touched > 0) logEvent('scim_group_membership_changed', orgId, null, req, { role_id: role.id, changes: touched });
    ok(res, 200, toScimGroup(db, role, selfBaseUrl, orgId));
  });

  // ── Errors ───────────────────────────────────────────────────────────
  router.use((err: unknown, _req: Request, res: Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof ScimError) {
      ok(res, err.status, scimErrorBody(err.status, err.message, err.scimType));
      return;
    }
    // The shared guards throw DomainError; translate rather than duplicate them.
    if (err instanceof DomainError) {
      ok(res, err.status, scimErrorBody(err.status, err.message));
      return;
    }
    if (err instanceof SyntaxError) {
      ok(res, 400, scimErrorBody(400, 'Request body is not valid JSON', 'invalidSyntax'));
      return;
    }
    next(err);
  });

  return router;
}
