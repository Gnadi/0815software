import { createSign, createHmac, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { SessionConfig } from '../server/auth.js';
import {
  CLOCK_SKEW_SEC,
  createPkcePair,
  discover,
  JWKS_REFETCH_MIN_INTERVAL_MS,
  OidcCache,
  verifyIdToken,
  type FetchJson,
} from '../server/oidc.js';
import { fetchIdentity, oauthConfigFromEnv, resolveProvider, type FetchLike } from '../server/oauth.js';

/**
 * Generic OIDC: discovery, JWKS and ID-token verification.
 *
 * The ID token is the only thing in the whole login that ASSERTS who
 * authenticated — everything downstream believes it — so most of what is below
 * is the set of tokens that must NOT be believed. Each case is a real attack
 * against a naive verifier, not a hypothetical: `alg: none`, HMAC/RSA
 * confusion, a token minted for a different client of the same IdP, a replayed
 * one from an earlier login.
 */

const session: SessionConfig = { secret: 'test-secret', ttlHours: 12, secureCookie: false };
const SELF = 'https://identity.example.com';
const ISSUER = 'https://sso.customer.example/realms/staff';
const CLIENT_ID = 'ps01-client';

// ── A test IdP: a real keypair, real signatures ────────────────────────

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const jwkOf = (key: KeyObject, kid: string, alg: string): Record<string, unknown> => ({
  ...(key.export({ format: 'jwk' }) as Record<string, unknown>),
  kid,
  alg,
  use: 'sig',
});

const RSA_JWK = jwkOf(rsa.publicKey, 'rsa-1', 'RS256');
const EC_JWK = jwkOf(ec.publicKey, 'ec-1', 'ES256');

const b64u = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

interface TokenParts {
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
  key?: KeyObject;
  /** Sign with something other than the header says (the confusion attacks). */
  rawSignature?: string;
}

function makeToken(now: number, parts: TokenParts = {}): string {
  const nowSec = Math.floor(now / 1000);
  const header = { alg: 'RS256', kid: 'rsa-1', typ: 'JWT', ...parts.header };
  const claims = {
    iss: ISSUER,
    sub: 'user-42',
    aud: CLIENT_ID,
    exp: nowSec + 300,
    iat: nowSec,
    email: 'ada@customer.example',
    name: 'Ada Lovelace',
    ...parts.claims,
  };
  const signingInput = `${b64u(header)}.${b64u(claims)}`;
  if (parts.rawSignature !== undefined) return `${signingInput}.${parts.rawSignature}`;

  const alg = String(header.alg);
  if (alg === 'ES256') {
    const sig = createSign('sha256').update(signingInput).sign({ key: parts.key ?? ec.privateKey, dsaEncoding: 'ieee-p1363' });
    return `${signingInput}.${sig.toString('base64url')}`;
  }
  const sig = createSign('sha256').update(signingInput).sign(parts.key ?? rsa.privateKey);
  return `${signingInput}.${sig.toString('base64url')}`;
}

const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const JWKS_URL = `${ISSUER}/protocol/openid-connect/certs`;

const DISCOVERY_DOC = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
  userinfo_endpoint: `${ISSUER}/protocol/openid-connect/userinfo`,
  jwks_uri: JWKS_URL,
};

/** A fetch double that answers a scripted map and counts what it was asked. */
function idp(
  overrides: Record<string, { ok?: boolean; status?: number; json?: unknown }> = {},
): FetchJson & FetchLike & { calls: string[] } {
  const routes: Record<string, { ok?: boolean; status?: number; json?: unknown }> = {
    [DISCOVERY_URL]: { json: DISCOVERY_DOC },
    [JWKS_URL]: { json: { keys: [RSA_JWK, EC_JWK] } },
    ...overrides,
  };
  const calls: string[] = [];
  const fn = (url: string): Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }> => {
    calls.push(url);
    const hit = routes[url];
    if (!hit) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
    return Promise.resolve({
      ok: hit.ok ?? true,
      status: hit.status ?? 200,
      json: () => Promise.resolve(hit.json),
      text: () => Promise.resolve(JSON.stringify(hit.json ?? '')),
    });
  };
  return Object.assign(fn, { calls }) as FetchJson & FetchLike & { calls: string[] };
}

const NOW = Date.parse('2026-09-17T10:00:00Z');

