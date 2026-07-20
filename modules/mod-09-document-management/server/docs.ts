import type Database from 'better-sqlite3';
import {
  MATTER_ROLE_RANK,
  type ActivityEntry,
  type DocumentDetail,
  type DocumentSummary,
  type DocumentVersion,
  type GlobalRole,
  type MatterMember,
  type MatterRole,
  type MatterSummary,
  type UserRef,
} from '../shared/types.js';

/** Error with an HTTP status and optional per-field details. */
export class DomainError extends Error {
  status: number;
  details: { field: string; message: string }[];

  constructor(status: number, message: string, details: { field: string; message: string }[] = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface AuthUser {
  id: number;
  username: string;
  name: string;
  role: GlobalRole;
}

interface MatterRow {
  id: number;
  key: string;
  name: string;
  description: string;
  created_by: number;
  created_at: string;
}

interface DocumentRow {
  id: number;
  matter_id: number;
  title: string;
  created_by: number;
  created_at: string;
  deleted_at: string | null;
}

// ══════════════════════════════════════════════════════════════════════
//  Authorization — the single choke point for every matter-scoped read
//  and write. Nothing else in the codebase decides matter access.
//
//  Security contract:
//    • A user with no membership on a matter (and who is not an admin)
//      must learn NOTHING about it — not even that it exists. Such
//      access throws 404, never 403, so the two are indistinguishable
//      from outside.
//    • A member whose role is below the required level gets 403: they
//      already know the matter exists, so hiding it serves no purpose,
//      and a clear "insufficient role" is the correct signal.
//    • Admins implicitly hold `owner` on every matter that exists.
// ══════════════════════════════════════════════════════════════════════

/**
 * The user's effective role on a matter, or null if they have no access.
 * Returns null when the matter does not exist OR the user is a non-admin
 * with no membership — callers must not distinguish the two.
 */
export function effectiveMatterRole(
  db: Database.Database,
  user: AuthUser,
  matterId: number,
): MatterRole | null {
  const matter = db.prepare('SELECT id FROM matters WHERE id = ?').get(matterId) as
    | { id: number }
    | undefined;
  if (!matter) return null;
  if (user.role === 'admin') return 'owner';
  const membership = db
    .prepare('SELECT role FROM matter_members WHERE matter_id = ? AND user_id = ?')
    .get(matterId, user.id) as { role: MatterRole } | undefined;
  return membership ? membership.role : null;
}

/**
 * Assert the user may act on a matter at `minRole` or above and return
 * their effective role. Throws 404 when the matter is invisible to them
 * (missing or no membership) and 403 when they can see it but lack the
 * required role.
 */
export function requireMatterAccess(
  db: Database.Database,
  user: AuthUser,
  matterId: number,
  minRole: MatterRole,
): MatterRole {
  const role = effectiveMatterRole(db, user, matterId);
  if (role === null) throw new DomainError(404, 'Matter not found');
  if (MATTER_ROLE_RANK[role] < MATTER_ROLE_RANK[minRole]) {
    throw new DomainError(403, `This action requires the "${minRole}" role on this matter`);
  }
  return role;
}

/**
 * Resolve a document to the matter it belongs to and assert access.
 * Deleted documents are treated as non-existent for reads (soft-delete
 * hides them); their history stays in the database. Throws 404 for
 * unknown/deleted ids and for matters the user cannot see.
 */
export function requireDocumentAccess(
  db: Database.Database,
  user: AuthUser,
  documentId: number,
  minRole: MatterRole,
  opts: { includeDeleted?: boolean } = {},
): { document: DocumentRow; role: MatterRole } {
  const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId) as
    | DocumentRow
    | undefined;
  if (!document || (document.deleted_at && !opts.includeDeleted)) {
    throw new DomainError(404, 'Document not found');
  }
  // Access is decided by the owning matter — a non-member must not be able
  // to tell a real document id from a bogus one, so resolve the matter role
  // first and surface the same 404 either way.
  const role = effectiveMatterRole(db, user, document.matter_id);
  if (role === null) throw new DomainError(404, 'Document not found');
  if (MATTER_ROLE_RANK[role] < MATTER_ROLE_RANK[minRole]) {
    throw new DomainError(403, `This action requires the "${minRole}" role on this matter`);
  }
  return { document, role };
}

// ── Users ──────────────────────────────────────────────────────────────

export function listUsers(db: Database.Database): UserRef[] {
  return db
    .prepare('SELECT id, username, name, role FROM users ORDER BY name')
    .all() as UserRef[];
}

export interface CreateUserInput {
  username: string;
  name: string;
  role: GlobalRole;
  passwordHash: string;
}

export function createUser(db: Database.Database, input: CreateUserInput): number {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(input.username);
  if (existing) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'username', message: `Username "${input.username}" is already taken` },
    ]);
  }
  return db
    .prepare(
      'INSERT INTO users (username, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(input.username, input.name, input.role, input.passwordHash, nowIso())
    .lastInsertRowid as number;
}

