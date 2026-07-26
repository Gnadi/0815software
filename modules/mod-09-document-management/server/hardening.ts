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
}

export function hardeningFromEnv(env: NodeJS.ProcessEnv = process.env): HardeningConfig {
  return {
    rateLimitRpm: env.RATE_LIMIT_RPM !== undefined ? Number(env.RATE_LIMIT_RPM) : 600,
    loginRateLimitRpm: env.LOGIN_RATE_LIMIT_RPM !== undefined ? Number(env.LOGIN_RATE_LIMIT_RPM) : 20,
    corsOrigins: (env.CORS_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    hsts: env.HSTS === 'true' || env.NODE_ENV === 'production',
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS !== undefined ? Number(env.REQUEST_TIMEOUT_MS) : 30_000,
  };
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Continuous-refill token bucket keyed by IP. Burst capacity = one minute's quota. */
function makeLimiter(rpm: number, now: () => number) {
  const buckets = new Map<string, Bucket>();
  return (ip: string): boolean => {
    if (rpm <= 0) return true;
    const at = now();
    // Opportunistic prune so the map cannot grow without bound.
    if (buckets.size > 10_000) {
      for (const [key, b] of buckets) if (at - b.updatedAt > 120_000) buckets.delete(key);
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