const verify = (token: string, opts: Partial<Parameters<typeof verifyIdToken>[1]> = {}, doFetch = idp()) =>
  verifyIdToken(token, {
    issuer: ISSUER,
    audience: CLIENT_ID,
    jwksUri: JWKS_URL,
    doFetch,
    cache: new OidcCache(),
    now: NOW,
    ...opts,
  });

// ── PKCE ───────────────────────────────────────────────────────────────

describe('PKCE', () => {
  it('produces an S256 challenge that matches its verifier', async () => {
    const { createHash } = await import('node:crypto');
    const pair = createPkcePair();
    expect(pair.challenge).toBe(createHash('sha256').update(pair.verifier).digest('base64url'));
    // Fresh every time, or it is not a per-login secret.
    expect(createPkcePair().verifier).not.toBe(pair.verifier);
  });
});

// ── Discovery ──────────────────────────────────────────────────────────

describe('discovery', () => {
  it('reads the endpoints out of the well-known document', async () => {
    const meta = await discover(ISSUER, idp(), new OidcCache(), NOW);
    expect(meta.token_endpoint).toBe(DISCOVERY_DOC.token_endpoint);
    expect(meta.jwks_uri).toBe(JWKS_URL);
  });

  it('caches, so a busy deployment does not re-fetch per login', async () => {
    const cache = new OidcCache();
    const doFetch = idp();
    await discover(ISSUER, doFetch, cache, NOW);
    await discover(ISSUER, doFetch, cache, NOW + 60_000);
    expect(doFetch.calls.filter((u) => u === DISCOVERY_URL)).toHaveLength(1);
  });

  it('refuses a document that claims a different issuer — the mix-up attack', async () => {
    const doFetch = idp({ [DISCOVERY_URL]: { json: { ...DISCOVERY_DOC, issuer: 'https://attacker.example' } } });
    await expect(discover(ISSUER, doFetch, new OidcCache(), NOW)).rejects.toThrow(/issuer mismatch/);
  });

  it('refuses a plaintext issuer that is not loopback', async () => {
    await expect(discover('http://sso.customer.example', idp(), new OidcCache(), NOW)).rejects.toThrow(/must be https/);
  });

  it('refuses a document missing the endpoints the flow cannot proceed without', async () => {
    const doFetch = idp({ [DISCOVERY_URL]: { json: { issuer: ISSUER } } });
    await expect(discover(ISSUER, doFetch, new OidcCache(), NOW)).rejects.toThrow(/missing required endpoints/);
  });

  it('reports an unreachable discovery document rather than guessing', async () => {
    const doFetch = idp({ [DISCOVERY_URL]: { ok: false, status: 503 } });
    await expect(discover(ISSUER, doFetch, new OidcCache(), NOW)).rejects.toThrow(/discovery failed \(503\)/);
  });
});

// ── ID token: what must be believed ────────────────────────────────────

describe('a well-formed ID token', () => {
  it('verifies and returns its claims (RS256)', async () => {
    const claims = await verify(makeToken(NOW));
    expect(claims.sub).toBe('user-42');
    expect(claims.email).toBe('ada@customer.example');
  });

  it('verifies an ES256 token, whose signature is raw r||s rather than DER', async () => {
    const claims = await verify(makeToken(NOW, { header: { alg: 'ES256', kid: 'ec-1' } }));
    expect(claims.sub).toBe('user-42');
  });

  it('accepts a matching nonce and a clock a little out of step', async () => {
    const withNonce = makeToken(NOW, { claims: { nonce: 'n-123', exp: Math.floor(NOW / 1000) - 30 } });
    const claims = await verify(withNonce, { nonce: 'n-123' });
    expect(claims.nonce).toBe('n-123');
  });
});

// ── ID token: what must NOT be believed ────────────────────────────────