// ── Matters ─────────────────────────────────────────────────────────────

function matterSummary(db: Database.Database, matter: MatterRow, role: MatterRole): MatterSummary {
  const { document_count } = db
    .prepare('SELECT COUNT(*) AS document_count FROM documents WHERE matter_id = ? AND deleted_at IS NULL')
    .get(matter.id) as { document_count: number };
  const { member_count } = db
    .prepare('SELECT COUNT(*) AS member_count FROM matter_members WHERE matter_id = ?')
    .get(matter.id) as { member_count: number };
  return {
    id: matter.id,
    key: matter.key,
    name: matter.name,
    description: matter.description,
    created_at: matter.created_at,
    role,
    document_count,
    member_count,
  };
}

/** Matters the user can see: all for admins, granted ones for members. */
export function listMatters(db: Database.Database, user: AuthUser): MatterSummary[] {
  const matters =
    user.role === 'admin'
      ? (db.prepare('SELECT * FROM matters ORDER BY key').all() as MatterRow[])
      : (db
          .prepare(
            `SELECT m.* FROM matters m
             JOIN matter_members mm ON mm.matter_id = m.id
             WHERE mm.user_id = ?
             ORDER BY m.key`,
          )
          .all(user.id) as MatterRow[]);
  return matters.map((m) => matterSummary(db, m, effectiveMatterRole(db, user, m.id)!));
}

export function getMatter(db: Database.Database, user: AuthUser, matterId: number): MatterSummary {
  const role = requireMatterAccess(db, user, matterId, 'viewer');
  const matter = db.prepare('SELECT * FROM matters WHERE id = ?').get(matterId) as MatterRow;
  return matterSummary(db, matter, role);
}

export interface CreateMatterInput {
  key: string;
  name: string;
  description: string;
}

export function createMatter(
  db: Database.Database,
  user: AuthUser,
  input: CreateMatterInput,
): MatterSummary {
  const existing = db.prepare('SELECT id FROM matters WHERE key = ?').get(input.key);
  if (existing) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'key', message: `Matter key "${input.key}" is already in use` },
    ]);
  }
  const id = db
    .prepare('INSERT INTO matters (key, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.key, input.name, input.description, user.id, nowIso()).lastInsertRowid as number;
  const matter = db.prepare('SELECT * FROM matters WHERE id = ?').get(id) as MatterRow;
  return matterSummary(db, matter, 'owner');
}

// ── Members ──────────────────────────────────────────────────────────────

export function listMembers(db: Database.Database, user: AuthUser, matterId: number): MatterMember[] {
  requireMatterAccess(db, user, matterId, 'viewer');
  return db
    .prepare(
      `SELECT mm.user_id, u.username, u.name, mm.role, mm.created_at
       FROM matter_members mm JOIN users u ON u.id = mm.user_id
       WHERE mm.matter_id = ?
       ORDER BY u.name`,
    )
    .all(matterId) as MatterMember[];
}

export function addMember(
  db: Database.Database,
  user: AuthUser,
  matterId: number,
  targetUserId: number,
  role: MatterRole,
): void {
  requireMatterAccess(db, user, matterId, 'owner');
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetUserId);
  if (!target) {
    throw new DomainError(422, 'Validation failed', [{ field: 'user_id', message: 'Unknown user' }]);
  }
  const existing = db
    .prepare('SELECT id FROM matter_members WHERE matter_id = ? AND user_id = ?')
    .get(matterId, targetUserId);
  if (existing) {
    db.prepare('UPDATE matter_members SET role = ? WHERE matter_id = ? AND user_id = ?').run(
      role,
      matterId,
      targetUserId,
    );
  } else {
    db.prepare(
      'INSERT INTO matter_members (matter_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
    ).run(matterId, targetUserId, role, nowIso());
  }
}

export function removeMember(
  db: Database.Database,
  user: AuthUser,
  matterId: number,
  targetUserId: number,
): void {
  requireMatterAccess(db, user, matterId, 'owner');
  db.prepare('DELETE FROM matter_members WHERE matter_id = ? AND user_id = ?').run(
    matterId,
    targetUserId,
  );
}

// ── Documents ─────────────────────────────────────────────────────────────

const DOC_SUMMARY_FIELDS = `
  d.id, d.matter_id, m.key AS matter_key, d.title, d.created_at,
  cu.name AS created_by_name, d.deleted_at,
  (SELECT MAX(version_no) FROM document_versions v WHERE v.document_id = d.id) AS current_version,
  (SELECT COUNT(*) FROM document_versions v WHERE v.document_id = d.id) AS version_count,
  (SELECT MAX(uploaded_at) FROM document_versions v WHERE v.document_id = d.id) AS updated_at`;

