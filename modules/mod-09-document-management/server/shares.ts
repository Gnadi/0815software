import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { MATTER_ROLE_RANK, type MatterRole, type PreviewKind, type PublicShare, type ShareLink, type ShareStatus } from '../shared/types.js';
import { hashPassword, verifyPassword } from './auth.js';
import { DomainError, requireDocumentAccess, type AuthUser } from './docs.js';
import { recordEvent } from './retention.js';
import { readSettings } from './settings.js';

/**
 * Share links: one document, for someone without an account, for a while.
 *
 * - The token is 32 random bytes; only its SHA-256 is stored, so the
 *   database cannot hand out working links. The link is shown once.
 * - Every link expires (the administrator sets the longest allowed), may
 *   need a password and may allow only so many downloads; downloads used are
 *   counted from the append-only event log, never decremented in place.
 * - Unknown, expired, revoked, used-up, deleted and switched-off all answer
 *   the same 404: a link either works or does not exist.
 * - After ten wrong passwords in fifteen minutes the link refuses passwords
 *   for the rest of that window, whoever is guessing.
 * - Who may make links is the administrator's choice (settings.ts): nobody,
 *   editors and owners, or owners only. The maker and the matter's owners
 *   may revoke.
 */

const PASSWORD_MIN = 8;
const LOCK_AFTER = 10;
const LOCK_WINDOW_MS = 15 * 60_000;
const GRANT_TTL_MS = 30 * 60_000;

export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Timestamps from the injected clock, in the module's format, so they compare as text. */
const isoAt = (now: number): string => new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');

interface LinkRow {
  id: number;
  document_id: number;
  version_no: number | null;
  token_hash: string;
  password_hash: string | null;
  max_downloads: number | null;
  expires_at: string;
  note: string;
  created_by: number;
  created_by_name: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by_name: string | null;
  downloads: number;
  last_used_at: string | null;
}

const LINK_FIELDS = `l.*, cu.name AS created_by_name, ru.name AS revoked_by_name,
  (SELECT COUNT(*) FROM share_events e WHERE e.link_id = l.id AND e.kind = 'downloaded') AS downloads,
  (SELECT MAX(at) FROM share_events e WHERE e.link_id = l.id AND e.kind <> 'password_failed') AS last_used_at`;
const LINK_FROM = 'FROM share_links l JOIN users cu ON cu.id = l.created_by LEFT JOIN users ru ON ru.id = l.revoked_by';

function statusOf(link: LinkRow, now: number): ShareStatus {
  if (link.revoked_at) return 'revoked';
  if (link.max_downloads !== null && link.downloads >= link.max_downloads) return 'used_up';
  if (Date.parse(link.expires_at) <= now) return 'expired';
  return 'active';
}

function view(link: LinkRow, user: AuthUser, role: MatterRole, now: number): ShareLink {
  return {
    id: link.id,
    version_no: link.version_no,
    expires_at: link.expires_at,
    note: link.note,
    has_password: link.password_hash !== null,
    max_downloads: link.max_downloads,
    downloads: link.downloads,
    last_used_at: link.last_used_at,
    created_by_name: link.created_by_name,
    created_at: link.created_at,
    revoked_at: link.revoked_at,
    revoked_by_name: link.revoked_by_name,
    status: statusOf(link, now),
    can_revoke: link.revoked_at === null && (link.created_by === user.id || role === 'owner'),
  };
}

/** A document's links, for editors and owners; null for viewers. */
export function documentShares(db: Database.Database, user: AuthUser, documentId: number, role: MatterRole, now: number): ShareLink[] | null {
  if (MATTER_ROLE_RANK[role] < MATTER_ROLE_RANK.editor) return null;
  return (db.prepare(`SELECT ${LINK_FIELDS} ${LINK_FROM} WHERE l.document_id = ? ORDER BY l.id DESC`).all(documentId) as LinkRow[]).map((l) => view(l, user, role, now));
}

/** Whether this person may make a link on a matter where they hold `role`. */
export function canShare(db: Database.Database, role: MatterRole): boolean {
  const policy = readSettings(db).share_links;
  return policy !== 'off' && MATTER_ROLE_RANK[role] >= MATTER_ROLE_RANK[policy];
}