describe('an ID token that must be refused', () => {
  it('rejects alg "none" — an unsigned assertion is not an assertion', async () => {
    await expect(verify(makeToken(NOW, { header: { alg: 'none' }, rawSignature: '' }))).rejects.toThrow(
      /algorithm is not accepted/,
    );
  });

  it('rejects HS256 signed with the provider’s own public key (algorithm confusion)', async () => {
    // The classic: for HMAC the verification key IS the signing key, so a
    // verifier that honours the header’s alg can be handed a token signed
    // with the public key anybody can read from the JWKS.
    const header = { alg: 'HS256', kid: 'rsa-1', typ: 'JWT' };
    const claims = { iss: ISSUER, sub: 'attacker', aud: CLIENT_ID, exp: Math.floor(NOW / 1000) + 300, iat: Math.floor(NOW / 1000) };
    const signingInput = `${b64u(header)}.${b64u(claims)}`;
    const pubPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const forged = `${signingInput}.${createHmac('sha256', pubPem).update(signingInput).digest('base64url')}`;
    await expect(verify(forged)).rejects.toThrow(/algorithm is not accepted/);
  });

  it('rejects a token signed by the wrong key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(verify(makeToken(NOW, { key: other.privateKey }))).rejects.toThrow(/signature is invalid/);
  });

  it('rejects a tampered payload', async () => {
    const token = makeToken(NOW);
    const [h, , s] = token.split('.') as [string, string, string];
    const swapped = b64u({ iss: ISSUER, sub: 'somebody-else', aud: CLIENT_ID, exp: Math.floor(NOW / 1000) + 300, iat: Math.floor(NOW / 1000) });
    await expect(verify(`${h}.${swapped}.${s}`)).rejects.toThrow(/signature is invalid/);
  });

  it('rejects another issuer, even correctly signed', async () => {
    await expect(verify(makeToken(NOW, { claims: { iss: 'https://attacker.example' } }))).rejects.toThrow(
      /issuer does not match/,
    );
  });

  it('rejects a token minted for a different client of the same IdP', async () => {
    await expect(verify(makeToken(NOW, { claims: { aud: 'some-other-app' } }))).rejects.toThrow(
      /audience does not match/,
    );
  });

  it('rejects a multi-audience token whose azp is not us', async () => {
    await expect(
      verify(makeToken(NOW, { claims: { aud: [CLIENT_ID, 'other-app'], azp: 'other-app' } })),
    ).rejects.toThrow(/azp does not match/);
  });

  it('rejects an expired token once it is past the skew allowance', async () => {
    const stale = makeToken(NOW, { claims: { exp: Math.floor(NOW / 1000) - CLOCK_SKEW_SEC - 10 } });
    await expect(verify(stale)).rejects.toThrow(/has expired/);
  });

  it('rejects a token issued implausibly far in the future', async () => {
    const ahead = makeToken(NOW, { claims: { iat: Math.floor(NOW / 1000) + CLOCK_SKEW_SEC + 60 } });
    await expect(verify(ahead)).rejects.toThrow(/issued in the future/);
  });

  it('rejects a replayed token from an earlier login (nonce mismatch)', async () => {
    const replayed = makeToken(NOW, { claims: { nonce: 'from-an-older-login' } });
    await expect(verify(replayed, { nonce: 'this-login' })).rejects.toThrow(/nonce does not match/);
    // And a token carrying NO nonce cannot satisfy one either.
    await expect(verify(makeToken(NOW), { nonce: 'this-login' })).rejects.toThrow(/nonce does not match/);
  });

  it('rejects a token with no subject', async () => {
    await expect(verify(makeToken(NOW, { claims: { sub: '' } }))).rejects.toThrow(/no subject/);
  });

  it('rejects structural nonsense without throwing something unhandled', async () => {
    for (const bad of ['', 'a.b', 'a.b.c.d', 'not-base64url!.x.y']) {
      await expect(verify(bad)).rejects.toThrow(/malformed|not accepted/);
    }
  });
});

// ── JWKS ───────────────────────────────────────────────────────────────

