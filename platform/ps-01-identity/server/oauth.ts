import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { hashPassword, nowIso } from './auth.js';
import { DomainError } from './errors.js';
import type { UserRow } from './identity.js';

/**
 * OAuth2 / OIDC authorization-code flow.
 *
 * In the spirit of the rest of the platform, a real external provider is
 * contacted only when it is configured (client id + secret in the
 * environment); otherwise a deterministic, offline **mock IdP** resolves a
 * stable identity so the whole authorize → callback → session flow works in
 * tests and CI with zero external calls. The CSRF-state bookkeeping is real
 * in both modes.
 */

export const OAUTH_PROVIDERS = ['google', 'microsoft', 'github'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(v: string): v is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(v);
}

/** Per-provider endpoint defaults; only client id/secret need configuring. */
export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
}

export type OAuthConfig = Partial<Record<OAuthProvider, OAuthProviderConfig>>;

/**
 * How long a CSRF state nonce stays usable. A state is single-use anyway; the
 * window bounds how long a leaked authorize URL remains redeemable and lets the
 * table be pruned instead of growing for the life of the deployment.
 */
export const STATE_TTL_MS = 10 * 60_000;

/**
 * Is this a redirect target we are willing to append a session token to?
 *
 * The callback hands the freshly minted token to `redirect_uri`, so an
 * unvalidated value would let anyone mail a victim an authorize link and
 * collect their session. Accepted: a same-site path, this service's own
 * origin, or an operator-configured origin from `OAUTH_REDIRECT_ALLOWLIST`.
 */
export function isAllowedRedirect(
  redirectUri: string,
  allowlist: readonly string[],
  selfBaseUrl: string,
): boolean {
  // A relative path is same-site by construction. "//host" is protocol-relative
  // — an absolute URL in disguise — and must not slip through.
  if (redirectUri.startsWith('/') && !redirectUri.startsWith('//')) return true;

  let target: URL;
  try {
    target = new URL(redirectUri);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;

  const origins = new Set<string>();
  for (const candidate of [selfBaseUrl, ...allowlist]) {
    if (!candidate) continue;
    try {
      origins.add(new URL(candidate).origin);
    } catch {
      /* an unparseable allowlist entry simply allows nothing */
    }
  }
  return origins.has(target.origin);
}

const DEFAULT_ENDPOINTS: Record<OAuthProvider, Omit<OAuthProviderConfig, 'clientId' | 'clientSecret'>> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
  },
  microsoft: {
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userInfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
    scope: 'openid email profile',
  },
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userInfoUrl: 'https://api.github.com/user',
    scope: 'read:user user:email',
  },
};

/** Read OAuth provider config from the environment (activated by client id + secret). */
export function oauthConfigFromEnv(env: NodeJS.ProcessEnv): OAuthConfig {
  const config: OAuthConfig = {};
  for (const provider of OAUTH_PROVIDERS) {
    const up = provider.toUpperCase();
    const clientId = env[`OAUTH_${up}_CLIENT_ID`];
    const clientSecret = env[`OAUTH_${up}_CLIENT_SECRET`];
    if (!clientId || !clientSecret) continue;
    const d = DEFAULT_ENDPOINTS[provider];
    config[provider] = {
      clientId,
      clientSecret,
      authorizeUrl: env[`OAUTH_${up}_AUTHORIZE_URL`] ?? d.authorizeUrl,
      tokenUrl: env[`OAUTH_${up}_TOKEN_URL`] ?? d.tokenUrl,
      userInfoUrl: env[`OAUTH_${up}_USERINFO_URL`] ?? d.userInfoUrl,
      scope: env[`OAUTH_${up}_SCOPE`] ?? d.scope,
    };
  }
  return config;
}

/** The subset of `fetch` the token/userinfo exchange needs (injectable for tests). */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export interface ResolvedIdentity {
  email: string;
  name: string;
  subject: string;
}

interface StateRow {
  id: number;
  provider: string;
  state: string;
  org_slug: string | null;
  redirect_uri: string | null;
  created_at: string;
}

/**
 * Begin an authorization: record a CSRF state nonce bound to the target org,
 * and return the URL the caller should be redirected to. When the provider is
 * configured, that is the provider's real authorize endpoint; otherwise it is
 * our own callback with a deterministic mock code (the offline mock IdP).
 */
