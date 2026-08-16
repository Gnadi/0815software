import type { NextFunction, Request, Response } from 'express';

/**
 * A tighter per-IP limiter for the access-code lookup.
 *
 * `hardening.ts` already limits every route and gives `POST /api/login` its
 * own stricter bucket. The code lookup deserves the same treatment for the
 * same reason — it is the other endpoint where a wrong answer means
 * "guess again" — and it is a module-specific concern, so it lives here
 * rather than in the file every package shares byte for byte.
 *
 * A code carries 100 bits of entropy, so this is not what stops a brute
 * force; arithmetic does. What it stops is an automated sweep turning the
 * public endpoint into a load generator, and it keeps the shape of the
 * defence the same as the login's so there is one thing to reason about.
 */
const BUCKET_TTL_MS = 120_000;
const PRUNE_INTERVAL_MS = 60_000;

export function lookupLimiter(rpm: number, now: () => number = Date.now) {
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();
  let prunedAt = 0;

  return (req: Request, res: Response, next: NextFunction): void => {
    // Zero disables it, visibly — the same contract the shared limiters use.
    if (!(rpm > 0)) {
      next();
      return;
    }
    const at = now();
    if (buckets.size > 10_000 && at - prunedAt > PRUNE_INTERVAL_MS) {
      prunedAt = at;
      for (const [key, bucket] of buckets) if (at - bucket.updatedAt > BUCKET_TTL_MS) buckets.delete(key);
    }
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const bucket = buckets.get(ip) ?? { tokens: rpm, updatedAt: at };
    bucket.tokens = Math.min(rpm, bucket.tokens + ((at - bucket.updatedAt) / 60_000) * rpm);
    bucket.updatedAt = at;
    if (bucket.tokens < 1) {
      buckets.set(ip, bucket);
      res.setHeader('Retry-After', '60');
      res.status(429).json({ error: 'Too many attempts' });
      return;
    }
    bucket.tokens -= 1;
    buckets.set(ip, bucket);
    next();
  };
}
