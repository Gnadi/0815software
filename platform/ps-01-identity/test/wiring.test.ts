/**
 * The corners of configuration and hardening that nothing had reached.
 *
 * Not route behaviour — the decisions a deployment makes ONCE, at boot, and
 * then lives with: whether the session cookie carries `Secure`, whether the
 * offline mock IdP is reachable, what an OAuth provider is when it is really
 * configured, and whether the rate limiter's own bookkeeping stays bounded
 * under the load a flood produces.
 */
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { configFromEnv } from '../server/config.js';
import { hardeningMiddleware, hardeningFromEnv } from '../server/hardening.js';
import { fetchIdentity, isAllowedRedirect, oauthConfigFromEnv, OAUTH_PROVIDERS, type FetchLike } from '../server/oauth.js';
import { SYSTEM_ROLES } from '../server/rbac-config.js';
import { PERMISSIONS, SYSTEM_ROLE_KEYS } from '../shared/types.js';

describe('cookie and mock-IdP posture follow NODE_ENV unless told otherwise', () => {
  it('marks the cookie Secure in production and not outside it', () => {
    expect(configFromEnv({ NODE_ENV: 'production' }).session.secureCookie).toBe(true);
    expect(configFromEnv({}).session.secureCookie).toBe(false);
  });

  it('lets COOKIE_SECURE override the default in both directions', () => {
    expect(configFromEnv({ COOKIE_SECURE: 'true' }).session.secureCookie).toBe(true);
    expect(configFromEnv({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }).session.secureCookie).toBe(false);
  });

  it('turns the mock IdP off in production and on outside it', () => {
    // The mock resolves an identity with NO credential, so this default is the
    // difference between a demo affordance and an open door.
    expect(configFromEnv({ NODE_ENV: 'production' }).allowMockIdp).toBe(false);
    expect(configFromEnv({}).allowMockIdp).toBe(true);
  });

  it('lets OAUTH_ALLOW_MOCK override it, deliberately, in both directions', () => {
    expect(configFromEnv({ NODE_ENV: 'production', OAUTH_ALLOW_MOCK: 'true' }).allowMockIdp).toBe(true);
    expect(configFromEnv({ OAUTH_ALLOW_MOCK: 'false' }).allowMockIdp).toBe(false);
    // Anything that is not the literal "true" is off — a typo does not open it.
    expect(configFromEnv({ NODE_ENV: 'production', OAUTH_ALLOW_MOCK: 'yes' }).allowMockIdp).toBe(false);
  });

  it('reads the redirect allowlist as a trimmed, empty-free list', () => {
    expect(configFromEnv({ OAUTH_REDIRECT_ALLOWLIST: ' https://a.example , ,https://b.example ' }).redirectAllowlist)
      .toEqual(['https://a.example', 'https://b.example']);
    expect(configFromEnv({}).redirectAllowlist).toEqual([]);
  });

  it('defaults SELF_BASE_URL to the port it is actually listening on', () => {
    expect(configFromEnv({ PORT: '4099' }).selfBaseUrl).toBe('http://localhost:4099');
    expect(configFromEnv({ SELF_BASE_URL: 'https://id.example' }).selfBaseUrl).toBe('https://id.example');
  });
});