function attachTags(db: Database.Database, doc: Omit<DocumentSummary, 'tags'>): DocumentSummary {
  const tags = db
    .prepare('SELECT tag FROM document_tags WHERE document_id = ? ORDER BY tag')
    .all(doc.id) as { tag: string }[];
  return { ...doc, tags: tags.map((t) => t.tag) };
}

export interface DocumentFilter {
  matterId?: number;
  tag?: string;
  search?: string;
}

/** List documents across every matter the user can see, with filters. */
export function listDocuments(
  db: Database.Database,
  user: AuthUser,
  filter: DocumentFilter,
): DocumentSummary[] {
  const clauses = ['d.deleted_at IS NULL'];
  const params: (string | number)[] = [];

  if (user.role !== 'admin') {
    clauses.push('d.matter_id IN (SELECT matter_id FROM matter_members WHERE user_id = ?)');
    params.push(user.id);
  }
  if (filter.matterId !== undefined) {
    // A matter filter must still respect access: a non-member asking for a
    // matter id they cannot see gets an empty list (never an error/leak).
    clauses.push('d.matter_id = ?');
    params.push(filter.matterId);
  }
  if (filter.tag) {
    clauses.push('EXISTS (SELECT 1 FROM document_tags t WHERE t.document_id = d.id AND t.tag = ?)');
    params.push(filter.tag);
  }
  if (filter.search) {
    clauses.push('d.title LIKE ?');
    params.push(`%${filter.search}%`);
  }

  const rows = db
    .prepare(
      `SELECT ${DOC_SUMMARY_FIELDS}
       FROM documents d
       JOIN matters m ON m.id = d.matter_id
       JOIN users cu ON cu.id = d.created_by
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC, d.id DESC`,
    )
    .all(...params) as Omit<DocumentSummary, 'tags'>[];
  return rows.map((r) => attachTags(db, r));
}

function documentSummaryById(db: Database.Database, documentId: number): DocumentSummary {
  const row = db
    .prepare(
      `SELECT ${DOC_SUMMARY_FIELDS}
       FROM documents d
       JOIN matters m ON m.id = d.matter_id
       JOIN users cu ON cu.id = d.created_by
       WHERE d.id = ?`,
    )
    .get(documentId) as Omit<DocumentSummary, 'tags'>;
  return attachTags(db, row);
}

function listVersions(db: Database.Database, documentId: number): DocumentVersion[] {
  return db
    .prepare(
      `SELECT v.id, v.version_no, v.size_bytes, v.sha256, v.content_type, v.filename,
              v.uploaded_by AS uploaded_by_id, u.name AS uploaded_by_name, v.uploaded_at
       FROM document_versions v JOIN users u ON u.id = v.uploaded_by
       WHERE v.document_id = ?
       ORDER BY v.version_no`,
    )
    .all(documentId) as DocumentVersion[];
}

/** Derived activity feed: document creation + every version add. */
function activityFor(
  db: Database.Database,
  doc: DocumentRow,
  versions: DocumentVersion[],
): ActivityEntry[] {
  const creator = db.prepare('SELECT name FROM users WHERE id = ?').get(doc.created_by) as {
    name: string;
  };
  const entries: ActivityEntry[] = versions.map((v) => ({
    kind: v.version_no === 1 ? 'document_created' : 'version_added',
    version_no: v.version_no,
    at: v.uploaded_at,
    actor_name: v.uploaded_by_name,
    detail:
      v.version_no === 1
        ? `Document created with version 1 (${v.filename})`
        : `Version ${v.version_no} uploaded (${v.filename})`,
  }));
  // Fall back to the document row if, hypothetically, there are no versions.
  if (entries.length === 0) {
    entries.push({
      kind: 'document_created',
      version_no: 0,
      at: doc.created_at,
      actor_name: creator.name,
      detail: 'Document created',
    });
  }
  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.version_no - a.version_no));
}

export function documentDetail(
  db: Database.Database,
  user: AuthUser,
  documentId: number,
): DocumentDetail {
  const { document, role } = requireDocumentAccess(db, user, documentId, 'viewer');
  const summary = documentSummaryById(db, documentId);
  const versions = listVersions(db, documentId);
  return {
    document: summary,
    versions,
    activity: activityFor(db, document, versions),
    matter_role: role,
    matter_key: summary.matter_key,
  };
}

export interface UploadInput {
  title: string;
  filename: string;
  contentType: string;
  sha256: string;
  size: number;
  storagePath: string;
}

