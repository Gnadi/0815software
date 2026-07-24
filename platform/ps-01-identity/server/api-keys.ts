import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ApiKeySummary, Permission } from '../shared/types.js';
import { hashPassword, nowIso, verifyPassword } from './auth.js';

/**
 * Machine-to-machine credentials. The presented key has two halves:
 *   psk_<12 hex prefix> . <48 hex secret>
 * The prefix is stored in the clear (unique, safe to display); the secret
 * half is stored only as a scrypt hash. The full key is shown once, at
 * creation, and can never be recovered afterwards.
 */

export interface ApiKeyRow {
  id: number;
  org_id: number;
  name: string;
  prefix: string;
  key_hash: string;
  /** JSON Permission[]; '' means the key carries every permission. */
  scopes: string;
  created_by: number | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** Parse a stored scopes column. Empty = unrestricted (null). */
export function parseScopes(stored: string): Permission[] | null {
  if (!stored) return null;
  return JSON.parse(stored) as Permission[];
}

export function keySummary(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

export interface MintedKey {
  summary: ApiKeySummary;
  secret: string; // the full key — returned exactly once
}

export function mintApiKey(
  db: Database.Database,
  orgId: number,
  name: string,
  createdBy: number | null,
  now = Date.now(),
  scopes: Permission[] | null = null,
): MintedKey {
  const prefix = `psk_${randomBytes(6).toString('hex')}`;
  const secretPart = randomBytes(24).toString('hex');
  const createdAt = nowIso(now);
  const info = db
    .prepare(
      `INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(orgId, name, prefix, hashPassword(secretPart), scopes ? JSON.stringify(scopes) : '', createdBy, createdAt);
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(info.lastInsertRowid) as ApiKeyRow;
  return { summary: keySummary(row), secret: `${prefix}.${secretPart}` };
}

export interface VerifiedKey {
  orgId: number;
  /** null = the key carries every permission (unscoped, backward compatible). */
  scopes: Permission[] | null;
}

/** Verify a presented API key. Returns its org + scopes, or null. */
export function verifyApiKey(db: Database.Database, presented: string, now = Date.now()): VerifiedKey | null {
  if (!presented.startsWith('psk_')) return null;
  const dot = presented.indexOf('.');
  if (dot < 1) return null;
  const prefix = presented.slice(0, dot);
  const secretPart = presented.slice(dot + 1);
  const row = db
    .prepare('SELECT * FROM api_keys WHERE prefix = ? AND revoked_at IS NULL')
    .get(prefix) as ApiKeyRow | undefined;
  if (!row || !verifyPassword(secretPart, row.key_hash)) return null;
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(now), row.id);
  return { orgId: row.org_id, scopes: parseScopes(row.scopes) };
}
