import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';

/**
 * Tell a person when something happens to their account that they did not
 * necessarily do: a sign-in from a device never seen before, the second
 * factor switched off or reset, a recovery code spent, the password changed,
 * someone guessing at it. These are the events an attacker causes on the way
 * in, and the owner is the one person who can tell them apart from their own.
 *
 * Delivered through PS-03 as `security` events — through quiet hours and
 * through every mute (server/notify.ts there). Opt-in like every platform
 * call: with NOTIFICATION_URL unset nothing leaves this service, and a PS-03
 * that is down never fails the sign-in that caused the event (CLAUDE.md
 * rule 1). Fire-and-forget with a short timeout for the same reason.
 */

export interface SecurityNotifyConfig {
  url: string;
  serviceToken: string;
}

export type SecurityKind =
  | 'new-device'
  | 'mfa-disabled'
  | 'mfa-reset'
  | 'mfa-enabled'
  | 'recovery-code-used'
  | 'password-changed'
  | 'password-reset'
  | 'sessions-revoked'
  | 'login-throttled';

const TITLES: Record<SecurityKind, string> = {
  'new-device': 'New sign-in to your account',
  'mfa-disabled': 'Two-factor sign-in was turned off',
  'mfa-reset': 'An administrator reset your two-factor sign-in',
  'mfa-enabled': 'Two-factor sign-in was turned on',
  'recovery-code-used': 'A recovery code was used to sign in',
  'password-changed': 'Your password was changed',
  'password-reset': 'An administrator set a new password for you',
  'sessions-revoked': 'You were signed out everywhere',
  'login-throttled': 'Someone keeps trying to sign in as you',
};

export type SecurityNotifier = (input: {
  kind: SecurityKind;
  email: string;
  detail: string | null;
  /** Makes repeats of one occurrence one notification. */
  key: string;
}) => void;

export const noopSecurityNotifier: SecurityNotifier = () => {};

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<unknown>;

export function buildSecurityNotifier(cfg: SecurityNotifyConfig | null, doFetch?: FetchLike): SecurityNotifier {
  if (!cfg) return noopSecurityNotifier;
  const send = doFetch ?? (globalThis.fetch as unknown as FetchLike);
  return ({ kind, email, detail, key }) => {
    void Promise.resolve()
      .then(() =>
        send(`${cfg.url.replace(/\/$/, '')}/api/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Service-Token': cfg.serviceToken },
          body: JSON.stringify({
            module: 'identity',
            kind,
            category: 'security',
            urgency: 'now',
            security: true,
            recipients: [email],
            title: TITLES[kind],
            detail,
            href: null,
            idempotency_key: `identity:${kind}:${key}`,
          }),
          signal: AbortSignal.timeout(3000),
        }),
      )
      .catch((err: unknown) => console.warn('[ps-01] security notification failed:', err));
  };
}

// ── Devices ────────────────────────────────────────────────────────────
//
// "New device" means a browser family on an operating system this person has
// not signed in from before — coarse on purpose. The full user-agent string
// changes with every browser update, and a warning that fires every month
// teaches people to ignore it. Coarse enough that a phone and a laptop differ,
// and a thief's laptop most likely differs from yours.

export function deviceLabel(userAgent: string | undefined | null): string | null {
  if (!userAgent) return null;
  const ua = userAgent;
  const os = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua)
      ? 'iOS'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/i.test(ua)
          ? 'macOS'
          : /CrOS/i.test(ua)
            ? 'ChromeOS'
            : /Linux/i.test(ua)
              ? 'Linux'
              : 'unknown system';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser/.test(ua)
      ? 'Samsung Internet'
      : /Firefox\/|FxiOS/.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS/.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'unknown browser';
  return `${browser} on ${os}`;
}

/**
 * Note the device of a successful sign-in. Returns true when it is new for an
 * account that had signed in from somewhere before — the very first sign-in
 * of an account is everyone's first, and warning about it says nothing.
 */
export function rememberDevice(db: Database.Database, userId: number, label: string, nowMs: number): boolean {
  const fingerprint = createHash('sha256').update(label).digest('hex').slice(0, 32);
  const at = nowIso(nowMs);
  if (db.prepare('SELECT 1 FROM known_devices WHERE user_id = ? AND fingerprint = ?').get(userId, fingerprint)) {
    db.prepare('UPDATE known_devices SET last_seen = ? WHERE user_id = ? AND fingerprint = ?').run(at, userId, fingerprint);
    return false;
  }
  const seenBefore = (db.prepare('SELECT COUNT(*) AS n FROM known_devices WHERE user_id = ?').get(userId) as { n: number }).n > 0;
  db.prepare('INSERT INTO known_devices (user_id, fingerprint, label, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)').run(
    userId,
    fingerprint,
    label,
    at,
    at,
  );
  return seenBefore;
}
