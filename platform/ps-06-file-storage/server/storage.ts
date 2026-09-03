import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';
import { DomainError } from './errors.js';
import type { Bucket, ObjectInfo } from '../shared/types.js';

interface ObjectRow {
  bucket: string;
  key: string;
  content_type: string;
  size: number;
  sha256: string;
  metadata: string;
  content: Buffer;
  created_at: string;
  updated_at: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export function createBucket(db: Database.Database, name: string, now = Date.now()): Bucket {
  if (!NAME_RE.test(name)) throw new DomainError(422, 'Validation failed', [{ field: 'name', message: 'invalid bucket name' }]);
  if (db.prepare('SELECT 1 FROM buckets WHERE name = ?').get(name)) throw new DomainError(409, 'Bucket already exists');
  const at = nowIso(now);
  db.prepare('INSERT INTO buckets (name, created_at) VALUES (?, ?)').run(name, at);
  return { name, created_at: at };
}

export function listBuckets(db: Database.Database): Bucket[] {
  return db.prepare('SELECT name, created_at FROM buckets ORDER BY name').all() as Bucket[];
}

export function requireBucket(db: Database.Database, name: string): void {
  if (!db.prepare('SELECT 1 FROM buckets WHERE name = ?').get(name)) throw new DomainError(404, 'Bucket not found');
}

function mapInfo(row: Omit<ObjectRow, 'content'>): ObjectInfo {
  return {
    bucket: row.bucket,
    key: row.key,
    size: row.size,
    content_type: row.content_type,
    sha256: row.sha256,
    metadata: JSON.parse(row.metadata) as Record<string, string>,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Store (create or overwrite) an object. `content` is the raw bytes. */
export function putObject(
  db: Database.Database,
  opts: { bucket: string; key: string; content: Buffer; contentType?: string; metadata?: Record<string, string> },
  now = Date.now(),
): ObjectInfo {
  requireBucket(db, opts.bucket);
  if (!opts.key || opts.key.length > 1024) throw new DomainError(422, 'Validation failed', [{ field: 'key', message: 'invalid key' }]);
  const sha256 = createHash('sha256').update(opts.content).digest('hex');
  const contentType = opts.contentType ?? 'application/octet-stream';
  const metadata = JSON.stringify(opts.metadata ?? {});
  const at = nowIso(now);
  const existing = db.prepare('SELECT created_at FROM objects WHERE bucket = ? AND key = ?').get(opts.bucket, opts.key) as
    | { created_at: string }
    | undefined;
  const createdAt = existing?.created_at ?? at;
  db.prepare(
    `INSERT INTO objects (bucket, key, content_type, size, sha256, metadata, content, created_at, updated_at)
       VALUES (@bucket, @key, @content_type, @size, @sha256, @metadata, @content, @created_at, @updated_at)
     ON CONFLICT(bucket, key) DO UPDATE SET
       content_type = @content_type, size = @size, sha256 = @sha256, metadata = @metadata,
       content = @content, updated_at = @updated_at`,
  ).run({
    bucket: opts.bucket,
    key: opts.key,
    content_type: contentType,
    size: opts.content.length,
    sha256,
    metadata,
    content: opts.content,
    created_at: createdAt,
    updated_at: at,
  });
  return statObject(db, opts.bucket, opts.key);
}

export function statObject(db: Database.Database, bucket: string, key: string): ObjectInfo {
  const row = db
    .prepare('SELECT bucket, key, content_type, size, sha256, metadata, created_at, updated_at FROM objects WHERE bucket = ? AND key = ?')
    .get(bucket, key) as Omit<ObjectRow, 'content'> | undefined;
  if (!row) throw new DomainError(404, 'Object not found');
  return mapInfo(row);
}

export function getObject(db: Database.Database, bucket: string, key: string): { info: ObjectInfo; content: Buffer } {
  const row = db.prepare('SELECT * FROM objects WHERE bucket = ? AND key = ?').get(bucket, key) as ObjectRow | undefined;
  if (!row) throw new DomainError(404, 'Object not found');
  return { info: mapInfo(row), content: row.content };
}

export function listObjects(db: Database.Database, bucket: string): ObjectInfo[] {
  requireBucket(db, bucket);
  const rows = db
    .prepare('SELECT bucket, key, content_type, size, sha256, metadata, created_at, updated_at FROM objects WHERE bucket = ? ORDER BY key')
    .all(bucket) as Omit<ObjectRow, 'content'>[];
  return rows.map(mapInfo);
}

export function deleteObject(db: Database.Database, bucket: string, key: string): boolean {
  const info = db.prepare('DELETE FROM objects WHERE bucket = ? AND key = ?').run(bucket, key);
  return info.changes > 0;
}

// ── HMAC-signed download URLs ──────────────────────────────────────────

function signPayload(secret: string, bucket: string, key: string, expires: number): string {
  return createHmac('sha256', secret).update(`${bucket}\n${key}\n${expires}`).digest('hex');
}

/**
 * The longest life a signed download URL may be given: seven days.
 *
 * A ceiling has to exist somewhere, because a signature carries no revocation —
 * once issued, the only thing that stops it being redeemed is the clock, and
 * deleting the object. Seven days is long enough for the cases the route is
 * for (mail a customer their invoice, hand a link to a support agent) and short
 * enough that a leaked URL stops working within a week.
 */
export const MAX_SIGN_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Build a signed, time-limited download URL path (relative). */
export function signDownloadUrl(secret: string, bucket: string, key: string, ttlSeconds: number, now = Date.now()): {
  url: string;
  expires_at: string;
} {
  const expires = now + Math.max(1, ttlSeconds) * 1000;
  const sig = signPayload(secret, bucket, key, expires);
  const q = new URLSearchParams({ bucket, key, expires: String(expires), sig });
  return { url: `/api/download?${q.toString()}`, expires_at: nowIso(expires) };
}

/**
 * Response headers for the public download route.
 *
 * `content_type` is caller-supplied and stored verbatim, so serving it back
 * inline turns any bucket into a stored-XSS vector: a signed URL for an object
 * uploaded as `text/html` would execute script on PS-06's own origin, where the
 * `ps06_session` cookie lives. `nosniff` does not help — the type is not being
 * guessed, it is being declared.
 *
 * So the download is always an attachment (browsers never render an attachment
 * inline, whatever the type), with a sandbox CSP as a second line of defence.
 * The declared type is still reported so a legitimate client can act on it, and
 * `GET /api/objects/:bucket/:key` returns the bytes as base64 JSON for callers
 * that want to render the content themselves under their own trust rules.
 */
export function downloadHeaders(info: Pick<ObjectInfo, 'content_type' | 'key' | 'size'>): Record<string, string> {
  return {
    'Content-Type': info.content_type,
    'Content-Length': String(info.size),
    'Content-Disposition': `attachment; filename="${attachmentFilename(info.key)}"`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
  };
}

/**
 * A quoted-string-safe filename from an object key: last path segment, with
 * quotes, backslashes and control characters (header-injection and
 * quoted-string-escape characters) dropped.
 */
export function attachmentFilename(key: string): string {
  const base = key.split('/').filter(Boolean).pop() ?? '';
  const safe = base.replace(/[\u0000-\u001f\u007f"\\]/g, '').trim();
  return safe === '' ? 'download' : safe;
}

/** Verify a signed download request. Returns true only if fresh and valid. */
export function verifyDownload(
  secret: string,
  params: { bucket?: unknown; key?: unknown; expires?: unknown; sig?: unknown },
  now = Date.now(),
): boolean {
  const bucket = typeof params.bucket === 'string' ? params.bucket : '';
  const key = typeof params.key === 'string' ? params.key : '';
  const expires = typeof params.expires === 'string' ? Number(params.expires) : NaN;
  const sig = typeof params.sig === 'string' ? params.sig : '';
  if (!bucket || !key || !Number.isFinite(expires) || !sig) return false;
  if (expires < now) return false;
  const expected = signPayload(secret, bucket, key, expires);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