describe('an OAuth provider read from the environment', () => {
  it('stays unconfigured unless BOTH the id and the secret are set', () => {
    expect(oauthConfigFromEnv({})).toEqual({});
    expect(oauthConfigFromEnv({ OAUTH_GOOGLE_CLIENT_ID: 'id' })).toEqual({});
    expect(oauthConfigFromEnv({ OAUTH_GOOGLE_CLIENT_SECRET: 'secret' })).toEqual({});
    expect(oauthConfigFromEnv({ OAUTH_GOOGLE_CLIENT_ID: '', OAUTH_GOOGLE_CLIENT_SECRET: 'secret' })).toEqual({});
  });

  it('fills the real provider endpoints in when it is', () => {
    const config = oauthConfigFromEnv({ OAUTH_GOOGLE_CLIENT_ID: 'id', OAUTH_GOOGLE_CLIENT_SECRET: 'secret' });
    expect(config.google).toMatchObject({
      clientId: 'id',
      clientSecret: 'secret',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      scope: 'openid email profile',
    });
  });

  it('lets every endpoint be overridden — a tenant-specific issuer, or a test double', () => {
    const config = oauthConfigFromEnv({
      OAUTH_MICROSOFT_CLIENT_ID: 'id',
      OAUTH_MICROSOFT_CLIENT_SECRET: 'secret',
      OAUTH_MICROSOFT_AUTHORIZE_URL: 'https://login.example/authorize',
      OAUTH_MICROSOFT_TOKEN_URL: 'https://login.example/token',
      OAUTH_MICROSOFT_USERINFO_URL: 'https://login.example/me',
      OAUTH_MICROSOFT_SCOPE: 'openid',
    });
    expect(config.microsoft).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
      authorizeUrl: 'https://login.example/authorize',
      tokenUrl: 'https://login.example/token',
      userInfoUrl: 'https://login.example/me',
      scope: 'openid',
    });
  });

  it('configures each provider independently', () => {
    const config = oauthConfigFromEnv({ OAUTH_GITHUB_CLIENT_ID: 'id', OAUTH_GITHUB_CLIENT_SECRET: 'secret' });
    expect(Object.keys(config)).toEqual(['github']);
    expect(OAUTH_PROVIDERS).toEqual(['google', 'microsoft', 'github']);
  });
});

describe('what may receive a session token after login', () => {
  const SELF = 'https://identity.example.com';

  it('accepts a same-site path and this service own origin', () => {
    expect(isAllowedRedirect('/app', [], SELF)).toBe(true);
    expect(isAllowedRedirect('/', [], SELF)).toBe(true);
    expect(isAllowedRedirect(`${SELF}/app`, [], SELF)).toBe(true);
  });

  it('refuses an absolute URL in disguise', () => {
    expect(isAllowedRedirect('//evil.example/steal', [], SELF)).toBe(false);
    expect(isAllowedRedirect('https://evil.example', [], SELF)).toBe(false);
    expect(isAllowedRedirect('not a url', [], SELF)).toBe(false);
  });

  it('refuses a scheme that is not http(s) — javascript: and data: above all', () => {
    expect(isAllowedRedirect('javascript:alert(1)', [], SELF)).toBe(false);
    expect(isAllowedRedirect('data:text/html,<script>', [], SELF)).toBe(false);
    expect(isAllowedRedirect('file:///etc/passwd', [], SELF)).toBe(false);
  });

  it('matches an allowlist entry by ORIGIN, not by prefix', () => {
    const allow = ['https://portal.example.com'];
    expect(isAllowedRedirect('https://portal.example.com/deep/link?a=1', allow, SELF)).toBe(true);
    // The classic prefix bug: a hostname that merely starts with the allowed one.
    expect(isAllowedRedirect('https://portal.example.com.evil.test/', allow, SELF)).toBe(false);
    expect(isAllowedRedirect('http://portal.example.com/', allow, SELF)).toBe(false); // scheme is part of it
  });

  it('lets an unparseable allowlist entry allow nothing, rather than throwing', () => {
    expect(isAllowedRedirect('https://portal.example.com/x', ['not a url', ''], SELF)).toBe(false);
    expect(isAllowedRedirect('/still-fine', ['not a url'], SELF)).toBe(true);
  });
});

