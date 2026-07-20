import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface AuthConfig {
  username: string;
  password: string;
  secret: string;
  ttlHours: number;
  secureCookie: boolean;
  /** Shared secret required in the X-Intake-Secret header on email intake. */
  intakeSecret: string;
}

export const COOKIE_NAME = 'mod12_session';
export const INTAKE_HEADER = 'x-intake-secret';

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// ── Agent session: stateless HMAC token "<expiryMillis>.<hmac>" ─────────

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

// ── Public ticket lookup token ─────────────────────────────────────────
// A ticket ref (TKT-2026-0001) is guessable; the lookup token is not. It
// is a stateless HMAC of the ref under the same server secret — no per-
// ticket secret is stored. A wrong or missing token is indistinguishable
// from "no such ticket": the caller always gets a 404.

export function lookupToken(config: AuthConfig, ref: string): string {
  return sign(`ticket:${ref}`, config.secret);
}

export function verifyLookupToken(config: AuthConfig, ref: string, token: unknown): boolean {
  return typeof token === 'string' && safeEqual(token, lookupToken(config, ref));
}

// ── Email intake shared secret ─────────────────────────────────────────

export function checkIntakeSecret(config: AuthConfig, provided: unknown): 'ok' | 'missing' | 'bad' {
  if (typeof provided !== 'string' || provided.length === 0) return 'missing';
  return safeEqual(provided, config.intakeSecret) ? 'ok' : 'bad';
}

// ── Cookie helpers ─────────────────────────────────────────────────────

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
