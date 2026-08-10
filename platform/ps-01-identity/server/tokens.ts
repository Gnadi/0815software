import type Database from 'better-sqlite3';
import { PERMISSIONS, type Permission, type SessionClaims } from '../shared/types.js';
import { verifyToken, type SessionConfig } from './auth.js';
import { verifyApiKey } from './api-keys.js';
import { userPermissions, type UserRow } from './identity.js';

/**
 * The cross-service identity contract. Another Platform Service holding a
 * PS-01 credential calls `POST /api/tokens/verify` to learn whether it is
 * valid and, if so, who it belongs to and what it may do.
 *
 * Two credential kinds are accepted:
 *  - a **session token** — HMAC + expiry must check out (stateless), AND the
 *    referenced user must still exist, be active, and carry the same
 *    token_version (stateful — this is what makes a password change revoke
 *    old tokens). `permissions` are the user's role-derived set.
 *  - an **API key** (`psk_…`) — verified against its stored scrypt hash;
 *    `permissions` are the key's scopes (the full set for an unscoped key).
 */

export interface TokenVerdict {
  valid: boolean;
  claims?: SessionClaims;
  /** The principal's permission set — what downstream services authorize on. */
  permissions?: Permission[];
}

export async function verifyProvidedToken(
  db: Database.Database,
  session: SessionConfig,
  token: unknown,
  now = Date.now(),
): Promise<TokenVerdict> {
  if (typeof token !== 'string') return { valid: false };

  // Machine credential: a PS-01 API key. Hashed verification is async so the
  // scrypt work lands on the threadpool, not this service's event loop.
  if (token.startsWith('psk_')) {
    const key = await verifyApiKey(db, token, now);
    if (!key) return { valid: false };
    return { valid: true, permissions: key.scopes ?? [...PERMISSIONS] };
  }

  const claims = verifyToken(session, token, now);
  if (!claims) return { valid: false };
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(claims.userId) as
    | UserRow
    | undefined;
  if (!user || user.status !== 'active' || user.token_version !== claims.tokenVersion) {
    return { valid: false };
  }
  return { valid: true, claims, permissions: userPermissions(db, user.id) };
}
