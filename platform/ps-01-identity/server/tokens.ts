import type Database from 'better-sqlite3';
import type { SessionClaims } from '../shared/types.js';
import { verifyToken, type SessionConfig } from './auth.js';
import type { UserRow } from './identity.js';

/**
 * The cross-service identity contract. Another Platform Service holding a
 * PS-01 session token calls `POST /api/tokens/verify` to learn whether it
 * is valid and, if so, who it belongs to. Verification is twofold: the
 * HMAC + expiry must check out (stateless), AND the referenced user must
 * still exist, be active, and carry the same token_version (stateful —
 * this is what makes a password change revoke old tokens).
 */

export interface TokenVerdict {
  valid: boolean;
  claims?: SessionClaims;
}

export function verifyProvidedToken(
  db: Database.Database,
  session: SessionConfig,
  token: unknown,
  now = Date.now(),
): TokenVerdict {
  if (typeof token !== 'string') return { valid: false };
  const claims = verifyToken(session, token, now);
  if (!claims) return { valid: false };
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(claims.userId) as
    | UserRow
    | undefined;
  if (!user || user.status !== 'active' || user.token_version !== claims.tokenVersion) {
    return { valid: false };
  }
  return { valid: true, claims };
}
