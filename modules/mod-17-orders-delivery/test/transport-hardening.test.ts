import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import {
  hardeningFromEnv,
  hardeningMiddleware,
  shellOriginsFromEnv,
  trustProxyHops,
  type HardeningConfig,
} from '../server/hardening.js';
import { parseCookies } from '../server/auth.js';

/**
 * The transport layer every deployment actually runs behind: the per-IP rate
 * limiter, the settings it is configured from, and the cookie parser that runs
 * before any of it can decide who you are.
 *
 * These are the pieces where a failure is SILENT — a limiter that never
 * refuses, a cookie parser that throws where it should reject — so each case
 * below pins the behaviour rather than the shape of the code.
 *
 * This file is byte-identical in every module and service, because
 * server/hardening.ts and the cookie half of server/auth.ts are.
 */

function config(overrides: Partial<HardeningConfig> = {}): HardeningConfig {
  return {
    rateLimitRpm: 0,
    loginRateLimitRpm: 0,
    corsOrigins: [],
    // No shell named: the standalone posture every case below starts from.
    shellOrigins: [],
    hsts: false,
    requestTimeoutMs: 0,
    trustProxy: 0,
    ...overrides,
  };
}

interface Outcome {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  passed: boolean;
}

/** Drive the middleware with a minimal fake req/res — no server, no sockets. */
function call(
  middleware: ReturnType<typeof hardeningMiddleware>,
  opts: { ip?: string; method?: string; path?: string; origin?: string } = {},
): Outcome {
  const ip = opts.ip ?? '203.0.113.7';
  const outcome: Outcome = { status: 200, headers: {}, body: undefined, passed: false };
  const req = {
    ip,
    method: opts.method ?? 'GET',
    path: opts.path ?? '/api/health',
    headers: opts.origin === undefined ? {} : { origin: opts.origin },
    socket: { remoteAddress: ip, setTimeout: () => undefined },
  } as unknown as Request;
  const res = {
    setHeader(name: string, value: string | number) {
      outcome.headers[name.toLowerCase()] = String(value);
    },
    status(code: number) {
      outcome.status = code;
      return res;
    },
    json(payload: unknown) {
      outcome.body = payload;
      return res;
    },
    end() {
      return res;
    },
  };
  middleware(req, res as unknown as Response, (() => {
    outcome.passed = true;
  }) as NextFunction);
  return outcome;
}

describe('hardeningFromEnv — numeric settings', () => {
  // The regression this whole block exists for: Number('off') is NaN, and a
  // NaN rate limit is not `<= 0`, so the limiter looked configured while every
  // comparison inside its token bucket quietly permitted the request.
  it.each([
    ['off', 'a word'],
    ['sixty', 'a misspelled number'],
    ['12x', 'trailing junk'],
    ['-5', 'a negative count'],
    ['', 'an empty value from an unset compose variable'],
    ['   ', 'whitespace'],
  ])('falls back to the default when RATE_LIMIT_RPM is %o (%s)', (raw) => {
    expect(hardeningFromEnv({ RATE_LIMIT_RPM: raw })).toMatchObject({ rateLimitRpm: 600 });
  });

  it('falls back for the login bucket and the socket timeout too', () => {
    const parsed = hardeningFromEnv({ LOGIN_RATE_LIMIT_RPM: 'none', REQUEST_TIMEOUT_MS: 'never' });
    expect(parsed.loginRateLimitRpm).toBe(20);
    expect(parsed.requestTimeoutMs).toBe(30_000);
  });

  it('keeps an explicit 0, which is the documented way to disable a limiter', () => {
    const parsed = hardeningFromEnv({ RATE_LIMIT_RPM: '0', LOGIN_RATE_LIMIT_RPM: '0', REQUEST_TIMEOUT_MS: '0' });
    expect(parsed.rateLimitRpm).toBe(0);
    expect(parsed.loginRateLimitRpm).toBe(0);
    expect(parsed.requestTimeoutMs).toBe(0);
  });

  it('reads real values', () => {
    const parsed = hardeningFromEnv({ RATE_LIMIT_RPM: '120', LOGIN_RATE_LIMIT_RPM: '5', REQUEST_TIMEOUT_MS: '15000' });
    expect(parsed).toMatchObject({ rateLimitRpm: 120, loginRateLimitRpm: 5, requestTimeoutMs: 15_000 });
  });

  it('defaults to a limiter that is on when nothing is configured', () => {
    expect(hardeningFromEnv({})).toMatchObject({ rateLimitRpm: 600, loginRateLimitRpm: 20, requestTimeoutMs: 30_000 });
  });

  it('a mistyped setting still yields a limiter that refuses', () => {
    // End to end over the parser: garbage in, working rate limit out.
    const middleware = hardeningMiddleware(hardeningFromEnv({ RATE_LIMIT_RPM: 'off' }), () => 1_000);
    for (let i = 0; i < 600; i += 1) expect(call(middleware).passed).toBe(true);
    expect(call(middleware).status).toBe(429);
  });
});

