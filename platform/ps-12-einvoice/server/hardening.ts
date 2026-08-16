import type { NextFunction, Request, Response } from 'express';

/**
 * In-code transport hardening: a hand-rolled per-IP token-bucket rate limiter
 * (stricter bucket for /api/login), security headers, a default-deny CORS
 * policy with an env allowlist, and a socket timeout. No dependencies.
 *
 * `createApp` mounts this only when a config is passed — tests construct apps
 * without one, so suites stay unthrottled and deterministic. `index.ts` passes
 * `hardeningFromEnv()`, so every real boot is hardened.
 */

export interface HardeningConfig {
  /** Sustained requests/minute per IP (general bucket). 0 disables. */
  rateLimitRpm: number;
  /** Requests/minute per IP against POST /api/login. 0 disables. */
  loginRateLimitRpm: number;
  /** Allowed CORS origins. Empty = same-origin only (no CORS headers ever). */
  corsOrigins: string[];
  /** Emit Strict-Transport-Security (set behind HTTPS). */
  hsts: boolean;
  /** Socket inactivity timeout in ms. 0 disables. */
  requestTimeoutMs: number;
  /**
   * Number of reverse proxies in front of this service (Express `trust proxy`).
   * 0 = trust nobody: `req.ip` is the socket peer. Behind the stack's Caddy
   * that peer is Caddy for every request, which collapses per-IP rate limiting
   * into one shared bucket and records the proxy in audit trails — so a
   * proxied deployment must set TRUST_PROXY=1. Never enable it when the
   * service is reachable directly: clients could then forge X-Forwarded-For.
   */
  trustProxy: number;
}

/**
 * Read TRUST_PROXY: a hop count, or "true"/"false". Defaults to 0 (off), so a
 * service exposed directly cannot be fooled by a forged X-Forwarded-For.
 */
export function trustProxyHops(raw: string | undefined): number {
  if (raw === undefined || raw === '' || raw === 'false') return 0;
  if (raw === 'true') return 1;
  const hops = Number(raw);
  return Number.isInteger(hops) && hops > 0 ? hops : 0;
}

/**
 * Read a non-negative numeric setting, falling back to the shipped default
 * when the value is not one.
 *
 * `Number()` used to be trusted here, and it answers two ways that both cost
 * you the control the setting exists to provide. `Number('off')` is NaN, and
 * NaN is the dangerous one: it is not `<= 0`, so the limiter below looked
 * enabled, but every comparison inside a token bucket is false against NaN, so
 * it never refused a request — `RATE_LIMIT_RPM=off` silently shipped a service
 * with NO rate limiting at all, and nothing in the logs said so. `Number('')`
 * is 0, which disables the limiter outright, and an empty string is exactly
 * what an unset variable interpolated into a compose file yields — the same
 * accident `guard.ts` refuses to boot on for secrets.
 *
 * A typo must not quietly remove a defence, so both fall back to the default.
 * An explicit, deliberate `0` still disables the limiter, as documented.
 */
function nonNegativeNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function hardeningFromEnv(env: NodeJS.ProcessEnv = process.env): HardeningConfig {
  return {
    rateLimitRpm: nonNegativeNumber(env.RATE_LIMIT_RPM, 600),
    loginRateLimitRpm: nonNegativeNumber(env.LOGIN_RATE_LIMIT_RPM, 20),
    corsOrigins: (env.CORS_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    hsts: env.HSTS === 'true' || env.NODE_ENV === 'production',
    requestTimeoutMs: nonNegativeNumber(env.REQUEST_TIMEOUT_MS, 30_000),
    trustProxy: trustProxyHops(env.TRUST_PROXY),
  };
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** How long a bucket may sit untouched before a prune may drop it. */
const BUCKET_TTL_MS = 120_000;
/** Minimum gap between prunes, so a full scan cannot run per request. */
const PRUNE_INTERVAL_MS = 60_000;

/** Continuous-refill token bucket keyed by IP. Burst capacity = one minute's quota. */
function makeLimiter(rpm: number, now: () => number) {
  const buckets = new Map<string, Bucket>();
  let prunedAt = -Infinity;
  return (ip: string): boolean => {
    // Written as `!(rpm > 0)` rather than `rpm <= 0` so a non-finite rpm
    // disables the limiter visibly instead of slipping past this line and
    // then permitting everything anyway through NaN bucket arithmetic.
    // `hardeningFromEnv` already rejects such values; this is the backstop
    // for a config assembled in code.
    if (!(rpm > 0)) return true;
    const at = now();
    // Prune so the map cannot grow without bound — but at most once a minute.
    // The scan is O(size), and the old unconditional `size > 10_000` check ran
    // it on EVERY request once that many distinct IPs were live, which is the
    // load a flood produces: the limiter's own bookkeeping became the more
    // expensive half of the request.
    if (buckets.size > 10_000 && at - prunedAt > PRUNE_INTERVAL_MS) {
      prunedAt = at;
      for (const [key, b] of buckets) if (at - b.updatedAt > BUCKET_TTL_MS) buckets.delete(key);
    }
    const bucket = buckets.get(ip) ?? { tokens: rpm, updatedAt: at };
    bucket.tokens = Math.min(rpm, bucket.tokens + ((at - bucket.updatedAt) / 60_000) * rpm);
    bucket.updatedAt = at;
    if (bucket.tokens < 1) {
      buckets.set(ip, bucket);
      return false;
    }
    bucket.tokens -= 1;
    buckets.set(ip, bucket);
    return true;
  };
}

export function hardeningMiddleware(config: HardeningConfig, now: () => number = Date.now) {
  const general = makeLimiter(config.rateLimitRpm, now);
  const login = makeLimiter(config.loginRateLimitRpm, now);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (config.requestTimeoutMs > 0) req.socket.setTimeout?.(config.requestTimeoutMs);

    // ── Security headers ───────────────────────────────────────────────
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (config.hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    // ── CORS: default deny; allowlisted origins get standard headers ───
    const origin = req.headers.origin;
    if (typeof origin === 'string' && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Service-Token');
        res.status(204).end();
        return;
      }
    }

    // ── Rate limiting ──────────────────────────────────────────────────
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const isLogin = req.method === 'POST' && req.path === '/api/login';
    if (!(isLogin ? login(ip) : general(ip))) {
      res.setHeader('Retry-After', '60');
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    next();
  };
}
