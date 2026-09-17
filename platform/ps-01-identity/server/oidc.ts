import { constants, createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import { DomainError } from './errors.js';

/**
 * OpenID Connect: discovery, JWKS, and ID-token verification.
 *
 * PS-01 shipped three hardcoded providers (google, microsoft, github) with
 * hardcoded endpoints, which is exactly the set a customer does NOT have: an
 * enterprise arrives with Entra ID, Okta, Keycloak or a public-sector IdP and
 * has nowhere to put it. This module is what makes `OAUTH_<NAME>_ISSUER=...`
 * enough to configure any compliant provider.
 *
 * Built on `node:crypto` only, like the rest of the service. That is a real
 * constraint for JWT verification and it is why the algorithm handling below
 * is explicit rather than a lookup into a library: every accepted `alg` is
 * named here, and everything else — `none` and the HMAC family especially —
 * is refused before a key is ever loaded.
 */

// ── Base64url ──────────────────────────────────────────────────────────

export function b64uDecode(input: string): Buffer {
  // Reject anything outside the base64url alphabet rather than letting
  // Buffer silently drop it: "ab$cd" and "abcd" must not decode alike.
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new Error('not base64url');
  return Buffer.from(input, 'base64url');
}

export function b64uEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

// ── PKCE ───────────────────────────────────────────────────────────────

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * RFC 7636 S256. The verifier stays in our database and travels only on the
 * back-channel token request; the challenge is what goes through the browser.
 * An attacker who intercepts the authorization code therefore cannot redeem
 * it, which is the whole point for a public-ish redirect flow.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: b64uEncode(createHash('sha256').update(verifier).digest()) };
}

// ── Discovery ──────────────────────────────────────────────────────────

export interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
  end_session_endpoint?: string;
}

export type FetchJson = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

/** Discovery documents and key sets are cached for an hour by default. */
export const DISCOVERY_TTL_MS = 60 * 60_000;
/**
 * How often an unknown `kid` may force a JWKS refetch. Without a floor, a
 * token carrying a random kid is an unauthenticated request amplifier
 * pointed at the IdP — one inbound callback, one outbound key fetch.
 */
export const JWKS_REFETCH_MIN_INTERVAL_MS = 60_000;

export class OidcCache {
  private readonly discovery = new Map<string, CacheEntry<OidcMetadata>>();
  private readonly jwks = new Map<string, CacheEntry<Jwk[]>>();

  getDiscovery(issuer: string, now: number, ttl = DISCOVERY_TTL_MS): OidcMetadata | undefined {
    const hit = this.discovery.get(issuer);
    return hit && now - hit.fetchedAt < ttl ? hit.value : undefined;
  }

  setDiscovery(issuer: string, value: OidcMetadata, now: number): void {
    this.discovery.set(issuer, { value, fetchedAt: now });
  }

  getJwks(uri: string): { keys: Jwk[]; fetchedAt: number } | undefined {
    const hit = this.jwks.get(uri);
    return hit ? { keys: hit.value, fetchedAt: hit.fetchedAt } : undefined;
  }

  setJwks(uri: string, keys: Jwk[], now: number): void {
    this.jwks.set(uri, { value: keys, fetchedAt: now });
  }
}

function requireHttps(url: string, what: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DomainError(502, `${what} is not a valid URL`);
  }
  // http is tolerated only for loopback, which is how a local Keycloak or a
  // test IdP is reached. Anywhere else an unencrypted endpoint would put the
  // token exchange — client secret included — on the wire in clear.
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new DomainError(502, `${what} must be https (or loopback http)`);
  }
  return parsed.toString();
}

/**
 * Fetch and validate `<issuer>/.well-known/openid-configuration`.
 *
 * The `issuer` in the document must equal the issuer we were configured with.
 * That check is not ceremony: without it a provider (or anything that can
 * answer for its hostname) can hand back another issuer's endpoints, and the
 * ID token we later validate would be checked against the attacker's issuer
 * rather than the one the operator chose — the IdP mix-up attack.
 */