describe('the rate limiter keeps its own bookkeeping bounded', () => {
  /** Minimal fake req/res — no server, no sockets. */
  function call(middleware: ReturnType<typeof hardeningMiddleware>, ip: string): number {
    let status = 200;
    const req = {
      ip,
      method: 'GET',
      path: '/api/health',
      headers: {},
      socket: { remoteAddress: ip, setTimeout: () => undefined },
    } as unknown as Request;
    const res = {
      setHeader: () => undefined,
      status(code: number) {
        status = code;
        return res;
      },
      json: () => res,
      end: () => res,
    };
    middleware(req, res as never, () => undefined);
    return status;
  }

  it('prunes idle buckets once a flood has filled the map', () => {
    let clock = 0;
    const middleware = hardeningMiddleware(
      { rateLimitRpm: 600, loginRateLimitRpm: 20, corsOrigins: [], hsts: false, requestTimeoutMs: 0, shellOrigins: [], trustProxy: 0 },
      () => clock,
    );

    // 10 001 distinct sources, which is what a flood looks like.
    for (let i = 0; i <= 10_000; i++) call(middleware, `10.0.${(i >> 8) & 255}.${i & 255}`);

    // Nothing has aged out yet, and the prune runs at most once a minute — so
    // the map is still full and every request is still served.
    expect(call(middleware, '198.51.100.1')).toBe(200);

    // Past both the prune interval and the bucket TTL: the next request sweeps.
    clock += 130_000;
    expect(call(middleware, '198.51.100.2')).toBe(200);
    // And the sweep did not cost the caller its own allowance.
    expect(call(middleware, '198.51.100.2')).toBe(200);
  });

  it('still refuses a single source that is over its quota', () => {
    let clock = 0;
    const middleware = hardeningMiddleware(
      { rateLimitRpm: 2, loginRateLimitRpm: 20, corsOrigins: [], hsts: false, requestTimeoutMs: 0, shellOrigins: [], trustProxy: 0 },
      () => clock,
    );
    expect(call(middleware, '203.0.113.9')).toBe(200);
    expect(call(middleware, '203.0.113.9')).toBe(200);
    expect(call(middleware, '203.0.113.9')).toBe(429);
    // A minute later the bucket has refilled.
    clock += 60_000;
    expect(call(middleware, '203.0.113.9')).toBe(200);
  });

  it('reads its whole configuration off the environment', () => {
    const config = hardeningFromEnv({ NODE_ENV: 'production' });
    expect(config).toMatchObject({ rateLimitRpm: 600, loginRateLimitRpm: 20, hsts: true, trustProxy: 0 });
  });
});

describe('the RBAC config is checked at import, not at request time', () => {
  it('declares every system role exactly once, granting only real permissions', () => {
    expect(SYSTEM_ROLES.map((r) => r.key)).toEqual([...SYSTEM_ROLE_KEYS]);
    for (const role of SYSTEM_ROLES) {
      for (const perm of role.permissions) expect(PERMISSIONS, role.key).toContain(perm);
    }
  });

  it('keeps the one permission that separates an Owner from an Administrator', () => {
    const owner = SYSTEM_ROLES.find((r) => r.key === 'owner')!;
    const admin = SYSTEM_ROLES.find((r) => r.key === 'admin')!;
    expect(owner.permissions).toEqual([...PERMISSIONS]);
    expect(admin.permissions).not.toContain('org:write');
    // Everything else the Administrator holds, the Owner holds too.
    for (const perm of admin.permissions) expect(owner.permissions).toContain(perm);
  });

  it('orders the roles so each holds a superset of the one below it', () => {
    const byKey = new Map(SYSTEM_ROLES.map((r) => [r.key, new Set<string>(r.permissions)]));
    const ladder = ['viewer', 'member', 'admin', 'owner'] as const;
    for (let i = 1; i < ladder.length; i++) {
      const lower = byKey.get(ladder[i - 1]!)!;
      const upper = byKey.get(ladder[i]!)!;
      for (const perm of lower) expect(upper, `${ladder[i]} ⊇ ${ladder[i - 1]}`).toContain(perm);
    }
  });
});