describe('trustProxyHops', () => {
  it.each([
    [undefined, 0],
    ['', 0],
    ['false', 0],
    ['true', 1],
    ['2', 2],
    ['0', 0],
    ['-1', 0],
    ['1.5', 0],
    ['yes', 0],
  ])('reads %o as %i hops', (raw, expected) => {
    expect(trustProxyHops(raw)).toBe(expected);
  });
});

describe('rate limiting', () => {
  it('allows a full minute of quota and then refuses with Retry-After', () => {
    const middleware = hardeningMiddleware(config({ rateLimitRpm: 3 }), () => 1_000);
    for (let i = 0; i < 3; i += 1) expect(call(middleware).passed).toBe(true);
    const refused = call(middleware);
    expect(refused.passed).toBe(false);
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toBe('60');
    expect(refused.body).toEqual({ error: 'Too many requests' });
  });

  it('refills continuously as time passes', () => {
    let now = 0;
    const middleware = hardeningMiddleware(config({ rateLimitRpm: 60 }), () => now);
    for (let i = 0; i < 60; i += 1) call(middleware);
    expect(call(middleware).status).toBe(429);
    now += 2_000; // 2s at 60/min = two tokens back
    expect(call(middleware).passed).toBe(true);
    expect(call(middleware).passed).toBe(true);
    expect(call(middleware).status).toBe(429);
  });

  it('buckets are per IP, so one noisy client cannot lock everyone out', () => {
    const middleware = hardeningMiddleware(config({ rateLimitRpm: 1 }), () => 1_000);
    expect(call(middleware, { ip: '198.51.100.1' }).passed).toBe(true);
    expect(call(middleware, { ip: '198.51.100.1' }).status).toBe(429);
    expect(call(middleware, { ip: '198.51.100.2' }).passed).toBe(true);
  });

  it('the login bucket is separate and stricter than the general one', () => {
    const middleware = hardeningMiddleware(config({ rateLimitRpm: 100, loginRateLimitRpm: 1 }), () => 1_000);
    expect(call(middleware, { method: 'POST', path: '/api/login' }).passed).toBe(true);
    expect(call(middleware, { method: 'POST', path: '/api/login' }).status).toBe(429);
    // Exhausting the login bucket must not touch the general one.
    expect(call(middleware, { method: 'GET', path: '/api/health' }).passed).toBe(true);
  });

  it('rpm 0 disables the limiter entirely', () => {
    const middleware = hardeningMiddleware(config({ rateLimitRpm: 0 }), () => 1_000);
    for (let i = 0; i < 50; i += 1) expect(call(middleware).passed).toBe(true);
  });
});

describe('security headers and CORS', () => {
  it('sets the baseline headers on every response', () => {
    const { headers } = call(hardeningMiddleware(config()));
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['strict-transport-security']).toBeUndefined();
    expect(headers['content-security-policy']).toBeUndefined();
  });

  /**
   * Framing is the one header a shell changes, so it gets its own block.
   *
   * The default matters more than the opt-in: an unconfigured package — which
   * is every standalone install, and every package in a stack that runs no
   * Workspace — must be exactly as unframeable as it was before this seam
   * existed. That is the promise the whole embed design rests on.
   */
  it('denies framing outright when no shell origin is configured', () => {
    const { headers } = call(hardeningMiddleware(config({ shellOrigins: [] })));
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['content-security-policy']).toBeUndefined();
  });

  it('names the shell origin, and drops X-Frame-Options when it does', () => {
    const { headers } = call(hardeningMiddleware(config({ shellOrigins: ['https://workspace.example'] })));
    expect(headers['content-security-policy']).toBe('frame-ancestors https://workspace.example');
    // Both together would be a header that reads as a refusal and is ignored:
    // browsers prefer the CSP, so DENY alongside it misleads whoever audits it.
    expect(headers['x-frame-options']).toBeUndefined();
  });

  /**
   * A stack may run more than one shell — MOD-15 Workspace summarises modules,
   * MOD-16 Mosaic frames them whole — and this module has no business picking
   * between them. While the config held a single value the provisioner's last
   * write won and the other shell framed nothing, which looks exactly like a
   * broken module from the inside of that frame.
   */
  it('names every configured shell, so two of them can both frame this module', () => {
    const { headers } = call(
      hardeningMiddleware(config({ shellOrigins: ['https://workspace.example', 'https://mosaic.example'] })),
    );
    expect(headers['content-security-policy']).toBe(
      'frame-ancestors https://workspace.example https://mosaic.example',
    );
    expect(headers['x-frame-options']).toBeUndefined();
  });
});