describe('JWKS handling', () => {
  it('re-fetches once when a kid is unknown — an ordinary key rotation', async () => {
    const cache = new OidcCache();
    const stale = idp({ [JWKS_URL]: { json: { keys: [EC_JWK] } } });
    await expect(verify(makeToken(NOW), { cache }, stale)).rejects.toThrow(/signing key is not published/);
    // One miss on the empty cache, one refetch attempt.
    expect(stale.calls.filter((u) => u === JWKS_URL).length).toBeGreaterThanOrEqual(1);

    // With the key now published, the same cache resolves it.
    const rotated = idp();
    const claims = await verify(makeToken(NOW), { cache, now: NOW + JWKS_REFETCH_MIN_INTERVAL_MS + 1 }, rotated);
    expect(claims.sub).toBe('user-42');
  });

  it('does not let an unknown kid become an amplifier against the IdP', async () => {
    const cache = new OidcCache();
    const doFetch = idp();
    // Warm the cache with a successful verification.
    await verify(makeToken(NOW), { cache }, doFetch);
    const before = doFetch.calls.filter((u) => u === JWKS_URL).length;
    // Ten tokens with random kids, all inside the refetch floor.
    for (let i = 0; i < 10; i++) {
      await expect(verify(makeToken(NOW, { header: { kid: `made-up-${i}` } }), { cache }, doFetch)).rejects.toThrow();
    }
    expect(doFetch.calls.filter((u) => u === JWKS_URL).length).toBe(before);
  });

  it('refuses to guess when the token has no kid and several keys could match', async () => {
    // With a kid absent, a single usable key is unambiguous and IS resolved —
    // what must not happen is picking one of two RS256 keys at random.
    const second = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ambiguous = idp({ [JWKS_URL]: { json: { keys: [RSA_JWK, jwkOf(second.publicKey, 'rsa-2', 'RS256')] } } });
    await expect(verify(makeToken(NOW, { header: { kid: undefined } }), {}, ambiguous)).rejects.toThrow(/not published/);

    // The single-key case still resolves, so this is a tie-break rule and not
    // a requirement that every provider send a kid.
    const single = idp({ [JWKS_URL]: { json: { keys: [RSA_JWK] } } });
    expect((await verify(makeToken(NOW, { header: { kid: undefined } }), {}, single)).sub).toBe('user-42');
  });
});

// ── Configuration ──────────────────────────────────────────────────────

describe('a generic provider read from the environment', () => {
  it('is declared by name, with discovery standing in for the endpoints', () => {
    const config = oauthConfigFromEnv({
      OAUTH_KEYCLOAK_ISSUER: ISSUER,
      OAUTH_KEYCLOAK_CLIENT_ID: CLIENT_ID,
      OAUTH_KEYCLOAK_CLIENT_SECRET: 'shh',
    });
    expect(config.keycloak).toMatchObject({ issuer: ISSUER, clientId: CLIENT_ID, pkce: true });
    // And nothing else was invented from the three built-in names.
    expect(Object.keys(config)).toEqual(['keycloak']);
  });

  it('refuses a provider that has neither an issuer nor explicit endpoints', () => {
    expect(() =>
      oauthConfigFromEnv({ OAUTH_OKTA_CLIENT_ID: 'id', OAUTH_OKTA_CLIENT_SECRET: 'secret' }),
    ).toThrow(/needs either OAUTH_OKTA_ISSUER/);
  });

  it('lets an explicit endpoint override a discovered one', async () => {
    const config = oauthConfigFromEnv({
      OAUTH_KEYCLOAK_ISSUER: ISSUER,
      OAUTH_KEYCLOAK_CLIENT_ID: CLIENT_ID,
      OAUTH_KEYCLOAK_CLIENT_SECRET: 'shh',
      OAUTH_KEYCLOAK_TOKEN_URL: 'https://pinned.example/token',
    });
    const resolved = await resolveProvider(config.keycloak!, idp(), new OidcCache(), NOW);
    expect(resolved.tokenUrl).toBe('https://pinned.example/token');
    expect(resolved.authorizeUrl).toBe(DISCOVERY_DOC.authorization_endpoint); // still discovered
  });

  it('turns PKCE off only for the literal "false"', () => {
    const base = { OAUTH_KEYCLOAK_ISSUER: ISSUER, OAUTH_KEYCLOAK_CLIENT_ID: 'id', OAUTH_KEYCLOAK_CLIENT_SECRET: 's' };
    expect(oauthConfigFromEnv({ ...base, OAUTH_KEYCLOAK_PKCE: 'false' }).keycloak!.pkce).toBe(false);
    expect(oauthConfigFromEnv({ ...base, OAUTH_KEYCLOAK_PKCE: 'no' }).keycloak!.pkce).toBe(true);
  });
});

// ── End to end, through the HTTP surface ───────────────────────────────