export async function createShare(db: Database.Database, user: AuthUser, documentId: number, raw: Record<string, unknown>, now: number): Promise<{ link: ShareLink; token: string }> {
  const settings = readSettings(db);
  if (settings.share_links === 'off') throw new DomainError(403, 'Share links are switched off');
  const { role } = requireDocumentAccess(db, user, documentId, settings.share_links);

  const errors: { field: string; message: string }[] = [];
  let versionNo: number | null = null;
  if (raw.version_no !== undefined && raw.version_no !== null && raw.version_no !== '') {
    versionNo = Number(raw.version_no);
    if (!Number.isInteger(versionNo) || !db.prepare('SELECT 1 FROM document_versions WHERE document_id = ? AND version_no = ?').get(documentId, versionNo)) {
      errors.push({ field: 'version_no', message: 'no such version' });
    }
  }
  const days = raw.days === undefined || raw.days === null || raw.days === '' ? settings.share_default_days : Number(raw.days);
  if (!Number.isInteger(days) || days < 1 || days > settings.share_max_days) errors.push({ field: 'days', message: `a link may live from 1 to ${settings.share_max_days} days` });
  const password = typeof raw.password === 'string' ? raw.password : '';
  if (password !== '' && password.length < PASSWORD_MIN) errors.push({ field: 'password', message: `at least ${PASSWORD_MIN} characters` });
  if (password === '' && settings.share_require_password) errors.push({ field: 'password', message: 'a password is required for share links' });
  let maxDownloads: number | null = null;
  if (raw.max_downloads !== undefined && raw.max_downloads !== null && raw.max_downloads !== '') {
    maxDownloads = Number(raw.max_downloads);
    if (!Number.isInteger(maxDownloads) || maxDownloads < 1 || maxDownloads > 10_000) errors.push({ field: 'max_downloads', message: 'from 1 to 10,000' });
  }
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  if (note.length > 200) errors.push({ field: 'note', message: 'at most 200 characters' });
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);

  const token = randomBytes(32).toString('base64url');
  const expiresAt = isoAt(now + days * 86_400_000);
  const passwordHash = password ? await hashPassword(password) : null;
  const id = db
    .prepare(
      `INSERT INTO share_links (document_id, version_no, token_hash, password_hash, max_downloads, expires_at, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(documentId, versionNo, tokenHash(token), passwordHash, maxDownloads, expiresAt, note, user.id, isoAt(now)).lastInsertRowid as number;
  recordEvent(
    db,
    documentId,
    'share_created',
    `Link #${id}: ${versionNo === null ? 'current version' : `version ${versionNo}`}, until ${expiresAt.slice(0, 10)}${passwordHash ? ', password' : ''}${maxDownloads ? `, ${maxDownloads} downloads` : ''}${note ? ` — ${note}` : ''}`,
    user,
  );
  const link = db.prepare(`SELECT ${LINK_FIELDS} ${LINK_FROM} WHERE l.id = ?`).get(id) as LinkRow;
  return { link: view(link, user, role, now), token };
}

export function revokeShare(db: Database.Database, user: AuthUser, linkId: number, now: number): ShareLink {
  const link = db.prepare(`SELECT ${LINK_FIELDS} ${LINK_FROM} WHERE l.id = ?`).get(linkId) as LinkRow | undefined;
  if (!link) throw new DomainError(404, 'Link not found');
  // Someone who cannot see the document cannot learn the link exists — not
  // even from a different "not found".
  let role: MatterRole;
  try {
    role = requireDocumentAccess(db, user, link.document_id, 'viewer').role;
  } catch (err) {
    if (err instanceof DomainError && err.status === 404) throw new DomainError(404, 'Link not found');
    throw err;
  }
  if (link.created_by !== user.id && role !== 'owner') throw new DomainError(403, 'Only the person who made the link or an owner of the matter may revoke it');
  if (link.revoked_at) throw new DomainError(409, 'The link is already revoked');
  db.prepare('UPDATE share_links SET revoked_at = ?, revoked_by = ? WHERE id = ?').run(isoAt(now), user.id, linkId);
  recordEvent(db, link.document_id, 'share_revoked', `Link #${linkId}`, user);
  return view(db.prepare(`SELECT ${LINK_FIELDS} ${LINK_FROM} WHERE l.id = ?`).get(linkId) as LinkRow, user, role, now);
}