export async function discover(
  issuer: string,
  doFetch: FetchJson,
  cache: OidcCache,
  now: number,
): Promise<OidcMetadata> {
  const cached = cache.getDiscovery(issuer, now);
  if (cached) return cached;

  const base = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
  const url = `${base}/.well-known/openid-configuration`;
  requireHttps(url, 'issuer');

  const res = await doFetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new DomainError(502, `OIDC discovery failed (${res.status})`);
  const doc = (await res.json()) as Record<string, unknown>;

  const got = typeof doc.issuer === 'string' ? doc.issuer : '';
  // Compare with the trailing slash normalised away; providers disagree about
  // it and RFC 8414 does not settle the argument.
  const norm = (s: string): string => (s.endsWith('/') ? s.slice(0, -1) : s);
  if (norm(got) !== norm(issuer)) {
    throw new DomainError(502, `OIDC discovery issuer mismatch: configured ${issuer}, document says ${got || '(none)'}`);
  }
  const authorize = typeof doc.authorization_endpoint === 'string' ? doc.authorization_endpoint : '';
  const token = typeof doc.token_endpoint === 'string' ? doc.token_endpoint : '';
  if (!authorize || !token) throw new DomainError(502, 'OIDC discovery document is missing required endpoints');

  const meta: OidcMetadata = {
    issuer: got,
    authorization_endpoint: requireHttps(authorize, 'authorization_endpoint'),
    token_endpoint: requireHttps(token, 'token_endpoint'),
    userinfo_endpoint:
      typeof doc.userinfo_endpoint === 'string' ? requireHttps(doc.userinfo_endpoint, 'userinfo_endpoint') : undefined,
    jwks_uri: typeof doc.jwks_uri === 'string' ? requireHttps(doc.jwks_uri, 'jwks_uri') : undefined,
    end_session_endpoint: typeof doc.end_session_endpoint === 'string' ? doc.end_session_endpoint : undefined,
  };
  cache.setDiscovery(issuer, meta, now);
  return meta;
}

// ── JWKS ───────────────────────────────────────────────────────────────

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

async function loadJwks(uri: string, doFetch: FetchJson, cache: OidcCache, now: number): Promise<Jwk[]> {
  const res = await doFetch(uri, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new DomainError(502, `JWKS fetch failed (${res.status})`);
  const doc = (await res.json()) as { keys?: unknown };
  if (!Array.isArray(doc.keys)) throw new DomainError(502, 'JWKS document has no keys array');
  const keys = doc.keys.filter((k): k is Jwk => typeof k === 'object' && k !== null && typeof (k as Jwk).kty === 'string');
  cache.setJwks(uri, keys, now);
  return keys;
}

/**
 * Resolve the signing key for a token header, refetching once if the `kid` is
 * unknown — which is what an ordinary key rotation looks like from here.
 */
export async function resolveKey(
  uri: string,
  header: { kid?: string; alg: string },
  doFetch: FetchJson,
  cache: OidcCache,
  now: number,
): Promise<Jwk> {
  const pick = (keys: Jwk[]): Jwk | undefined => {
    const usable = keys.filter((k) => (k.use === undefined || k.use === 'sig') && (k.alg === undefined || k.alg === header.alg));
    if (header.kid) return usable.find((k) => k.kid === header.kid);
    // No kid: only unambiguous when the provider publishes exactly one usable
    // key. Guessing among several is how you end up verifying against whatever
    // key happens to be listed first.
    return usable.length === 1 ? usable[0] : undefined;
  };

  const cached = cache.getJwks(uri);
  if (cached) {
    const hit = pick(cached.keys);
    if (hit) return hit;
    if (now - cached.fetchedAt < JWKS_REFETCH_MIN_INTERVAL_MS) {
      throw new DomainError(401, 'ID token signing key is not published by the provider');
    }
  }
  const hit = pick(await loadJwks(uri, doFetch, cache, now));
  if (!hit) throw new DomainError(401, 'ID token signing key is not published by the provider');
  return hit;
}

// ── JWT verification ───────────────────────────────────────────────────

/**
 * Asymmetric algorithms only, and every one of them named explicitly.
 *
 * `none` is the classic forgery. The HMAC family is the subtler one: `HS256`
 * verified against a JWKS entry would let anyone who can read the provider's
 * PUBLIC key sign a token we accept, because for HMAC the verification key IS
 * the signing key. Neither is in this table, so neither can be reached.
 */
const ALGS: Record<string, { hash: string; options: Record<string, unknown> }> = {
  RS256: { hash: 'sha256', options: { padding: constants.RSA_PKCS1_PADDING } },
  RS384: { hash: 'sha384', options: { padding: constants.RSA_PKCS1_PADDING } },
  RS512: { hash: 'sha512', options: { padding: constants.RSA_PKCS1_PADDING } },
  PS256: { hash: 'sha256', options: { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } },
  PS384: { hash: 'sha384', options: { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } },
  PS512: { hash: 'sha512', options: { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } },
  // JOSE ECDSA signatures are raw r||s; Node speaks DER unless told otherwise.
  ES256: { hash: 'sha256', options: { dsaEncoding: 'ieee-p1363' } },
  ES384: { hash: 'sha384', options: { dsaEncoding: 'ieee-p1363' } },
  ES512: { hash: 'sha512', options: { dsaEncoding: 'ieee-p1363' } },
};

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  azp?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  [claim: string]: unknown;
}