export function beginAuthorize(
  db: Database.Database,
  provider: OAuthProvider,
  opts: {
    orgSlug: string;
    redirectUri: string | null;
    providerConfig?: OAuthProviderConfig;
    selfBaseUrl: string;
    /** Unconfigured provider → offline mock IdP. Off in production. */
    allowMockIdp?: boolean;
  },
  now = Date.now(),
): string {
  if (!opts.providerConfig && opts.allowMockIdp === false) {
    throw new DomainError(501, `OAuth provider "${provider}" is not configured`);
  }
  const state = randomBytes(16).toString('hex');
  db.prepare(
    'INSERT INTO oauth_states (provider, state, org_slug, redirect_uri, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(provider, state, opts.orgSlug, opts.redirectUri, nowIso(now));

  const callbackUri = `${opts.selfBaseUrl}/api/oauth/${provider}/callback`;
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
  // Mock IdP: bounce back to our own callback with a deterministic code.
  const q = new URLSearchParams({ state, code: `mock-${state}` });
  return `${callbackUri}?${q.toString()}`;
}

/**
 * Deterministic offline identity for the mock IdP. Keyed on provider + org so
 * that repeated logins to the same tenant resolve to the same user — mock SSO
 * that behaves consistently in tests and demos.
 */
export function mockIdentity(provider: OAuthProvider, orgSlug: string): ResolvedIdentity {
  const digest = createHash('sha256').update(`${provider}:${orgSlug}`).digest('hex').slice(0, 12);
  return {
    email: `oauth-${provider}-${digest}@mock.local`,
    name: `${provider[0]!.toUpperCase()}${provider.slice(1)} User (${orgSlug})`,
    subject: `${provider}:${digest}`,
  };
}

/** Exchange an authorization code for an identity via a real provider. */
export async function fetchIdentity(
  cfg: OAuthProviderConfig,
  code: string,
  redirectUri: string,
  doFetch: FetchLike,
): Promise<ResolvedIdentity> {
  const tokenRes = await doFetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status})`);
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) throw new Error('no access_token in token response');

  const infoRes = await doFetch(cfg.userInfoUrl, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: 'application/json',
      'User-Agent': '0815software-ps01',
    },
  });
  if (!infoRes.ok) throw new Error(`userinfo failed (${infoRes.status})`);
  const info = (await infoRes.json()) as Record<string, unknown>;
  const email = String(info.email ?? info.mail ?? info.login ?? '');
  const name = String(info.name ?? info.login ?? email);
  const subject = String(info.sub ?? info.id ?? email);
  if (!email) throw new Error('provider returned no email');
  return { email, name, subject };
}

/**
 * Consume a stored state nonce (single-use) and return it, or undefined. A
 * nonce older than `STATE_TTL_MS` is consumed but not honoured, and every call
 * clears whatever else has expired so an abandoned authorize cannot accumulate.
 */
export function consumeState(
  db: Database.Database,
  provider: string,
  state: unknown,
  now = Date.now(),
): StateRow | undefined {
  db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(nowIso(now - STATE_TTL_MS));
  if (typeof state !== 'string' || state.length === 0) return undefined;
  const row = db.prepare('SELECT * FROM oauth_states WHERE state = ? AND provider = ?').get(state, provider) as
    | StateRow
    | undefined;
  if (row) db.prepare('DELETE FROM oauth_states WHERE id = ?').run(row.id);
  return row;
}

/**
 * Provision-or-link a user from a resolved identity, within the org the
 * authorize step recorded. Returns the user row; a new user gets a random
 * (unusable-for-login) password hash and the default `member` role.
 */
export async function linkUser(
  db: Database.Database,
  orgId: number,
  identity: ResolvedIdentity,
  now = Date.now(),
): Promise<UserRow> {
  const email = identity.email.trim().toLowerCase();
  const existing = db.prepare('SELECT * FROM users WHERE org_id = ? AND email = ?').get(orgId, email) as
    | UserRow
    | undefined;
  if (existing) return existing;

  // An OAuth-linked account has no usable password; it still gets a random
  // one so the column is never empty. Hashed before the (synchronous)
  // transaction, since hashing is async — see server/auth.ts.
  const placeholderHash = await hashPassword(randomBytes(24).toString('hex'));

  return db.transaction((): UserRow => {
    const info = db
      .prepare(`INSERT INTO users (org_id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(orgId, email, identity.name, placeholderHash, nowIso(now));
    const userId = Number(info.lastInsertRowid);
    const member = db
      .prepare('SELECT id FROM roles WHERE key = ? AND (org_id IS NULL OR org_id = ?)')
      .get('member', orgId) as { id: number } | undefined;
    if (member) {
      db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)').run(
        userId,
        member.id,
        nowIso(now),
      );
    }
    return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow;
  })();
}