// ── The public side ──────────────────────────────────────────────────────

export interface ResolvedShare {
  linkId: number;
  documentId: number;
  title: string;
  passwordHash: string | null;
  expiresAt: string;
  downloadsLeft: number | null;
  version: { version_no: number; filename: string; content_type: string; storage_path: string; size_bytes: number; sha256: string; preview: PreviewKind; format: string | null };
}

/** A working link's document and version, or null — for every reason alike. */
export function resolveShare(db: Database.Database, token: unknown, now: number): ResolvedShare | null {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  if (readSettings(db).share_links === 'off') return null;
  const link = db.prepare(`SELECT ${LINK_FIELDS} ${LINK_FROM} WHERE l.token_hash = ?`).get(tokenHash(token)) as LinkRow | undefined;
  if (!link || statusOf(link, now) !== 'active') return null;
  const doc = db.prepare('SELECT title FROM documents WHERE id = ? AND deleted_at IS NULL').get(link.document_id) as { title: string } | undefined;
  if (!doc) return null;
  const version = db
    .prepare(
      `SELECT v.version_no, v.filename, v.content_type, v.storage_path, v.size_bytes, v.sha256, COALESCE(t.preview, 'none') AS preview, t.format
       FROM document_versions v LEFT JOIN version_text t ON t.version_id = v.id
       WHERE v.document_id = ? ${link.version_no === null ? '' : 'AND v.version_no = ?'}
       ORDER BY v.version_no DESC LIMIT 1`,
    )
    .get(...(link.version_no === null ? [link.document_id] : [link.document_id, link.version_no])) as ResolvedShare['version'] | undefined;
  if (!version) return null;
  return {
    linkId: link.id,
    documentId: link.document_id,
    title: doc.title,
    passwordHash: link.password_hash,
    expiresAt: link.expires_at,
    downloadsLeft: link.max_downloads === null ? null : link.max_downloads - link.downloads,
    version,
  };
}

export function publicView(share: ResolvedShare): PublicShare {
  return {
    title: share.title,
    filename: share.version.filename,
    size_bytes: share.version.size_bytes,
    version_no: share.version.version_no,
    preview: share.version.preview,
    expires_at: share.expiresAt,
    password_required: share.passwordHash !== null,
    downloads_left: share.downloadsLeft,
  };
}

export function recordShareEvent(db: Database.Database, linkId: number, kind: 'opened' | 'previewed' | 'downloaded' | 'password_failed', now: number): void {
  db.prepare('INSERT INTO share_events (link_id, kind, at) VALUES (?, ?, ?)').run(linkId, kind, isoAt(now));
}

const grantMac = (secret: string, linkId: number, expires: number): string =>
  createHmac('sha256', secret).update(`share-grant:${linkId}:${expires}`).digest('base64url');

/**
 * Check a password and hand back a short-lived grant for this link — what
 * the download and preview requests carry instead of the password itself.
 */
export async function unlockShare(db: Database.Database, share: ResolvedShare, password: unknown, secret: string, now: number): Promise<string> {
  if (share.passwordHash !== null) {
    const since = isoAt(now - LOCK_WINDOW_MS);
    const failures = (db.prepare("SELECT COUNT(*) AS n FROM share_events WHERE link_id = ? AND kind = 'password_failed' AND at > ?").get(share.linkId, since) as { n: number }).n;
    if (failures >= LOCK_AFTER) throw new DomainError(429, 'Too many wrong passwords — try again later');
    if (typeof password !== 'string' || !(await verifyPassword(password, share.passwordHash))) {
      recordShareEvent(db, share.linkId, 'password_failed', now);
      throw new DomainError(401, 'Wrong password');
    }
  }
  const expires = now + GRANT_TTL_MS;
  return `${expires}.${grantMac(secret, share.linkId, expires)}`;
}

/** Whether a request may fetch the link's bytes: no password, or a valid grant. */
export function mayFetch(share: ResolvedShare, grant: unknown, secret: string, now: number): boolean {
  if (share.passwordHash === null) return true;
  if (typeof grant !== 'string') return false;
  const [expiresRaw, mac] = grant.split('.');
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires <= now || !mac) return false;
  const expected = Buffer.from(grantMac(secret, share.linkId, expires));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