/** Create a new document with its first version. Requires editor+. */
export function createDocument(
  db: Database.Database,
  user: AuthUser,
  matterId: number,
  input: UploadInput,
): DocumentDetail {
  requireMatterAccess(db, user, matterId, 'editor');
  const at = nowIso();
  const documentId = db.transaction(() => {
    const id = db
      .prepare('INSERT INTO documents (matter_id, title, created_by, created_at) VALUES (?, ?, ?, ?)')
      .run(matterId, input.title, user.id, at).lastInsertRowid as number;
    insertVersion(db, id, 1, user.id, at, input);
    return id;
  })();
  return documentDetail(db, user, documentId);
}

/**
 * Append a new version to a document. The version number is derived from
 * the existing chain (MAX + 1), so it is always gapless and prior versions
 * are never touched. Requires editor+.
 */
export function addVersion(
  db: Database.Database,
  user: AuthUser,
  documentId: number,
  input: UploadInput,
): DocumentDetail {
  const { document } = requireDocumentAccess(db, user, documentId, 'editor');
  db.transaction(() => {
    const { next } = db
      .prepare(
        'SELECT COALESCE(MAX(version_no), 0) + 1 AS next FROM document_versions WHERE document_id = ?',
      )
      .get(document.id) as { next: number };
    insertVersion(db, document.id, next, user.id, nowIso(), input);
  })();
  return documentDetail(db, user, documentId);
}

function insertVersion(
  db: Database.Database,
  documentId: number,
  versionNo: number,
  userId: number,
  at: string,
  input: UploadInput,
): void {
  db.prepare(
    `INSERT INTO document_versions
       (document_id, version_no, size_bytes, sha256, content_type, filename, storage_path, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    documentId,
    versionNo,
    input.size,
    input.sha256,
    input.contentType,
    input.filename,
    input.storagePath,
    userId,
    at,
  );
}

export interface ResolvedVersion {
  filename: string;
  content_type: string;
  storage_path: string;
  sha256: string;
  size_bytes: number;
  version_no: number;
}

/** Resolve a downloadable version (current when `versionNo` is undefined). */
export function resolveVersion(
  db: Database.Database,
  user: AuthUser,
  documentId: number,
  versionNo: number | undefined,
): ResolvedVersion {
  requireDocumentAccess(db, user, documentId, 'viewer');
  const row =
    versionNo === undefined
      ? (db
          .prepare(
            `SELECT filename, content_type, storage_path, sha256, size_bytes, version_no
             FROM document_versions WHERE document_id = ?
             ORDER BY version_no DESC LIMIT 1`,
          )
          .get(documentId) as ResolvedVersion | undefined)
      : (db
          .prepare(
            `SELECT filename, content_type, storage_path, sha256, size_bytes, version_no
             FROM document_versions WHERE document_id = ? AND version_no = ?`,
          )
          .get(documentId, versionNo) as ResolvedVersion | undefined);
  if (!row) throw new DomainError(404, 'Version not found');
  return row;
}

// ── Tags ──────────────────────────────────────────────────────────────────

export function addTag(
  db: Database.Database,
  user: AuthUser,
  documentId: number,
  tag: string,
): DocumentSummary {
  requireDocumentAccess(db, user, documentId, 'editor');
  db.prepare('INSERT OR IGNORE INTO document_tags (document_id, tag) VALUES (?, ?)').run(
    documentId,
    tag,
  );
  return documentSummaryById(db, documentId);
}

export function removeTag(
  db: Database.Database,
  user: AuthUser,
  documentId: number,
  tag: string,
): DocumentSummary {
  requireDocumentAccess(db, user, documentId, 'editor');
  db.prepare('DELETE FROM document_tags WHERE document_id = ? AND tag = ?').run(documentId, tag);
  return documentSummaryById(db, documentId);
}

/** List every distinct tag on documents the user can see. */
export function listTags(db: Database.Database, user: AuthUser): string[] {
  const rows =
    user.role === 'admin'
      ? (db
          .prepare(
            `SELECT DISTINCT t.tag FROM document_tags t
             JOIN documents d ON d.id = t.document_id
             WHERE d.deleted_at IS NULL ORDER BY t.tag`,
          )
          .all() as { tag: string }[])
      : (db
          .prepare(
            `SELECT DISTINCT t.tag FROM document_tags t
             JOIN documents d ON d.id = t.document_id
             WHERE d.deleted_at IS NULL
               AND d.matter_id IN (SELECT matter_id FROM matter_members WHERE user_id = ?)
             ORDER BY t.tag`,
          )
          .all(user.id) as { tag: string }[]);
  return rows.map((r) => r.tag);
}

// ── Soft delete ───────────────────────────────────────────────────────────

/**
 * Soft-delete a document: hide it from lists and reads while keeping its
 * full version history in the database. Requires owner (admins implicitly).
 * Hard delete is intentionally out of scope.
 */
export function softDeleteDocument(db: Database.Database, user: AuthUser, documentId: number): void {
  requireDocumentAccess(db, user, documentId, 'owner');
  db.prepare('UPDATE documents SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(
    nowIso(),
    documentId,
  );
}
