import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { hashPassword, nowIso } from './auth.js';
import { DomainError } from './errors.js';
import type { UserRow } from './identity.js';
import { createPkcePair, discover, OidcCache, verifyIdToken, type FetchJson } from './oidc.js';

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

/**
 * The three providers that ship with endpoint defaults. They are a
 * convenience, not the supported set: any OIDC-compliant provider is
 * configured by name with an issuer — see `oauthConfigFromEnv`.
 */
export const BUILTIN_PROVIDERS = ['google', 'microsoft', 'github'] as const;
export type BuiltinProvider = (typeof BUILTIN_PROVIDERS)[number];

/** Retained name for the built-in set (it is what the wiring tests import). */
export const OAUTH_PROVIDERS = BUILTIN_PROVIDERS;

/** A provider name is a path segment and an env-var infix, so keep it boring. */
export const PROVIDER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type OAuthProvider = string;

export function isOAuthProvider(v: string): v is OAuthProvider {
  return PROVIDER_NAME_RE.test(v);
}

export function isBuiltinProvider(v: string): v is BuiltinProvider {
  return (BUILTIN_PROVIDERS as readonly string[]).includes(v);
}

/**
 * A configured provider.
 *
 * Either `issuer` is set — and the endpoints are discovered from
 * `<issuer>/.well-known/openid-configuration` — or the endpoints are given
 * explicitly. An explicit endpoint always wins over a discovered one, which is
 * what lets an operator pin a single URL without giving up discovery for the
 * rest.
 */
export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  /** OIDC issuer. Set this and the endpoints below become optional. */
  issuer?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  jwksUri?: string;
  scope: string;
  /**
   * PKCE S256 on the authorization code. On by default: it costs nothing
   * against a provider that ignores it and removes code interception against
   * one that does not. Set `OAUTH_<NAME>_PKCE=false` for the rare provider
   * that rejects the parameters outright.
   */
  pkce: boolean;
}

/** A provider with its endpoints resolved — what the flow actually uses. */
export interface ResolvedProvider extends OAuthProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
}

export type OAuthConfig = Record<string, OAuthProviderConfig | undefined>;

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