describe('exchanging a code with a real provider', () => {
  const cfg = {
    clientId: 'id',
    clientSecret: 'secret',
    authorizeUrl: 'https://accounts.example/auth',
    tokenUrl: 'https://accounts.example/token',
    userInfoUrl: 'https://accounts.example/me',
    scope: 'openid email profile',
  };

  /** A fetch double that answers each URL from a script. */
  const scripted = (
    responses: Record<string, { ok?: boolean; status?: number; json?: unknown }>,
  ): FetchLike => {
    const calls: { url: string; init?: Record<string, unknown> }[] = [];
    const fn = (async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, init });
      const r = responses[url] ?? { ok: false, status: 404 };
      return {
        ok: r.ok ?? true,
        status: r.status ?? 200,
        json: async () => r.json,
        text: async () => JSON.stringify(r.json ?? ''),
      };
    }) as FetchLike & { calls: typeof calls };
    fn.calls = calls;
    return fn;
  };

  it('posts the authorization code and reads the identity back', async () => {
    const doFetch = scripted({
      [cfg.tokenUrl]: { json: { access_token: 'at-1' } },
      [cfg.userInfoUrl]: { json: { sub: 'g-1', email: 'Ada@Example.test', name: 'Ada L' } },
    }) as FetchLike & { calls: { url: string; init?: Record<string, unknown> }[] };

    const identity = await fetchIdentity(cfg, 'the-code', 'https://id.example/cb', doFetch);
    expect(identity).toEqual({ email: 'Ada@Example.test', name: 'Ada L', subject: 'g-1' });

    // The code, the client credentials and the redirect all go up as a form
    // body — the shape every OAuth2 provider expects.
    const body = String(doFetch.calls[0]!.init!.body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=the-code');
    expect(body).toContain('client_secret=secret');
    expect(body).toContain('redirect_uri=https%3A%2F%2Fid.example%2Fcb');
    // And the access token is presented as a bearer, never as a query parameter.
    expect((doFetch.calls[1]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer at-1');
  });

  it('falls back through the field names different providers use', async () => {
    // GitHub has no `sub` and may answer with `login` and `id`; Microsoft
    // Graph answers with `mail`.
    const github = await fetchIdentity(
      cfg,
      'c',
      'https://id.example/cb',
      scripted({
        [cfg.tokenUrl]: { json: { access_token: 'at' } },
        [cfg.userInfoUrl]: { json: { login: 'ada', id: 4711 } },
      }),
    );
    expect(github).toEqual({ email: 'ada', name: 'ada', subject: '4711' });

    const microsoft = await fetchIdentity(
      cfg,
      'c',
      'https://id.example/cb',
      scripted({
        [cfg.tokenUrl]: { json: { access_token: 'at' } },
        [cfg.userInfoUrl]: { json: { mail: 'ada@corp.test' } },
      }),
    );
    expect(microsoft).toEqual({ email: 'ada@corp.test', name: 'ada@corp.test', subject: 'ada@corp.test' });
  });

  it('refuses to invent an identity when the provider will not give one', async () => {
    const cases: [string, Record<string, { ok?: boolean; status?: number; json?: unknown }>, RegExp][] = [
      ['the token exchange is refused', { [cfg.tokenUrl]: { ok: false, status: 401 } }, /token exchange failed \(401\)/],
      [
        'the token response carries no access_token',
        { [cfg.tokenUrl]: { json: { error: 'invalid_grant' } } },
        /no access_token/,
      ],
      [
        'userinfo is refused',
        { [cfg.tokenUrl]: { json: { access_token: 'at' } }, [cfg.userInfoUrl]: { ok: false, status: 403 } },
        /userinfo failed \(403\)/,
      ],
      [
        'the profile has no address to identify anyone by',
        { [cfg.tokenUrl]: { json: { access_token: 'at' } }, [cfg.userInfoUrl]: { json: { sub: 'g-1' } } },
        /no email/,
      ],
    ];
    for (const [what, responses, message] of cases) {
      await expect(
        fetchIdentity(cfg, 'c', 'https://id.example/cb', scripted(responses)),
        what,
      ).rejects.toThrow(message);
    }
  });
});
