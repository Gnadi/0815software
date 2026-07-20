import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface AuthConfig {
  username: string;
  password: string;
  secret: string;
  ttlHours: number;
  secureCookie: boolean;
}

export const COOKIE_NAME = 'mod10_session';

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Stateless session token: "<expiryMillis>.<hmac(expiryMillis)>". */
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

export function requireAuth(config: AuthConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token && verifyToken(config, token)) {
      next();
      return;
    }
    res.status(401).json({ error: 'Authentication required' });
  };
}