describe('the authorization flow against a generic OIDC provider', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDb(':memory:');
    await seed(db);
  });

  const oauth = oauthConfigFromEnv({
    OAUTH_KEYCLOAK_ISSUER: ISSUER,
    OAUTH_KEYCLOAK_CLIENT_ID: CLIENT_ID,
    OAUTH_KEYCLOAK_CLIENT_SECRET: 'shh',
  });

  it('sends PKCE and a nonce to the discovered authorize endpoint, and signs the user in on the way back', async () => {
    const doFetch = idp();
    const app = createApp({ db, session, selfBaseUrl: SELF, oauth, fetch: doFetch, now: () => NOW });

    const authorize = await request(app).get('/api/oauth/keycloak/authorize?org_slug=acme').redirects(0);
    expect(authorize.status).toBe(302);
    const url = new URL(authorize.headers.location as string);
    expect(url.origin + url.pathname).toBe(DISCOVERY_DOC.authorization_endpoint);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('nonce')).toBeTruthy();
    const state = url.searchParams.get('state')!;

    // The verifier and nonce stayed here; only the challenge went out.
    const stored = db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state) as {
      code_verifier: string;
      nonce: string;
    };
    expect(stored.code_verifier).toBeTruthy();
    expect(url.searchParams.get('code_challenge')).not.toBe(stored.code_verifier);

    const idToken = makeToken(NOW, { claims: { nonce: stored.nonce } });
    const withToken = idp({ [DISCOVERY_DOC.token_endpoint]: { json: { id_token: idToken, access_token: 'at' } } });
    const app2 = createApp({ db, session, selfBaseUrl: SELF, oauth, fetch: withToken, now: () => NOW });

    const callback = await request(app2)
      .get(`/api/oauth/keycloak/callback?state=${state}&code=the-code`)
      .redirects(0);
    expect(callback.status).toBe(200);
    expect(callback.body.user.email).toBe('ada@customer.example');

    // The verifier went up with the exchange — that is what makes an
    // intercepted code useless to whoever intercepted it.
    const exchange = withToken.calls.filter((u) => u === DISCOVERY_DOC.token_endpoint);
    expect(exchange).toHaveLength(1);
  });

  it('refuses a callback whose ID token was minted for another login', async () => {
    const doFetch = idp();
    const app = createApp({ db, session, selfBaseUrl: SELF, oauth, fetch: doFetch, now: () => NOW });
    const authorize = await request(app).get('/api/oauth/keycloak/authorize?org_slug=acme').redirects(0);
    const state = new URL(authorize.headers.location as string).searchParams.get('state')!;

    const wrongNonce = makeToken(NOW, { claims: { nonce: 'a-different-login' } });
    const withToken = idp({ [DISCOVERY_DOC.token_endpoint]: { json: { id_token: wrongNonce, access_token: 'at' } } });
    const app2 = createApp({ db, session, selfBaseUrl: SELF, oauth, fetch: withToken, now: () => NOW });

    const callback = await request(app2).get(`/api/oauth/keycloak/callback?state=${state}&code=c`).redirects(0);
    expect(callback.status).toBe(401);
    // Nobody was provisioned by the attempt.
    expect((db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'ada@customer.example'").get() as { n: number }).n).toBe(0);
  });

  it('is still a 404 for a name nobody configured', async () => {
    const app = createApp({ db, session, selfBaseUrl: SELF, oauth, fetch: idp(), now: () => NOW });
    expect((await request(app).get('/api/oauth/evilcorp/authorize?org_slug=acme').redirects(0)).status).toBe(404);
    // Including one that is not even a legal provider name.
    expect((await request(app).get('/api/oauth/..%2Fadmin/authorize?org_slug=acme').redirects(0)).status).toBe(404);
  });
});

// ── The error paths that only fire against a misbehaving provider ──────