/** Tolerance for clock drift between us and the IdP, in seconds. */
export const CLOCK_SKEW_SEC = 120;

export interface VerifyIdTokenOptions {
  issuer: string;
  audience: string;
  nonce?: string | null;
  jwksUri: string;
  doFetch: FetchJson;
  cache: OidcCache;
  now: number;
}

/**
 * Verify an ID token end to end: signature, then every claim that binds it to
 * this login. Returns the claims; throws `DomainError(401)` otherwise.
 */
export async function verifyIdToken(idToken: string, opts: VerifyIdTokenOptions): Promise<IdTokenClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new DomainError(401, 'ID token is malformed');
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

  let header: { alg?: unknown; kid?: unknown; typ?: unknown };
  let claims: IdTokenClaims;
  try {
    header = JSON.parse(b64uDecode(rawHeader).toString('utf8')) as typeof header;
    claims = JSON.parse(b64uDecode(rawPayload).toString('utf8')) as IdTokenClaims;
  } catch {
    throw new DomainError(401, 'ID token is malformed');
  }

  const alg = typeof header.alg === 'string' ? header.alg : '';
  const spec = ALGS[alg];
  if (!spec) throw new DomainError(401, `ID token algorithm is not accepted: ${alg || '(none)'}`);

  const jwk = await resolveKey(
    opts.jwksUri,
    { kid: typeof header.kid === 'string' ? header.kid : undefined, alg },
    opts.doFetch,
    opts.cache,
    opts.now,
  );

  let key;
  try {
    key = createPublicKey({ key: jwk as never, format: 'jwk' });
  } catch {
    throw new DomainError(401, 'ID token signing key is unusable');
  }
  // A JWKS entry is a public key, but say so rather than trust it: a private
  // or symmetric key reaching this call would change what verification means.
  if (key.type !== 'public') throw new DomainError(401, 'ID token signing key is not a public key');

  const signed = Buffer.from(`${rawHeader}.${rawPayload}`, 'ascii');
  let signature: Buffer;
  try {
    signature = b64uDecode(rawSignature);
  } catch {
    throw new DomainError(401, 'ID token is malformed');
  }
  const ok = cryptoVerify(spec.hash, signed, { key, ...spec.options } as never, signature);
  if (!ok) throw new DomainError(401, 'ID token signature is invalid');

  // ── Claims ──
  const norm = (s: string): string => (s.endsWith('/') ? s.slice(0, -1) : s);
  if (typeof claims.iss !== 'string' || norm(claims.iss) !== norm(opts.issuer)) {
    throw new DomainError(401, 'ID token issuer does not match the configured provider');
  }
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new DomainError(401, 'ID token has no subject');

  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.some((a) => typeof a === 'string' && a === opts.audience)) {
    throw new DomainError(401, 'ID token audience does not match this client');
  }
  // With more than one audience the spec requires azp, and it must be us —
  // otherwise a token minted for a different client of the same IdP would pass.
  if (auds.length > 1 && claims.azp !== opts.audience) {
    throw new DomainError(401, 'ID token azp does not match this client');
  }

  const nowSec = Math.floor(opts.now / 1000);
  if (typeof claims.exp !== 'number' || nowSec >= claims.exp + CLOCK_SKEW_SEC) {
    throw new DomainError(401, 'ID token has expired');
  }
  if (typeof claims.iat !== 'number' || claims.iat > nowSec + CLOCK_SKEW_SEC) {
    throw new DomainError(401, 'ID token was issued in the future');
  }
  if (typeof claims.nbf === 'number' && nowSec + CLOCK_SKEW_SEC < claims.nbf) {
    throw new DomainError(401, 'ID token is not valid yet');
  }

  // The nonce binds this token to the authorize request we started. Compared
  // in constant time because it is a secret we minted and are re-recognising.
  if (opts.nonce) {
    const got = typeof claims.nonce === 'string' ? claims.nonce : '';
    const a = Buffer.from(got, 'utf8');
    const b = Buffer.from(opts.nonce, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new DomainError(401, 'ID token nonce does not match this login');
    }
  }
  return claims;
}