describe('shellOriginsFromEnv', () => {
  it('is empty by default, and treats blank as empty', () => {
    expect(shellOriginsFromEnv(undefined)).toEqual([]);
    expect(shellOriginsFromEnv('')).toEqual([]);
    expect(shellOriginsFromEnv('   ')).toEqual([]);
  });

  it('normalizes a valid origin', () => {
    expect(shellOriginsFromEnv('https://workspace.example')).toEqual(['https://workspace.example']);
    expect(shellOriginsFromEnv('  https://workspace.example/  ')).toEqual(['https://workspace.example']);
    expect(shellOriginsFromEnv('http://localhost:3015')).toEqual(['http://localhost:3015']);
  });

  it('reads a comma-separated list, and keeps the operator’s order', () => {
    expect(shellOriginsFromEnv('https://workspace.example, https://mosaic.example')).toEqual([
      'https://workspace.example',
      'https://mosaic.example',
    ]);
    // A trailing comma is a typo, not a request to allow nothing.
    expect(shellOriginsFromEnv('https://workspace.example,')).toEqual(['https://workspace.example']);
    // The same shell named twice is one entry: a repeated origin in
    // frame-ancestors is noise in a header people audit by eye.
    expect(shellOriginsFromEnv('https://a.example, https://a.example/')).toEqual(['https://a.example']);
  });

  /**
   * Every rejection here would otherwise be SILENT: the package boots, keeps
   * sending DENY, and the operator sees an empty frame in the Workspace with
   * nothing in the logs to explain it. Same posture as guard.ts on secrets —
   * fail while a human is still watching.
   */
  it('refuses a value that is not a bare origin, rather than dropping it', () => {
    expect(() => shellOriginsFromEnv('workspace.example')).toThrow(/absolute origins/);
    expect(() => shellOriginsFromEnv('not a url')).toThrow(/absolute origins/);
    expect(() => shellOriginsFromEnv('javascript:alert(1)')).toThrow(/http or https/);
    // frame-ancestors matches ORIGINS. Silently widening a path to the whole
    // origin is not this function's decision to make.
    expect(() => shellOriginsFromEnv('https://workspace.example/app')).toThrow(/no path/);
    expect(() => shellOriginsFromEnv('https://workspace.example/?x=1')).toThrow(/no path/);
    // One bad entry fails the whole list: half a policy is not a policy, and
    // the operator would never see which half survived.
    expect(() => shellOriginsFromEnv('https://good.example, nonsense')).toThrow(/absolute origins/);
  });

  it('emits HSTS only when configured', () => {
    expect(call(hardeningMiddleware(config({ hsts: true }))).headers['strict-transport-security']).toContain('max-age=31536000');
  });

  it('denies an unlisted origin by simply not answering it', () => {
    const middleware = hardeningMiddleware(config({ corsOrigins: ['https://app.example'] }));
    const { headers, passed } = call(middleware, { origin: 'https://evil.example' });
    expect(headers['access-control-allow-origin']).toBeUndefined();
    expect(passed).toBe(true); // same-origin requests still work; only CORS is refused
  });

  it('answers an allowlisted origin, and short-circuits its preflight', () => {
    const middleware = hardeningMiddleware(config({ corsOrigins: ['https://app.example'] }));
    const simple = call(middleware, { origin: 'https://app.example' });
    expect(simple.headers['access-control-allow-origin']).toBe('https://app.example');
    expect(simple.headers.vary).toBe('Origin');
    expect(simple.headers['access-control-allow-credentials']).toBe('true');

    const preflight = call(middleware, { origin: 'https://app.example', method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.passed).toBe(false);
  });
});

describe('parseCookies', () => {
  it('parses and percent-decodes a normal header', () => {
    expect(parseCookies('a=1; b=hello%20world')).toEqual({ a: '1', b: 'hello world' });
  });

  it('returns nothing for a missing header', () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  // The regression: decodeURIComponent THROWS on a stray percent sign. A
  // cookie is attacker-controlled text a browser replays on every request, so
  // an unguarded throw here escaped the session middleware and turned every
  // request from that client into a 500 instead of the 401 that would send it
  // back to the login page.
  it.each(['%', '%ZZ', '%E0%A4%A', 'abc%'])('survives the malformed value %o', (value) => {
    expect(() => parseCookies(`session=${value}`)).not.toThrow();
    expect(parseCookies(`session=${value}`)).toEqual({ session: value });
  });

  it('one malformed cookie does not lose the others in the header', () => {
    expect(parseCookies('good=yes; broken=%ZZ; also_good=ok')).toEqual({
      good: 'yes',
      broken: '%ZZ',
      also_good: 'ok',
    });
  });

  it('ignores junk segments without a name', () => {
    expect(parseCookies('=novalue; ; valid=1')).toEqual({ valid: '1' });
  });
});
