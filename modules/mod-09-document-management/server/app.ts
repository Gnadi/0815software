import { existsSync } from 'node:fs';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type Database from 'better-sqlite3';
import { isGlobalRole, isMatterRole, type GlobalRole, type UserProfile } from '../shared/types.js';
import {
  clearedCookie,
  COOKIE_NAME,
  createToken,
  DUMMY_PASSWORD_HASH,
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
  softDeleteDocument,
  type AuthUser,
  type UploadInput,
} from './docs.js';
import { blobPath, writeBlob } from './storage.js';

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
  db: Database.Database;
  session: SessionConfig;
  storageDir: string;
  maxUploadBytes: number;
  /** Absolute path to the built client (dist/client). Omit to serve API only. */
  staticDir?: string;
  /** Optional Platform Services integration; defaults to a no-op (standalone). */
  platform?: PlatformHooks;
}

export function createApp({
  db,
  session,
  storageDir,
  maxUploadBytes,
  staticDir,
  platform = noopPlatform,
}: AppOptions): express.Express {
  const app = express();
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

  app.post('/api/login', (req, res) => {
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(422).json({ error: 'Username and password are required' });
      return;
    }
    const user = userByUsername.get(username.trim().toLowerCase()) as UserRow | undefined;
    // Verify against a dummy hash on unknown usernames so timing does not
    // reveal whether an account exists.
    const ok = user
      ? verifyPassword(password, user.password_hash)
      : verifyPassword(password, DUMMY_PASSWORD_HASH);
    if (!user || !ok) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }
    issueSession(res, user);
    res.json({ user: profileOf(user) });
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

  // ── Account ───────────────────────────────────────────────────────────
  app.get('/api/me', (_req, res) => {
    res.json({ user: profileOf(me(res)) });
  });

  app.post('/api/me/password', (req, res) => {
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
    if (!verifyPassword(currentPassword, user.password_hash)) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
    const nextVersion = user.token_version + 1;
    db.prepare('UPDATE users SET password_hash = ?, token_version = ? WHERE id = ?').run(
      hashPassword(newPassword),
      nextVersion,
      user.id,
    );
    issueSession(res, { ...user, token_version: nextVersion });
    res.json({ ok: true });
  });

  // ── Users (directory for all; management for admins) ──────────────────
  app.get('/api/users', (_req, res) => {
    res.json({ users: listUsers(db) });
  });

  app.post('/api/users', (req, res) => {
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
    const id = createUser(db, { username, name, role, passwordHash: hashPassword(password) });
    res.status(201).json({ user: db.prepare('SELECT id, username, name, role, created_at FROM users WHERE id = ?').get(id) });
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
    res.json(documentDetail(db, actor(res), id));
  });

  // Upload a new document (with version 1) into a matter.
  app.post('/api/matters/:id/documents', rawUpload, (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Matter not found');
    const input = uploadFrom(req, storageDir);
    const user = actor(res);
    const doc = createDocument(db, user, id, input);
    void platform.documentUploaded({ actor: `user:${user.id}`, docId: doc.document.id, version: doc.document.current_version, bytes: req.body as Buffer, contentType: str(req.headers['content-type']) ? String(req.headers['content-type']) : 'application/octet-stream', title: doc.document.title });
    res.status(201).json(doc);
  });

  // Append a new version to an existing document.
  app.post('/api/documents/:id/versions', rawUpload, (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Document not found');
    const input = uploadFrom(req, storageDir);
    const user = actor(res);
    const doc = addVersion(db, user, id, input);
    void platform.documentUploaded({ actor: `user:${user.id}`, docId: doc.document.id, version: doc.document.current_version, bytes: req.body as Buffer, contentType: str(req.headers['content-type']) ? String(req.headers['content-type']) : 'application/octet-stream', title: doc.document.title });
    res.status(201).json(doc);
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
    res.status(201).json({ document: addTag(db, actor(res), id, tag) });
  });

  app.delete('/api/documents/:id/tags/:tag', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Document not found');
    const tag = req.params.tag.trim().toLowerCase();
    res.json({ document: removeTag(db, actor(res), id, tag) });
  });

  // ── Soft delete ─────────────────────────────────────────────────────
  app.delete('/api/documents/:id', (req, res) => {
    const id = idParam(req.params.id);
    if (id === null) throw new DomainError(404, 'Document not found');
    softDeleteDocument(db, actor(res), id);
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