const DEFAULT_ENDPOINTS: Record<BuiltinProvider, Pick<OAuthProviderConfig, 'authorizeUrl' | 'tokenUrl' | 'userInfoUrl' | 'scope'> & { issuer?: string; jwksUri?: string }> = {
  google: {
    issuer: 'https://accounts.google.com',
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
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

/**
 * Read OAuth provider config from the environment.
 *
 * A provider is activated by a client id AND a secret, as before. What is new
 * is that the NAME is no longer a closed set: every `OAUTH_<NAME>_CLIENT_ID`
 * in the environment declares a provider, so
 *
 *   OAUTH_KEYCLOAK_ISSUER=https://sso.customer.example/realms/staff
 *   OAUTH_KEYCLOAK_CLIENT_ID=...
 *   OAUTH_KEYCLOAK_CLIENT_SECRET=...
 *
 * is a working login against that customer's own IdP with no code change. The
 * three built-ins keep their endpoint defaults so existing deployments read
 * exactly as they did.
 *
 * Environment keys are scanned rather than enumerated, which means a typo like
 * `OAUTH_OKTA_CLIENTID` silently declares nothing — hence the boot-time line in
 * `server/index.ts` naming every provider that was actually recognised.
 */
export function oauthConfigFromEnv(env: NodeJS.ProcessEnv): OAuthConfig {
  const names = new Set<string>(BUILTIN_PROVIDERS);
  for (const key of Object.keys(env)) {
    const m = /^OAUTH_([A-Z0-9][A-Z0-9_]*)_CLIENT_ID$/.exec(key);
    if (!m) continue;
    const name = m[1]!.toLowerCase();
    // Two env spellings collapse onto one name (OAUTH_MY_IDP and OAUTH_MY-IDP
    // cannot both exist), so the regex above is the only spelling accepted.
    if (isOAuthProvider(name)) names.add(name);
  }

  const config: OAuthConfig = {};
  for (const provider of [...names].sort()) {
    const up = provider.toUpperCase();
    const clientId = env[`OAUTH_${up}_CLIENT_ID`];
    const clientSecret = env[`OAUTH_${up}_CLIENT_SECRET`];
    if (!clientId || !clientSecret) continue;
    const d = isBuiltinProvider(provider) ? DEFAULT_ENDPOINTS[provider] : undefined;
    const issuer = env[`OAUTH_${up}_ISSUER`] ?? d?.issuer;
    const entry: OAuthProviderConfig = {
      clientId,
      clientSecret,
      scope: env[`OAUTH_${up}_SCOPE`] ?? d?.scope ?? 'openid email profile',
      // Only "false" turns it off; a typo leaves the protection on.
      pkce: env[`OAUTH_${up}_PKCE`] !== 'false',
    };
    if (issuer !== undefined) entry.issuer = issuer;
    const authorizeUrl = env[`OAUTH_${up}_AUTHORIZE_URL`] ?? d?.authorizeUrl;
    if (authorizeUrl !== undefined) entry.authorizeUrl = authorizeUrl;
    const tokenUrl = env[`OAUTH_${up}_TOKEN_URL`] ?? d?.tokenUrl;
    if (tokenUrl !== undefined) entry.tokenUrl = tokenUrl;
    const userInfoUrl = env[`OAUTH_${up}_USERINFO_URL`] ?? d?.userInfoUrl;
    if (userInfoUrl !== undefined) entry.userInfoUrl = userInfoUrl;
    const jwksUri = env[`OAUTH_${up}_JWKS_URI`] ?? d?.jwksUri;
    if (jwksUri !== undefined) entry.jwksUri = jwksUri;

    // Without an issuer there is nothing to discover, so the two endpoints the
    // flow cannot proceed without must be present up front. Caught here, while
    // a human is reading boot output, rather than on the customer's first login.
    if (!entry.issuer && (!entry.authorizeUrl || !entry.tokenUrl)) {
      throw new Error(
        `OAuth provider "${provider}" needs either OAUTH_${up}_ISSUER (for discovery) ` +
          `or both OAUTH_${up}_AUTHORIZE_URL and OAUTH_${up}_TOKEN_URL`,
      );
    }
    config[provider] = entry;
  }
  return config;
}

/**
 * Fill a provider's endpoints in from discovery, leaving explicit values alone.
 *
 * Cached per issuer, so a busy deployment makes one discovery call an hour and
 * not one per login.
 */
export async function resolveProvider(
  cfg: OAuthProviderConfig,
  doFetch: FetchLike,
  cache: OidcCache,
  now: number,
): Promise<ResolvedProvider> {
  let discovered: Awaited<ReturnType<typeof discover>> | undefined;
  const needsDiscovery = !cfg.authorizeUrl || !cfg.tokenUrl || (!cfg.jwksUri && !cfg.userInfoUrl);
  if (cfg.issuer && needsDiscovery) {
    discovered = await discover(cfg.issuer, doFetch as FetchJson, cache, now);
  }
  const authorizeUrl = cfg.authorizeUrl ?? discovered?.authorization_endpoint;
  const tokenUrl = cfg.tokenUrl ?? discovered?.token_endpoint;
  if (!authorizeUrl || !tokenUrl) {
    throw new DomainError(502, 'OAuth provider has no authorize/token endpoint and discovery produced none');
  }
  const resolved: ResolvedProvider = { ...cfg, authorizeUrl, tokenUrl };
  const userInfoUrl = cfg.userInfoUrl ?? discovered?.userinfo_endpoint;
  if (userInfoUrl !== undefined) resolved.userInfoUrl = userInfoUrl;
  const jwksUri = cfg.jwksUri ?? discovered?.jwks_uri;
  if (jwksUri !== undefined) resolved.jwksUri = jwksUri;
  // Discovery is authoritative about the issuer's own spelling.
  if (discovered?.issuer) resolved.issuer = discovered.issuer;
  return resolved;
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

export interface StateRow {
  id: number;
  provider: string;
  state: string;
  org_slug: string | null;
  redirect_uri: string | null;
  code_verifier: string | null;
  nonce: string | null;
  created_at: string;
}

/**
 * Begin an authorization: record a CSRF state nonce bound to the target org,
 * and return the URL the caller should be redirected to. When the provider is
 * configured, that is the provider's real authorize endpoint; otherwise it is
 * our own callback with a deterministic mock code (the offline mock IdP).
 */
export async function beginAuthorize(
  db: Database.Database,
  provider: OAuthProvider,
  opts: {
    orgSlug: string;
    redirectUri: string | null;
    providerConfig?: OAuthProviderConfig;
    selfBaseUrl: string;
    /** Unconfigured provider → offline mock IdP. Off in production. */
    allowMockIdp?: boolean;
    doFetch?: FetchLike;
    cache?: OidcCache;
  },
  now = Date.now(),
): Promise<string> {
  if (!opts.providerConfig && opts.allowMockIdp === false) {
    throw new DomainError(501, `OAuth provider "${provider}" is not configured`);
  }
  const state = randomBytes(16).toString('hex');
  const callbackUri = `${opts.selfBaseUrl}/api/oauth/${provider}/callback`;

  if (!opts.providerConfig) {
    // Mock IdP: bounce back to our own callback with a deterministic code.
    db.prepare(
      `INSERT INTO oauth_states (provider, state, org_slug, redirect_uri, code_verifier, nonce, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
    ).run(provider, state, opts.orgSlug, opts.redirectUri, nowIso(now));
    return `${callbackUri}?${new URLSearchParams({ state, code: `mock-${state}` }).toString()}`;
  }

  const cfg = await resolveProvider(
    opts.providerConfig,
    opts.doFetch ?? (globalThis.fetch as unknown as FetchLike),
    opts.cache ?? new OidcCache(),
    now,
  );
  const wantsOidc = cfg.scope.split(/\s+/).includes('openid');
  const pkce = cfg.pkce ? createPkcePair() : null;
  // A nonce is only meaningful where an ID token will carry it back.
  const nonce = wantsOidc ? randomBytes(16).toString('hex') : null;

  db.prepare(
    `INSERT INTO oauth_states (provider, state, org_slug, redirect_uri, code_verifier, nonce, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(provider, state, opts.orgSlug, opts.redirectUri, pkce?.verifier ?? null, nonce, nowIso(now));

  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: callbackUri,
    response_type: 'code',
    scope: cfg.scope,
    state,
  });
  if (pkce) {
    q.set('code_challenge', pkce.challenge);
    q.set('code_challenge_method', 'S256');
  }
  if (nonce) q.set('nonce', nonce);
  return `${cfg.authorizeUrl}?${q.toString()}`;
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

/**
 * Exchange an authorization code for an identity.
 *
 * Two paths, and which one is taken is decided by what the provider returns.
 * An OIDC provider hands back an `id_token`, which is a signed assertion about
 * WHO authenticated — that is verified (signature, issuer, audience, expiry,
 * nonce) and its claims are believed. A plain OAuth2 provider like GitHub hands
 * back only an access token, so the identity has to be read from `userinfo`,
 * which is a bearer-authenticated fetch and proves rather less.
 *
 * The ID token is preferred wherever both exist, and `userinfo` is consulted
 * afterwards only to fill an address the ID token did not carry.
 */
export async function fetchIdentity(
  cfg: ResolvedProvider,
  code: string,
  redirectUri: string,
  doFetch: FetchLike,
  opts: { codeVerifier?: string | null; nonce?: string | null; cache?: OidcCache; now?: number } = {},
): Promise<ResolvedIdentity> {
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: redirectUri,
  };
  if (opts.codeVerifier) form.code_verifier = opts.codeVerifier;

  const tokenRes = await doFetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status})`);
  const token = (await tokenRes.json()) as { access_token?: string; id_token?: string };
  // An OIDC provider may legitimately return only an id_token; a plain OAuth2
  // one must return an access token or there is nothing to identify with.
  if (!token.access_token && !token.id_token) throw new Error('no access_token in token response');

  let email = '';
  let name = '';
  let subject = '';

  if (typeof token.id_token === 'string' && token.id_token !== '') {
    if (!cfg.jwksUri) {
      // An ID token we cannot check is worse than none: believing it unverified
      // would accept anything the token endpoint's response could be made to say.
      throw new Error('provider returned an id_token but publishes no JWKS to verify it with');
    }
    const claims = await verifyIdToken(token.id_token, {
      issuer: cfg.issuer ?? '',
      audience: cfg.clientId,
      nonce: opts.nonce ?? null,
      jwksUri: cfg.jwksUri,
      doFetch: doFetch as FetchJson,
      cache: opts.cache ?? new OidcCache(),
      now: opts.now ?? Date.now(),
    });
    subject = claims.sub;
    email = typeof claims.email === 'string' ? claims.email : '';
    name =
      (typeof claims.name === 'string' && claims.name) ||
      (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
      '';
  }

  // userinfo: the whole identity for a plain OAuth2 provider, and the fallback
  // for an OIDC one whose ID token carried no address.
  if ((!email || !subject) && cfg.userInfoUrl && token.access_token) {
    const infoRes = await doFetch(cfg.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        Accept: 'application/json',
        'User-Agent': '0815software-ps01',
      },
    });
    if (!infoRes.ok) throw new Error(`userinfo failed (${infoRes.status})`);
    const info = (await infoRes.json()) as Record<string, unknown>;
    const infoSub = String(info.sub ?? info.id ?? '');
    // With a verified ID token in hand, userinfo may only FILL GAPS. A
    // userinfo response that disagrees about the subject is not a better
    // answer, it is a different person — OIDC requires the two to match.
    if (subject && infoSub && infoSub !== subject) {
      throw new Error('userinfo subject does not match the verified id_token subject');
    }
    if (!email) email = String(info.email ?? info.mail ?? info.login ?? '');
    if (!name) name = String(info.name ?? info.login ?? '');
    // Providers that predate OIDC identify a person by whatever they have:
    // `sub`, else a numeric `id`, else the address itself.
    if (!subject) subject = infoSub || email;
  }

  if (!subject) throw new Error('provider returned no subject');
  if (!email) throw new Error('provider returned no email');
  return { email, name: name || email, subject };
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
