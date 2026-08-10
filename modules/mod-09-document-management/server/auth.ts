import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

export interface SessionConfig {
  secret: string;
  ttlHours: number;
  secureCookie: boolean;
}

export const COOKIE_NAME = 'mod09_session';

const SCRYPT_KEYLEN = 64;

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Password hashing (node built-in scrypt, no extra dependencies) ─────
//
// ASYNCHRONOUS ON PURPOSE. scrypt is deliberately expensive (~90ms a call) and
// `scryptSync` spends all of it on the event loop, so while one user's password
// is being checked this single-threaded server answers nobody — not the other
// logins, not the documents everyone already signed in is opening. The callback
// form runs the same work on libuv's threadpool instead, which is why
// everything that hashes a password here is async up to the request handler.

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/** Hash a password as "scrypt:<salt hex>:<derived key hex>". */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = await scryptAsync(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN);
  return safeEqual(key, Buffer.from(keyHex, 'hex'));
}

/**
 * A hash of a random password, used to burn the same scrypt work when a
 * login hits an unknown username — so response timing does not reveal
 * whether an account exists. Memoized, so the cost is paid once.
 */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}

// ── Stateless HMAC-signed session token ────────────────────────────────
// Token: "<userId>.<tokenVersion>.<expiryMillis>.<hmac(payload)>".
// The token version is stored per user and bumped on password change,
// which invalidates every previously issued token for that account.

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export interface SessionClaims {
  userId: number;
  tokenVersion: number;
}

export function createToken(config: SessionConfig, claims: SessionClaims, now = Date.now()): string {
  const payload = `${claims.userId}.${claims.tokenVersion}.${now + config.ttlHours * 3600_000}`;
  return `${payload}.${sign(payload, config.secret)}`;
}

export function verifyToken(
  config: SessionConfig,
  token: string,
  now = Date.now(),
): SessionClaims | null {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [id, version, expiry, mac] = parts as [string, string, string, string];
  if (!/^\d+$/.test(id) || !/^\d+$/.test(version) || !/^\d+$/.test(expiry)) return null;
  if (Number(expiry) < now) return null;
  const expected = sign(`${id}.${version}.${expiry}`, config.secret);
  if (!safeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  return { userId: Number(id), tokenVersion: Number(version) };
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
