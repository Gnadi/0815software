import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';

/**
 * Per-account login backoff.
 *
 * The per-IP rate limiter in `hardening.ts` bounds how fast ONE source can
 * try. It does nothing about the attack that matters here: a password spray
 * spread over many addresses, each of them well under the limit, all aimed at
 * the same account. What has to get expensive is guessing at that account.
 *
 * So every attempt against a given (organization, email) pays a delay that
 * grows once the failures pass a threshold. Nobody is ever locked out — a
 * lockout would hand anyone who knows an email address a way to keep its owner
 * out — the attempts simply stop being cheap. A correct password clears the
 * record, so a legitimate user waits once and is then back to normal.
 *
 * The key is the SUBMITTED organization and email, whether or not either
 * exists. Throttling only real accounts would make the response time reveal
 * which addresses are real — the same leak `DUMMY_PASSWORD_HASH` exists to
 * close on the hashing side.
 */

export interface ThrottleConfig {
  /** Failures tolerated before any delay applies. */
  threshold: number;
  /** Delay for the first throttled attempt; doubles per failure after it. */
  baseMs: number;
  /** Ceiling for the delay. */
  maxMs: number;
  /** Failures older than this are forgotten. */
  windowMs: number;
}

export const DEFAULT_THROTTLE: ThrottleConfig = {
  threshold: 5,
  baseMs: 1_000,
  maxMs: 30_000,
  windowMs: 15 * 60_000,
};

export function throttleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ThrottleConfig {
  const num = (raw: string | undefined, fallback: number): number => {
    const value = Number(raw);
    return raw !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    threshold: num(env.LOGIN_THROTTLE_THRESHOLD, DEFAULT_THROTTLE.threshold),
    baseMs: num(env.LOGIN_THROTTLE_BASE_MS, DEFAULT_THROTTLE.baseMs),
    maxMs: num(env.LOGIN_THROTTLE_MAX_MS, DEFAULT_THROTTLE.maxMs),
    windowMs: num(env.LOGIN_THROTTLE_WINDOW_MS, DEFAULT_THROTTLE.windowMs),
  };
}

/** Sleep for the computed delay. Injectable so tests never actually wait. */
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function keyOf(orgSlug: string, email: string): string {
  return `${orgSlug.toLowerCase()}\n${email.toLowerCase()}`;
}

interface ThrottleRow {
  fails: number;
  updated_at: string;
}

/** Failures recorded for an account within the window; stale rows read as 0. */
export function failureCount(
  db: Database.Database,
  orgSlug: string,
  email: string,
  config: ThrottleConfig,
  now: number,
): number {
  const row = db.prepare('SELECT fails, updated_at FROM login_throttle WHERE key = ?').get(keyOf(orgSlug, email)) as
    | ThrottleRow
    | undefined;
  if (!row) return 0;
  if (now - Date.parse(row.updated_at) > config.windowMs) return 0;
  return row.fails;
}

/** How long this attempt has to wait, given the failures already on record. */
export function delayFor(fails: number, config: ThrottleConfig): number {
  if (fails < config.threshold || config.baseMs <= 0) return 0;
  const doublings = fails - config.threshold;
  // 2 ** 30 ms is already a month; the cap applies long before that, and the
  // clamp keeps the shift away from Infinity on an absurd counter.
  const raw = config.baseMs * 2 ** Math.min(doublings, 30);
  return Math.min(config.maxMs, raw);
}

/** Record a failed attempt; a stale record restarts rather than accumulating. */
export function recordFailure(
  db: Database.Database,
  orgSlug: string,
  email: string,
  config: ThrottleConfig,
  now: number,
): void {
  const key = keyOf(orgSlug, email);
  const fails = failureCount(db, orgSlug, email, config, now) + 1;
  db.prepare(
    `INSERT INTO login_throttle (key, fails, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, updated_at = excluded.updated_at`,
  ).run(key, fails, nowIso(now));
}

/** Forget an account's failures — what a correct password earns. */
export function clearFailures(db: Database.Database, orgSlug: string, email: string): void {
  db.prepare('DELETE FROM login_throttle WHERE key = ?').run(keyOf(orgSlug, email));
}

/** Drop records past the window so the table tracks live attempts only. */
export function pruneThrottle(db: Database.Database, config: ThrottleConfig, now: number): number {
  return db.prepare('DELETE FROM login_throttle WHERE updated_at < ?').run(nowIso(now - config.windowMs)).changes;
}
