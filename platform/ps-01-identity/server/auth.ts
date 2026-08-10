import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { SessionClaims } from '../shared/types.js';

export interface SessionConfig {
  secret: string;
  ttlHours: number;
  secureCookie: boolean;
}

export const COOKIE_NAME = 'ps01_session';

const SCRYPT_KEYLEN = 64;

function safeEqualBuf(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** ISO-8601 timestamp without milliseconds, e.g. "2026-07-23T09:00:00Z". */
export function nowIso(ms: number = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ── Password hashing (node built-in scrypt, no extra dependencies) ─────
//
// ASYNCHRONOUS ON PURPOSE. scrypt is deliberately expensive — ~90ms per call
// here — and `scryptSync` spends all of it on the event loop, which in a
// single-threaded server means the whole process is deaf for that time. This
// service is the one every module and every other service authenticates
// through: `POST /api/tokens/verify` is on the hot path of every authorized
// request in the platform. With the synchronous variant, 30 concurrent login
// attempts (a password spray that the per-account throttle deliberately does
// not delay, because each guess hits a different account) queued behind each
// other and pushed /api/tokens/verify from 2ms to 854ms — the platform's
// authorization path stalls for as long as someone keeps guessing.
//
// The callback form hands the work to libuv's threadpool instead, so hashing
// runs off the loop and in parallel. Everything that hashes a password is
// therefore async, all the way up to the request handlers.

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/** Hash a secret as "scrypt:<salt hex>:<derived key hex>". */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = await scryptAsync(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN);
  return safeEqualBuf(key, Buffer.from(keyHex, 'hex'));
}

/**
 * Hash of a random password, used to burn equal scrypt work when a login
 * hits an unknown account — so response timing never reveals whether the
 * organization/email exists.
 *
 * Memoized rather than computed at import: a process that never verifies a
 * password (the seed CLI) should not pay for it, and the first caller that
 * does gets the same hash every later one sees.
 */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}

// ── Stateless HMAC-signed session token ────────────────────────────────
// Token: "<userId>.<orgId>.<tokenVersion>.<expiryMillis>.<hmac(payload)>".
// The tokenVersion is stored per user and bumped on password change, which
// invalidates every previously issued token for that account.

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function createToken(config: SessionConfig, claims: SessionClaims, now = Date.now()): string {
  const payload = `${claims.userId}.${claims.orgId}.${claims.tokenVersion}.${now + config.ttlHours * 3600_000}`;
  return `${payload}.${sign(payload, config.secret)}`;
}

export function verifyToken(
  config: SessionConfig,
  token: string,
  now = Date.now(),
): SessionClaims | null {
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [userId, orgId, version, expiry, mac] = parts as [string, string, string, string, string];
  if (![userId, orgId, version, expiry].every((p) => /^\d+$/.test(p))) return null;
  if (Number(expiry) < now) return null;
  const expected = sign(`${userId}.${orgId}.${version}.${expiry}`, config.secret);
  if (!safeEqualBuf(Buffer.from(mac), Buffer.from(expected))) return null;
  return { userId: Number(userId), orgId: Number(orgId), tokenVersion: Number(version) };
}

// ── Bearer / cookie helpers ────────────────────────────────────────────

/** Extract the token from an `Authorization: Bearer <token>` header. */
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

export function sessionCookie(config: SessionConfig, token: string): string {
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
