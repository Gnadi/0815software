import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface AuthConfig {
  username: string;
  password: string;
  secret: string;
  ttlHours: number;
  secureCookie: boolean;
  /** Shared secret for event ingestion and the inbound hook receiver. */
  serviceToken: string;
  /**
   * Identity seam: when set, a Bearer token that is not this service's own
   * admin token is verified against PS-01 (`POST {identityUrl}/api/tokens/verify`)
   * so PS-01-issued end-user sessions are accepted. Unset = standalone mode.
   */
  identityUrl?: string;
}

/** Minimal fetch surface for the identity-seam verification call. */
export type SeamFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Verify a token against PS-01's cross-service contract. Never throws. */
export async function verifyIdentityToken(
  identityUrl: string,
  token: string,
  doFetch: SeamFetch,
): Promise<boolean> {
  try {
    const res = await doFetch(`${identityUrl.replace(/\/+$/, '')}/api/tokens/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return false;
    const verdict = (await res.json()) as { valid?: boolean };
    return verdict.valid === true;
  } catch {
    return false;
  }
}

export const COOKIE_NAME = 'ps08_session';
export const SERVICE_HEADER = 'x-service-token';

export function nowIso(ms: number = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function hmacSign(payload: string, secret: string): string {
  return sign(payload, secret);
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// ── Admin session: stateless HMAC token "<expiryMillis>.<hmac>" ────────

export function createToken(config: AuthConfig, now = Date.now()): string {
  const expiry = String(now + config.ttlHours * 3600_000);
  return `${expiry}.${sign(expiry, config.secret)}`;
}

export function verifyToken(config: AuthConfig, token: string, now = Date.now()): boolean {
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const expiry = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(expiry) || Number(expiry) < now) return false;
  return safeEqual(mac, sign(expiry, config.secret));
}

export function checkCredentials(config: AuthConfig, username: unknown, password: unknown): boolean {
  return (
    typeof username === 'string' &&
    typeof password === 'string' &&
    safeEqual(username, config.username) &&
    safeEqual(password, config.password)
  );
}

export function checkServiceToken(config: AuthConfig, provided: unknown): 'ok' | 'missing' | 'bad' {
  if (typeof provided !== 'string' || provided.length === 0) return 'missing';
  return safeEqual(provided, config.serviceToken) ? 'ok' : 'bad';
}

// ── Cookie / bearer helpers ────────────────────────────────────────────

export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return cookies;
}

export function sessionCookie(config: AuthConfig, token: string): string {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.ttlHours * 3600}`,
  ];
  if (config.secureCookie) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearedCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Admin gate: a valid session cookie or `Authorization: Bearer <token>`. */
export function requireAuth(config: AuthConfig, seam?: { fetch?: SeamFetch }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = parseBearer(req.headers.authorization) ?? parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token && verifyToken(config, token)) {
      next();
      return;
    }
    if (token && config.identityUrl) {
      const doFetch = seam?.fetch ?? (globalThis.fetch as unknown as SeamFetch);
      void verifyIdentityToken(config.identityUrl, token, doFetch)
        .then((ok) => {
          if (ok) next();
          else res.status(401).json({ error: 'Authentication required' });
        })
        .catch(() => res.status(401).json({ error: 'Authentication required' }));
      return;
    }
    res.status(401).json({ error: 'Authentication required' });
  };
}
