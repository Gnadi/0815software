import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface AuthConfig {
  username: string;
  password: string;
  secret: string;
  ttlHours: number;
  secureCookie: boolean;
}

export const COOKIE_NAME = 'mod03_session';

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Stateless session token: "<expiryMillis>.<actor base64url>.<hmac(payload)>".
 *
 * The actor is who logged in. Every operator signs in through one shared admin
 * account, so without it this module's audit entries and history rows all read
 * "admin" — true, and useless for answering who changed something. With SSO
 * configured the actor is the identity PS-01 itself validated; standalone it is
 * the local admin, exactly as before.
 */
export function createToken(config: AuthConfig, actor: string = config.username, now = Date.now()): string {
  const payload = `${now + config.ttlHours * 3600_000}.${Buffer.from(actor, 'utf8').toString('base64url')}`;
  return `${payload}.${sign(payload, config.secret)}`;
}

export interface Session {
  /** Who this session belongs to — a PS-01 identity, or the local admin. */
  actor: string;
}

/** Verify a token and return whose it is, or null. */
export function readToken(config: AuthConfig, token: string, now = Date.now()): Session | null {
  const parts = token.split('.');

  // Two parts is the format from before the actor was carried. It stays valid
  // until it expires — an upgrade should not sign everyone out — and can only
  // have been minted for the local admin. Drop this branch once no session
  // predating the upgrade can still be alive (one SESSION_TTL_HOURS).
  if (parts.length === 2) {
    const [expiry, mac] = parts as [string, string];
    if (!/^\d+$/.test(expiry) || Number(expiry) < now) return null;
    return safeEqual(mac, sign(expiry, config.secret)) ? { actor: config.username } : null;
  }

  if (parts.length !== 3) return null;
  const [expiry, actorPart, mac] = parts as [string, string, string];
  if (!/^\d+$/.test(expiry) || Number(expiry) < now) return null;
  if (!safeEqual(mac, sign(`${expiry}.${actorPart}`, config.secret))) return null;
  const actor = Buffer.from(actorPart, 'base64url').toString('utf8');
  return actor === '' ? null : { actor };
}

export function verifyToken(config: AuthConfig, token: string, now = Date.now()): boolean {
  return readToken(config, token, now) !== null;
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

export function checkCredentials(config: AuthConfig, username: unknown, password: unknown): boolean {
  return (
    typeof username === 'string' &&
    typeof password === 'string' &&
    safeEqual(username, config.username) &&
    safeEqual(password, config.password)
  );
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

/**
 * Session gate. Publishes the caller on `res.locals.actor`, which is what the
 * routes stamp onto audit events and the module's own history rows.
 */
export function requireAuth(config: AuthConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const session = token ? readToken(config, token) : null;
    if (session) {
      res.locals.actor = session.actor;
      next();
      return;
    }
    res.status(401).json({ error: 'Authentication required' });
  };
}

/** Who is making the current request; the local admin when nothing said. */
export function actorOf(res: Response, config: AuthConfig): string {
  const actor = res.locals.actor as unknown;
  return typeof actor === 'string' && actor !== '' ? actor : config.username;
}
