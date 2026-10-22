import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { isAccessLevel, permits, type AccessLevel } from '@0815software/platform-clients';
import { accessPolicy } from './access.js';

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
export function createToken(
  config: AuthConfig,
  actor: string = config.username,
  now = Date.now(),
  access: AccessLevel = 'manage',
): string {
  const payload = `${now + config.ttlHours * 3600_000}.${Buffer.from(actor, 'utf8').toString('base64url')}.${access}`;
  return `${payload}.${sign(payload, config.secret)}`;
}

export interface Session {
  /** Who this session belongs to — a PS-01 identity, or the local admin. */
  actor: string;
  /**
   * What they may do here (`server/access.ts`). The local admin always
   * manages; a PS-01 identity gets what its `module:` permissions grant.
   */
  access: AccessLevel;
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
    return safeEqual(mac, sign(expiry, config.secret)) ? { actor: config.username, access: 'manage' } : null;
  }

  // Three parts is the format from before the access level was carried. Like
  // the two-part one above it stays valid until it expires, and it too can
  // only have been minted for someone who managed this module: before access
  // levels existed every session, local or SSO, was an administrator's. Drop
  // it together with the two-part branch.
  if (parts.length !== 3 && parts.length !== 4) return null;
  const [expiry, actorPart] = parts as [string, string];
  const accessPart = parts.length === 4 ? (parts[2] as string) : null;
  const mac = parts[parts.length - 1] as string;
  if (!/^\d+$/.test(expiry) || Number(expiry) < now) return null;
  const signed = accessPart === null ? `${expiry}.${actorPart}` : `${expiry}.${actorPart}.${accessPart}`;
  if (!safeEqual(mac, sign(signed, config.secret))) return null;
  const access = accessPart ?? 'manage';
  if (!isAccessLevel(access)) return null;
  const actor = Buffer.from(actorPart, 'base64url').toString('utf8');
  return actor === '' ? null : { actor, access };
}

export function verifyToken(config: AuthConfig, token: string, now = Date.now()): boolean {
  return readToken(config, token, now) !== null;
}

/**
 * Percent-decode a cookie value, keeping the raw text when the encoding is
 * malformed.
 *
 * `decodeURIComponent` THROWS a URIError on a stray percent sign, and a cookie
 * is attacker-controlled text that a browser then replays on every single
 * request for the whole TTL. Unguarded, that throw escapes the session
 * middleware, so a client holding one corrupt byte gets a 500 on every
 * request instead of the 401 that would send it back to the login page — a
 * session that can neither authenticate nor recover, and an error page where
 * the deployment's monitoring expects an auth failure. Undecodable bytes are
 * not a valid signed token either, so handing them on verbatim fails
 * verification and lands on the same 401 as any other bad cookie.
 */
function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies[part.slice(0, eq).trim()] = decodeCookieValue(part.slice(eq + 1).trim());
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
 * routes stamp onto audit events and the module's own history rows, and their
 * level on `res.locals.access`.
 *
 * It is also the ONLY place access is enforced: every request is held against
 * `server/access.ts` before any route sees it — reads need `view`, writes need
 * `edit`, and the actions that file names need what it says. Enforcing it here
 * rather than route by route is the point: a route added later is protected by
 * the default without anyone remembering to protect it.
 */
export function requireAuth(config: AuthConfig, policy: (method: string, path: string) => AccessLevel = accessPolicy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const session = token ? readToken(config, token) : null;
    if (session) {
      const required = policy(req.method, req.baseUrl + req.path);
      if (!permits(session.access, required)) {
        res.status(403).json({ error: 'Insufficient access', required, access: session.access });
        return;
      }
      res.locals.actor = session.actor;
      res.locals.access = session.access;
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

/** What the current request may do; the local admin's level when nothing said. */
export function accessOf(res: Response): AccessLevel {
  const access = res.locals.access as unknown;
  return isAccessLevel(access) ? access : 'manage';
}
