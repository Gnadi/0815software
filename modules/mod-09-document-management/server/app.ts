import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import type Database from 'better-sqlite3';
import { isGlobalRole, isMatterRole, type DocumentDetail, type GlobalRole, type UserProfile } from '../shared/types.js';
import {
  clearedCookie,
  COOKIE_NAME,
  createToken,
  dummyPasswordHash,
  hashPassword,
  parseCookies,
  sessionCookie,
  verifyPassword,
  verifyToken,
  type SessionConfig,
} from './auth.js';
import { noopPlatform, type PlatformHooks } from './platform.js';
import {
  addMember,
  addTag,
  addVersion,
  createDocument,
  createMatter,
  createUser,
  documentDetail,
  DomainError,
  getMatter,
  listDocuments,
  listMatters,
  listMembers,
  listTags,
  listUsers,
  removeMember,
  removeTag,
  resolveVersion,
  searchDocuments,
  softDeleteDocument,
  type AuthUser,
  type BaseDetail,
  type UploadInput,
} from './docs.js';
import { blobPath, writeBlob } from './storage.js';
import { INLINE_TYPES, type FileFormat } from './extract.js';
import { refreshText, reindexDocument, storeVersionText } from './search.js';
import { readSettings, writeSettings } from './settings.js';
import {
  canShare,
  createShare,
  documentShares,
  mayFetch,
  publicView,
  recordShareEvent,
  resolveShare,
  revokeShare,
  unlockShare,
  type ResolvedShare,
} from './shares.js';
import {
  createClass,
  deleteClass,
  disposeDocument,
  documentEvents,
  listClasses,
  listDisposals,
  listDue,
  releaseLegalHold,
  RETENTION_PRESETS,
  retentionInfo,
  setDocumentRetention,
  setLegalHold,
  setMatterRetention,
  updateClass,
} from './retention.js';
import { parseSummaryContext } from '../shared/summary.js';
import { moduleSummary } from './summary.js';

interface UserRow {
  id: number;
  username: string;
  name: string;
  role: GlobalRole;
  password_hash: string;
  token_version: number;
  created_at: string;
}

const MIN_PASSWORD_LENGTH = 8;

function profileOf(user: UserRow): UserProfile {
  const { id, username, name, role, created_at } = user;
  return { id, username, name, role, created_at };
}

function authUser(user: UserRow): AuthUser {
  const { id, username, name, role } = user;
  return { id, username, name, role };
}

