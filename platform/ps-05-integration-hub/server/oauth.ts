import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';
import { createConnection, type ConnectionRow } from './connections.js';
import type { FetchLike } from './proxy.js';

/**
 * OAuth2 connect flow for provider connections.
 *
 * Like the rest of the platform, a real provider token exchange happens only
 * when that provider is configured (client id + secret in the environment);
 * otherwise a deterministic, offline mock resolves a connection with
 * placeholder credentials so authorize → callback works in tests and CI with
 * zero external calls. State (CSRF) bookkeeping is real in both modes.
 */

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
}

export type OAuthConfig = Record<string, OAuthProviderConfig>;

/** Read per-provider OAuth config from the environment (activated by id+secret). */
export function oauthConfigFromEnv(env: NodeJS.ProcessEnv, providerKeys: readonly string[]): OAuthConfig {
  const config: OAuthConfig = {};
  for (const key of providerKeys) {
    const up = key.toUpperCase();
    const clientId = env[`OAUTH_${up}_CLIENT_ID`];
    const clientSecret = env[`OAUTH_${up}_CLIENT_SECRET`];
    const authorizeUrl = env[`OAUTH_${up}_AUTHORIZE_URL`];
    const tokenUrl = env[`OAUTH_${up}_TOKEN_URL`];
    if (!clientId || !clientSecret || !authorizeUrl || !tokenUrl) continue;
    config[key] = { clientId, clientSecret, authorizeUrl, tokenUrl, scope: env[`OAUTH_${up}_SCOPE`] ?? '' };
  }
  return config;
}

interface StateRow {
  id: number;
  provider: string;
  state: string;
  name: string | null;
  created_at: string;
}

export function beginAuthorize(
  db: Database.Database,
  provider: string,
  opts: { name: string | null; providerConfig?: OAuthProviderConfig; selfBaseUrl: string },
  now = Date.now(),
): string {
  const state = randomBytes(16).toString('hex');
  db.prepare('INSERT INTO oauth_states (provider, state, name, created_at) VALUES (?, ?, ?, ?)').run(
    provider,
    state,
    opts.name,
    nowIso(now),
  );
  const callbackUri = `${opts.selfBaseUrl}/api/connections/${provider}/callback`;
  if (opts.providerConfig) {
    const q = new URLSearchParams({
      client_id: opts.providerConfig.clientId,
      redirect_uri: callbackUri,
      response_type: 'code',
      scope: opts.providerConfig.scope,
      state,
    });
    return `${opts.providerConfig.authorizeUrl}?${q.toString()}`;
  }
  const q = new URLSearchParams({ state, code: `mock-${state}` });
  return `${callbackUri}?${q.toString()}`;
}

export function consumeState(db: Database.Database, provider: string, state: unknown): StateRow | undefined {
  if (typeof state !== 'string' || state.length === 0) return undefined;
  const row = db.prepare('SELECT * FROM oauth_states WHERE state = ? AND provider = ?').get(state, provider) as
    | StateRow
    | undefined;
  if (row) db.prepare('DELETE FROM oauth_states WHERE id = ?').run(row.id);
  return row;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at?: string | null;
}

async function postForm(
  doFetch: FetchLike,
  url: string,
  params: Record<string, string>,
): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number }> {
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new Error(`token endpoint failed (${res.status})`);
  return JSON.parse(await res.text()) as { access_token?: string; refresh_token?: string; expires_in?: number };
}

/** Exchange an authorization code (real) or synthesize one (mock). */
export async function exchangeCode(
  code: string,
  redirectUri: string,
  cfg: OAuthProviderConfig | undefined,
  doFetch: FetchLike,
  now: number,
): Promise<TokenSet> {
  if (!cfg) {
    return { access_token: `mock-access-${code}`, refresh_token: `mock-refresh-${code}`, expires_at: nowIso(now + 3600_000) };
  }
  const t = await postForm(doFetch, cfg.tokenUrl, {
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: redirectUri,
  });
  if (!t.access_token) throw new Error('no access_token in token response');
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: t.expires_in ? nowIso(now + t.expires_in * 1000) : null,
  };
}

/** Refresh an access token (real) or bump the mock credentials. */
export async function refreshToken(
  credentials: Record<string, unknown>,
  cfg: OAuthProviderConfig | undefined,
  doFetch: FetchLike,
  now: number,
): Promise<TokenSet | null> {
  const refresh = typeof credentials.refresh_token === 'string' ? credentials.refresh_token : '';
  if (!cfg || !refresh) {
    // No real refresh possible — rotate the mock access token deterministically.
    if (typeof credentials.access_token === 'string' && credentials.access_token.startsWith('mock-access-')) {
      return { access_token: `mock-access-r${now}`, refresh_token: refresh || undefined, expires_at: nowIso(now + 3600_000) };
    }
    return null;
  }
  const t = await postForm(doFetch, cfg.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  if (!t.access_token) throw new Error('no access_token in refresh response');
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? refresh,
    expires_at: t.expires_in ? nowIso(now + t.expires_in * 1000) : null,
  };
}

/** Provision a connection from a resolved token set. */
export function connectionFromTokens(
  db: Database.Database,
  encKey: Buffer,
  provider: string,
  name: string,
  tokens: TokenSet,
  now: number,
): ConnectionRow {
  return createConnection(
    db,
    encKey,
    {
      provider,
      name,
      credentials: { access_token: tokens.access_token, refresh_token: tokens.refresh_token },
      scopes: '',
      expiresAt: tokens.expires_at ?? null,
    },
    now,
  );
}