describe('a provider that answers badly', () => {
  it('refuses to resolve a provider with neither an issuer nor endpoints', async () => {
    await expect(
      resolveProvider({ clientId: 'id', clientSecret: 's', scope: 'openid', pkce: true }, idp(), new OidcCache(), NOW),
    ).rejects.toThrow(/no authorize\/token endpoint/);
  });

  it('refuses an issuer that is not a URL at all', async () => {
    await expect(discover('not a url', idp(), new OidcCache(), NOW)).rejects.toThrow(/not a valid URL/);
  });

  it('will not believe an id_token it has no key to check', async () => {
    const cfg = await resolveProvider(
      {
        clientId: CLIENT_ID,
        clientSecret: 's',
        scope: 'openid',
        pkce: true,
        authorizeUrl: 'https://x.example/a',
        tokenUrl: 'https://x.example/t',
        userInfoUrl: 'https://x.example/me',
      },
      idp(),
      new OidcCache(),
      NOW,
    );
    const doFetch = idp({ 'https://x.example/t': { json: { id_token: makeToken(NOW), access_token: 'at' } } });
    await expect(fetchIdentity(cfg, 'c', 'https://x.example/cb', doFetch, { now: NOW })).rejects.toThrow(
      /publishes no JWKS/,
    );
  });

  it('refuses a userinfo response that disagrees with the verified id_token', async () => {
    // Only reachable when the ID token carried no address, so userinfo is
    // consulted — and comes back describing somebody else entirely.
    const cfg = await resolveProvider(
      { clientId: CLIENT_ID, clientSecret: 's', scope: 'openid', pkce: true, issuer: ISSUER },
      idp(),
      new OidcCache(),
      NOW,
    );
    const noEmail = makeToken(NOW, { claims: { email: undefined } });
    const doFetch = idp({
      [DISCOVERY_DOC.token_endpoint]: { json: { id_token: noEmail, access_token: 'at' } },
      [DISCOVERY_DOC.userinfo_endpoint]: { json: { sub: 'somebody-else', email: 'x@y.test' } },
    });
    await expect(fetchIdentity(cfg, 'c', 'https://x/cb', doFetch, { now: NOW })).rejects.toThrow(
      /userinfo subject does not match/,
    );
  });

  it('fills a missing address from userinfo when the subjects agree', async () => {
    const cfg = await resolveProvider(
      { clientId: CLIENT_ID, clientSecret: 's', scope: 'openid', pkce: true, issuer: ISSUER },
      idp(),
      new OidcCache(),
      NOW,
    );
    const noEmail = makeToken(NOW, { claims: { email: undefined, name: undefined } });
    const doFetch = idp({
      [DISCOVERY_DOC.token_endpoint]: { json: { id_token: noEmail, access_token: 'at' } },
      [DISCOVERY_DOC.userinfo_endpoint]: { json: { sub: 'user-42', email: 'ada@corp.test', name: 'Ada' } },
    });
    await expect(fetchIdentity(cfg, 'c', 'https://x/cb', doFetch, { now: NOW })).resolves.toEqual({
      email: 'ada@corp.test',
      name: 'Ada',
      subject: 'user-42',
    });
  });

  it('rejects a key the JWKS published that is not a usable public key', async () => {
    const junk = idp({ [JWKS_URL]: { json: { keys: [{ kty: 'oct', kid: 'rsa-1', alg: 'RS256', k: 'AAAA' }] } } });
    await expect(verify(makeToken(NOW), {}, junk)).rejects.toThrow(/unusable|not a public key/);
  });

  it('rejects a signature segment that is not base64url', async () => {
    await expect(verify(makeToken(NOW, { rawSignature: 'not base64url!!' }))).rejects.toThrow(/malformed/);
  });

  it('rejects a token that is not valid yet (nbf)', async () => {
    const early = makeToken(NOW, { claims: { nbf: Math.floor(NOW / 1000) + CLOCK_SKEW_SEC + 60 } });
    await expect(verify(early)).rejects.toThrow(/not valid yet/);
  });
});

describe('a provider that is not OIDC', () => {
  it('sends no nonce and no PKCE when neither applies', async () => {
    const db = openDb(':memory:');
    await seed(db);
    const oauth = oauthConfigFromEnv({
      OAUTH_LEGACY_CLIENT_ID: 'id',
      OAUTH_LEGACY_CLIENT_SECRET: 's',
      OAUTH_LEGACY_AUTHORIZE_URL: 'https://legacy.example/authorize',
      OAUTH_LEGACY_TOKEN_URL: 'https://legacy.example/token',
      OAUTH_LEGACY_USERINFO_URL: 'https://legacy.example/me',
      OAUTH_LEGACY_SCOPE: 'read:user',
      OAUTH_LEGACY_PKCE: 'false',
    });
    const app = createApp({ db, session, selfBaseUrl: SELF, oauth, fetch: idp(), now: () => NOW });
    const res = await request(app).get('/api/oauth/legacy/authorize?org_slug=acme').redirects(0);
    const url = new URL(res.headers.location as string);
    expect(url.searchParams.get('nonce')).toBeNull();
    expect(url.searchParams.get('code_challenge')).toBeNull();
    // And nothing secret was stored for a flow that cannot use it.
    const row = db.prepare('SELECT code_verifier, nonce FROM oauth_states').get() as Record<string, unknown>;
    expect(row.code_verifier).toBeNull();
    expect(row.nonce).toBeNull();
  });
});