/** Parse a positive-integer path param; anything else is "not found". */
function idParam(raw: unknown): number | null {
  return typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export interface AppOptions {
  /** Optional transport hardening; omit it (as the tests do) to run unthrottled. */
  hardening?: HardeningConfig;
  db: Database.Database;
  session: SessionConfig;
  storageDir: string;
  maxUploadBytes: number;
  /** Absolute path to the built client (dist/client). Omit to serve API only. */
  staticDir?: string;
  /** Optional Platform Services integration; defaults to a no-op (standalone). */
  platform?: PlatformHooks;
  /**
   * The platform machine token (PLATFORM_SERVICE_TOKEN). When set, it is the
   * only credential that opens GET /api/summary — the shell's read of this
   * module. Unset means the endpoint is closed, which is the standalone
   * default. There is no handoff route here: this module's users are not
   * staff, so it is not embeddable.
   */
  serviceToken?: string;
  /** The clock retention and share links are measured against (tests inject one). */
  now?: () => number;
}

export function createApp({
  db,
  hardening,
  session,
  storageDir,
  maxUploadBytes,
  staticDir,
  platform = noopPlatform,
  serviceToken,
  now = Date.now,
}: AppOptions): express.Express {
  // Compute the equal-work dummy hash now, at startup and off the event loop,
  // so no request ever pays for generating it. Otherwise the first login
  // against an unknown account would be measurably slower than every later
  // one — a timing difference this hash exists to remove.
  void dummyPasswordHash();

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
  app.use(express.json({ limit: '256kb' }));

  // Raw body parser used only by upload routes. Bytes come in as the
  // request body; metadata (title, filename, tags) rides on the query
  // string and Content-Type header. Exceeding the limit yields 413.
  const rawUpload: RequestHandler = express.raw({ type: () => true, limit: maxUploadBytes });

  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const userByUsername = db.prepare('SELECT * FROM users WHERE username = ?');

  const issueSession = (res: Response, user: UserRow): void => {
    const token = createToken(session, { userId: user.id, tokenVersion: user.token_version });
    res.setHeader('Set-Cookie', sessionCookie(session, token));
  };

  const me = (res: Response): UserRow => res.locals.user as UserRow;
  const actor = (res: Response): AuthUser => authUser(me(res));

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

  app.post('/api/login', (req, res, next) => {
    void (async () => {
      const { username, password } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof username !== 'string' || typeof password !== 'string') {
        res.status(422).json({ error: 'Username and password are required' });
        return;
      }
      const user = userByUsername.get(username.trim().toLowerCase()) as UserRow | undefined;
      // Verify against a dummy hash on unknown usernames so timing does not
      // reveal whether an account exists. The await keeps that work off the
      // event loop — see server/auth.ts.
      const ok = await verifyPassword(password, user ? user.password_hash : await dummyPasswordHash());
      if (!user || !ok) {
        res.status(401).json({ error: 'Invalid username or password' });
        return;
      }
      issueSession(res, user);
      res.json({ user: profileOf(user) });
    })().catch(next);
  });

  // ── Machine-to-machine ───────────────────────────────────────────────
  // The shell summary, authenticated with the platform machine token and NOT a
  // user session: the caller is another service in the same stack. With no
  // token configured the endpoint is closed, which is the standalone default.
  //
  // Mounted ABOVE the session gate below, because the caller has no session —
  // that is the whole point of the machine token.
  //
  // There is no handoff here. This module's users are not staff, so a staff
  // shell has no principal to sign in as, and it is not embeddable
  // (docs/PLATFORM-READINESS.md, item C1).
  //
  // The constant-time compare is local rather than imported from `handoff.ts`:
  // that file does not exist here, because this module cannot do a handoff at
  // all — its sessions carry a shape a shell has no principal for.
  const tokenMatches = (provided: string): boolean => {
    const a = Buffer.from(provided);
    const b = Buffer.from(serviceToken ?? '');
    return a.length === b.length && timingSafeEqual(a, b);
  };

  app.get('/api/summary', (req, res, next) => {
  // Only ours when a machine token is actually presented.
    //
    // MOD-11 already serves a session-guarded /api/summary of its own, and this
    // route is mounted above the session gate, so without the fallthrough it
    // would shadow that endpoint and answer 401 to the module's own frontend.
    // Rather than give one module a different path from the other fourteen —
    // the contract is worth more than the collision is expensive — this route
    // claims only the requests that are unambiguously the shell's.
    if (req.headers['x-service-token'] === undefined) {
      next();
      return;
    }
        const provided = req.headers['x-service-token'];
    if (!serviceToken || typeof provided !== 'string' || !tokenMatches(provided)) {
      res.status(401).json({ error: 'Service token required' });
      return;
    }
    res.json(moduleSummary(db, parseSummaryContext(req.query as Record<string, unknown>)));
  });

  // ── Share links: the public side ────────────────────────────────────────
  // No session — the token is the credential, and it opens one document.
  // Every failure is the same 404 (shares.ts), so a guessed token learns
  // nothing; a password-protected link needs the grant /unlock returns.
  const shared = (req: Request): ResolvedShare => {
    const share = resolveShare(db, req.params.token, now());
    if (!share) throw new DomainError(404, 'Link not found');
    return share;
  };
  const grantOk = (req: Request, share: ResolvedShare): void => {
    if (!mayFetch(share, req.query.grant ?? req.headers['x-share-grant'], session.secret, now())) {
      throw new DomainError(401, 'This link needs its password');
    }
  };

  app.get('/api/shared/:token', (req, res) => {
    const share = shared(req);
    recordShareEvent(db, share.linkId, 'opened', now());
    res.setHeader('Cache-Control', 'no-store');
    res.json(publicView(share));
  });

  app.post('/api/shared/:token/unlock', (req, res, next) => {
    void (async () => {
      const share = shared(req);
      const grant = await unlockShare(db, share, ((req.body ?? {}) as Record<string, unknown>).password, session.secret, now());
      res.json({ grant });
    })().catch(next);
  });

  app.get('/api/shared/:token/download', (req, res) => {
    const share = shared(req);
    grantOk(req, share);
    const path = blobPath(storageDir, share.version.storage_path);
    if (!existsSync(path)) throw new DomainError(404, 'Link not found');
    recordShareEvent(db, share.linkId, 'downloaded', now());
    res.setHeader('Content-Type', share.version.content_type);
    res.setHeader('X-Content-SHA256', share.version.sha256);
    res.setHeader('Cache-Control', 'no-store');
    res.download(path, share.version.filename);
  });

  app.get('/api/shared/:token/preview', (req, res) => {
    const share = shared(req);
    grantOk(req, share);
    recordShareEvent(db, share.linkId, 'previewed', now());
    sendInline(res, storageDir, share.version);
  });

  app.get('/api/shared/:token/text', (req, res) => {
    const share = shared(req);
    grantOk(req, share);
    recordShareEvent(db, share.linkId, 'previewed', now());
    res.setHeader('Cache-Control', 'no-store');
    res.json(versionText(db, storageDir, share.documentId, share.version.version_no));
  });

  // ── Everything below requires a valid session ─────────────────────────
  app.use('/api', (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const claims = token ? verifyToken(session, token) : null;
    if (claims) {
      const user = userById.get(claims.userId) as UserRow | undefined;
      if (user && user.token_version === claims.tokenVersion) {
        res.locals.user = user;
        next();
        return;
      }
    }
    res.status(401).json({ error: 'Authentication required' });
  });

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  const requireAdmin = (res: Response): void => {
    if (me(res).role !== 'admin') throw new DomainError(403, 'Admin role required');
  };

  /** A document's detail with its retention, history and links. */
  const detailOf = (user: AuthUser, id: number, base: BaseDetail = documentDetail(db, user, id)): DocumentDetail => ({
    ...base,
    retention: retentionInfo(db, id, now()),
    events: documentEvents(db, id),
    shares: documentShares(db, user, id, base.matter_role, now()),
    share_policy: readSettings(db).share_links,
    can_share: canShare(db, base.matter_role),
  });

  /** Read a freshly uploaded version's text, index it and tell the platform. */
  const afterUpload = (req: Request, user: AuthUser, base: BaseDetail): DocumentDetail => {
    const version = base.versions[base.versions.length - 1]!;
    const bytes = req.body as Buffer;
    const text = storeVersionText(db, version.id, bytes, version.content_type, version.filename);
    reindexDocument(db, base.document.id);
    void platform.documentUploaded({
      actor: `user:${user.id}`,
      docId: base.document.id,
      matterId: base.document.matter_id,
      version: version.version_no,
      bytes,
      contentType: version.content_type,
      title: base.document.title,
      text: text.text,
    });
    return detailOf(user, base.document.id);
  };

  // ── Account ───────────────────────────────────────────────────────────
  app.get('/api/me', (_req, res) => {
    res.json({ user: profileOf(me(res)) });
  });

  app.post('/api/me/password', (req, res, next) => {
    void (async () => {
    const { currentPassword, newPassword } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      res.status(422).json({ error: 'Current and new password are required' });
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      res.status(422).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }
    const user = me(res);
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
    const nextVersion = user.token_version + 1;
    db.prepare('UPDATE users SET password_hash = ?, token_version = ? WHERE id = ?').run(
      await hashPassword(newPassword),
      nextVersion,
      user.id,
    );
    issueSession(res, { ...user, token_version: nextVersion });
    res.json({ ok: true });
    })().catch(next);
  });

  // ── Users (directory for all; management for admins) ──────────────────
  app.get('/api/users', (_req, res) => {
    res.json({ users: listUsers(db) });
  });

  app.post('/api/users', (req, res, next) => {
    void (async () => {
    requireAdmin(res);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const username = str(b.username)?.toLowerCase();
    const name = str(b.name);
    const password = typeof b.password === 'string' ? b.password : '';
    const role = str(b.role) ?? 'member';
    if (!username || !name) throw new DomainError(422, 'username and name are required');
    if (!isGlobalRole(role)) throw new DomainError(422, 'role must be "admin" or "member"');
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new DomainError(422, `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const id = createUser(db, { username, name, role, passwordHash: await hashPassword(password) });
    res.status(201).json({ user: db.prepare('SELECT id, username, name, role, created_at FROM users WHERE id = ?').get(id) });
    })().catch(next);
  });

  // ── Matters ───────────────────────────────────────────────────────────
  app.get('/api/matters', (_req, res) => {
    res.json({ matters: listMatters(db, actor(res)) });
  });

  app.post('/api/matters', (req, res) => {
    requireAdmin(res);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const key = str(b.key)?.toUpperCase();
    const name = str(b.name);
    const description = str(b.description) ?? '';
    if (!key || !name) throw new DomainError(422, 'key and name are required');
    if (!/^[A-Z0-9][A-Z0-9-]{1,23}$/.test(key)) {
      throw new DomainError(422, 'key must be 2–24 chars: letters, digits, dashes');
    }
    res.status(201).json({ matter: createMatter(db, actor(res), { key, name, description }) });
  });

  app.get('/api/matters/:id', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Matter not found');
    res.json({ matter: getMatter(db, actor(res), id) });
  });

  // ── Matter members ────────────────────────────────────────────────────
  app.get('/api/matters/:id/members', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Matter not found');
    res.json({ members: listMembers(db, actor(res), id) });
  });

  app.post('/api/matters/:id/members', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Matter not found');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const userId = idParam(String(b.user_id ?? ''));
    const role = str(b.role) ?? '';
    if (userId === null) throw new DomainError(422, 'user_id is required');
    if (!isMatterRole(role)) throw new DomainError(422, 'role must be viewer, editor or owner');
    addMember(db, actor(res), id, userId, role);
    res.status(201).json({ members: listMembers(db, actor(res), id) });
  });

  app.delete('/api/matters/:id/members/:userId', (req, res) => {
    const id = idParam(req.params.id);
    const userId = idParam(req.params.userId);
    if (id === null || userId === null) throw new DomainError(404, 'Matter not found');
    removeMember(db, actor(res), id, userId);
    res.json({ members: listMembers(db, actor(res), id) });
  });

  // ── Documents ─────────────────────────────────────────────────────────
  app.get('/api/documents', (req, res) => {
    const matterId = str(req.query.matter) ? idParam(String(req.query.matter)) ?? undefined : undefined;
    res.json({
      documents: listDocuments(db, actor(res), {
        matterId,
        tag: str(req.query.tag),
        search: str(req.query.search),
      }),
    });
  });

  app.get('/api/tags', (_req, res) => {
    res.json({ tags: listTags(db, actor(res)) });
  });

  app.get('/api/documents/:id', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Document not found');
    res.json(detailOf(actor(res), id));
  });

  // Upload a new document (with version 1) into a matter.
  app.post('/api/matters/:id/documents', rawUpload, (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Matter not found');
    const input = uploadFrom(req, storageDir);
    const user = actor(res);
    res.status(201).json(afterUpload(req, user, createDocument(db, user, id, input)));
  });

  // Append a new version to an existing document.
  app.post('/api/documents/:id/versions', rawUpload, (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Document not found');
    const input = uploadFrom(req, storageDir);
    const user = actor(res);
    res.status(201).json(afterUpload(req, user, addVersion(db, user, id, input)));
  });

  // Full-text search over titles, text and tags — this module's own index,
  // behind the matter check (docs.ts); PS-09 is never asked.
  app.get('/api/search', (req, res) => {
    const matterId = str(req.query.matter) ? idParam(String(req.query.matter)) ?? undefined : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
    res.json({ hits: searchDocuments(db, actor(res), q, { matterId, tag: str(req.query.tag) }) });
  });

  // ── Preview ─────────────────────────────────────────────────────────────
  const versionParam = (req: Request): number | undefined => {
    if (!str(req.query.version)) return undefined;
    const n = idParam(String(req.query.version));
    if (n === null) throw new DomainError(404, 'Version not found');
    return n;
  };

  // The bytes inline, for the formats a browser shows safely (PDF, images).
  app.get('/api/documents/:id/preview', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Document not found');
    const version = resolveVersion(db, actor(res), id, versionParam(req));
    sendInline(res, storageDir, { ...version, format: versionText(db, storageDir, id, version.version_no).format });
  });

  // The text read out of a version — the preview for everything else.
  app.get('/api/documents/:id/text', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Document not found');
    const version = resolveVersion(db, actor(res), id, versionParam(req));
    res.json(versionText(db, storageDir, id, version.version_no));
  });

  // ── Share links ───────────────────────────────────────────────────────
  app.post('/api/documents/:id/shares', (req, res, next) => {
    void (async () => {
      const id = idParam(req.params.id);
      if (id === null) throw new DomainError(404, 'Document not found');
      const user = actor(res);
      const { link, token } = await createShare(db, user, id, (req.body ?? {}) as Record<string, unknown>, now());
      void platform.audit({ actor: `user:${user.id}`, action: 'share.created', resource: `document:${id}`, metadata: { link: link.id, expires_at: link.expires_at, version: link.version_no } });
      // The token is in this response and nowhere else: only its hash is kept.
      res.status(201).json({ link, token, path: `/s/${token}` });
    })().catch(next);
  });

  app.delete('/api/shares/:id', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Link not found');
    const user = actor(res);
    const link = revokeShare(db, user, id, now());
    void platform.audit({ actor: `user:${user.id}`, action: 'share.revoked', resource: `share:${id}` });
    res.json({ link });
  });

  // ── Retention ─────────────────────────────────────────────────────────
  app.get('/api/retention-classes', (_req, res) => {
    res.json({ classes: listClasses(db), presets: RETENTION_PRESETS });
  });

  app.post('/api/retention-classes', (req, res) => {
    requireAdmin(res);
    res.status(201).json({ class: createClass(db, actor(res), (req.body ?? {}) as Record<string, unknown>) });
  });

  app.put('/api/retention-classes/:id', (req, res) => {
    requireAdmin(res);
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Retention class not found');
    res.json({ class: updateClass(db, actor(res), id, (req.body ?? {}) as Record<string, unknown>) });
  });

  app.delete('/api/retention-classes/:id', (req, res) => {
    requireAdmin(res);
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Retention class not found');
    deleteClass(db, id);
    res.json({ ok: true });
  });

  app.put('/api/documents/:id/retention', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Document not found');
    res.json({ retention: setDocumentRetention(db, actor(res), id, (req.body ?? {}) as Record<string, unknown>, now()) });
  });

  app.post('/api/documents/:id/legal-hold', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Document not found');
    const user = actor(res);
    const retention = setLegalHold(db, user, id, ((req.body ?? {}) as Record<string, unknown>).reason, now());
    void platform.audit({ actor: `user:${user.id}`, action: 'document.hold_set', resource: `document:${id}` });
    res.json({ retention });
  });

  app.delete('/api/documents/:id/legal-hold', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Document not found');
    const user = actor(res);
    const retention = releaseLegalHold(db, user, id, now());
    void platform.audit({ actor: `user:${user.id}`, action: 'document.hold_released', resource: `document:${id}` });
    res.json({ retention });
  });

  app.put('/api/matters/:id/retention', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Matter not found');
    setMatterRetention(db, actor(res), id, ((req.body ?? {}) as Record<string, unknown>).retention_class_id);
    res.json({ matter: getMatter(db, actor(res), id) });
  });

  app.get('/api/retention/due', (_req, res) => {
    requireAdmin(res);
    res.json({ documents: listDue(db, now()) });
  });

  app.get('/api/disposals', (_req, res) => {
    requireAdmin(res);
    res.json({ disposals: listDisposals(db) });
  });

  // Destroy a document past its period. By hand, by an administrator, with
  // an explicit confirmation — there is no automatic disposal.
  app.post('/api/documents/:id/dispose', (req, res, next) => {
    void (async () => {
      requireAdmin(res);
      const id = idParam(req.params.id);
      if (id === null) throw new DomainError(404, 'Document not found');
      if (((req.body ?? {}) as Record<string, unknown>).confirm !== true) {
        throw new DomainError(422, 'Validation failed', [{ field: 'confirm', message: 'disposal destroys every version for good — confirm it' }]);
      }
      res.json({ disposal: await disposeDocument(db, storageDir, platform, actor(res), id, now()) });
    })().catch(next);
  });

  // ── Settings and maintenance (administrators) ─────────────────────────
  app.get('/api/settings', (_req, res) => {
    res.json(readSettings(db));
  });

  app.put('/api/settings', (req, res) => {
    requireAdmin(res);
    res.json(writeSettings(db, actor(res), (req.body ?? {}) as Record<string, unknown>));
  });

  // Read every version again — after the readers improved, or to repair.
  app.post('/api/admin/reindex', (_req, res) => {
    requireAdmin(res);
    res.json(refreshText(db, storageDir, { all: true }));
  });

  // Download the current version, or ?version=N for a specific one.
  app.get('/api/documents/:id/download', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Document not found');
    const versionNo = str(req.query.version) ? idParam(String(req.query.version)) ?? -1 : undefined;
    if (versionNo === -1) throw new DomainError(404, 'Version not found');
    sendVersion(db, res, storageDir, id, versionNo);
  });

  app.get('/api/documents/:id/versions/:n/download', (req, res) => {
    const id = idParam(req.params.id);
    const n = idParam(req.params.n);
    if (id === null || n === null) throw new DomainError(404, 'Version not found');
    sendVersion(db, res, storageDir, id, n);
  });

  // ── Tags ──────────────────────────────────────────────────────────────
  app.post('/api/documents/:id/tags', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Document not found');
    const tag = normalizeTag((req.body ?? {}) as Record<string, unknown>);
    const document = addTag(db, actor(res), id, tag);
    reindexDocument(db, id);
    res.status(201).json({ document });
  });

  app.delete('/api/documents/:id/tags/:tag', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Document not found');
    const tag = req.params.tag.trim().toLowerCase();
    const document = removeTag(db, actor(res), id, tag);
    reindexDocument(db, id);
    res.json({ document });
  });

  // ── Soft delete ─────────────────────────────────────────────────────
  app.delete('/api/documents/:id', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Document not found');
    softDeleteDocument(db, actor(res), id);
    // Out of PS-09 too; the PS-06 copy stays with the local one until disposal.
    void platform.documentRemoved(id);
    res.json({ ok: true });
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

  // ── Error mapping ────────────────────────────────────────────────────
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof DomainError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    // body-parser signals an over-limit upload with a 413 status.
    if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.too.large') {
      res.status(413).json({ error: 'Upload exceeds the maximum allowed size' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

// ── Upload / download helpers ────────────────────────────────────────────

function normalizeTag(body: Record<string, unknown>): string {
  const tag = typeof body.tag === 'string' ? body.tag.trim().toLowerCase() : '';
  if (tag === '' || tag.length > 40 || !/^[a-z0-9][a-z0-9 _-]*$/.test(tag)) {
    throw new DomainError(422, 'tag must be 1–40 chars: letters, digits, spaces, dashes, underscores');
  }
  return tag;
}

/** Build an UploadInput from a raw request, writing bytes to the store. */
function uploadFrom(req: Request, storageDir: string): UploadInput {
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (bytes.length === 0) throw new DomainError(422, 'Upload body is empty');
  const title = str(req.query.title);
  const filename = str(req.query.filename);
  if (!title) throw new DomainError(422, 'title query parameter is required');
  if (!filename) throw new DomainError(422, 'filename query parameter is required');
  const contentType = str(req.headers['content-type']) ?? 'application/octet-stream';
  const stored = writeBlob(storageDir, bytes);
  return {
    title,
    filename,
    contentType,
    sha256: stored.sha256,
    size: stored.size,
    storagePath: stored.storagePath,
  };
}

/**
 * Serve a version's bytes for viewing in the page — only for the formats in
 * INLINE_TYPES, decided from the bytes (extract.ts), and with the type from
 * that list rather than the one the uploader sent. Anything else is a 415:
 * an HTML or SVG file served inline would run its scripts with this
 * module's cookies. Images are additionally sandboxed; PDFs cannot be, as
 * browsers refuse to show a sandboxed PDF.
 */
function sendInline(
  res: Response,
  storageDir: string,
  v: { storage_path: string; filename: string; sha256: string; version_no: number; format: string | null },
): void {
  const type = v.format ? INLINE_TYPES[v.format as FileFormat] : undefined;
  if (!type) throw new DomainError(415, 'No inline preview for this file — download it instead');
  const path = blobPath(storageDir, v.storage_path);
  if (!existsSync(path)) throw new DomainError(404, 'Stored file missing — re-run the seed script');
  // Framed by this module's own pages only (the hardening default is DENY).
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    type === 'application/pdf' ? "frame-ancestors 'self'" : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'",
  );
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(v.filename)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Version-No', String(v.version_no));
  res.setHeader('X-Content-SHA256', v.sha256);
  res.sendFile(path);
}

const PREVIEW_TEXT_CHARS = 200_000;

/** A version's text (read now if it never was), capped for the page. */
function versionText(db: Database.Database, storageDir: string, documentId: number, versionNo: number) {
  const row = () =>
    db
      .prepare(
        `SELECT v.id, v.storage_path, v.content_type, v.filename, t.status, t.format, t.preview, t.text
         FROM document_versions v LEFT JOIN version_text t ON t.version_id = v.id
         WHERE v.document_id = ? AND v.version_no = ?`,
      )
      .get(documentId, versionNo) as
      | { id: number; storage_path: string; content_type: string; filename: string; status: string | null; format: string | null; preview: string | null; text: string | null }
      | undefined;
  let r = row();
  if (!r) throw new DomainError(404, 'Version not found');
  if (r.status === null) {
    const path = blobPath(storageDir, r.storage_path);
    if (!existsSync(path)) throw new DomainError(404, 'Stored file missing — re-run the seed script');
    storeVersionText(db, r.id, readFileSync(path), r.content_type, r.filename);
    r = row()!;
  }
  const text = r.text ?? '';
  return { version_no: versionNo, status: r.status, format: r.format, preview: r.preview, text: text.slice(0, PREVIEW_TEXT_CHARS), truncated: text.length > PREVIEW_TEXT_CHARS };
}

function sendVersion(
  db: Database.Database,
  res: Response,
  storageDir: string,
  documentId: number,
  versionNo: number | undefined,
): void {
  const user = res.locals.user as UserRow;
  const version = resolveVersion(db, authUser(user), documentId, versionNo);
  const path = blobPath(storageDir, version.storage_path);
  if (!existsSync(path)) {
    throw new DomainError(404, 'Stored file missing — re-run the seed script');
  }
  res.setHeader('Content-Type', version.content_type);
  res.setHeader('X-Version-No', String(version.version_no));
  res.setHeader('X-Content-SHA256', version.sha256);
  res.download(path, version.filename);
}
