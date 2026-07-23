import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';

/**
 * OAuth is stubbed in v1: the provider registry and the CSRF-nonce
 * bookkeeping are real, but no external identity provider is contacted.
 * `authorize` records a state nonce and redirects to a placeholder;
 * `callback` returns 501. This is the documented seam where a real
 * OpenID Connect / OAuth2 flow would be wired in.
 */

export const OAUTH_PROVIDERS = ['google', 'microsoft', 'github'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(v: string): v is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(v);
}

/** Record a CSRF state nonce and return the placeholder authorize URL. */
export function beginAuthorize(
  db: Database.Database,
  provider: OAuthProvider,
  redirectUri: string | null,
  now = Date.now(),
): string {
  const state = randomBytes(16).toString('hex');
  db.prepare(
    'INSERT INTO oauth_states (provider, state, redirect_uri, created_at) VALUES (?, ?, ?, ?)',
  ).run(provider, state, redirectUri, nowIso(now));
  // Placeholder authorization endpoint — a real deployment substitutes the
  // provider's OAuth2 authorize URL here.
  return `https://oauth.example.invalid/${provider}/authorize?state=${state}`;
}
