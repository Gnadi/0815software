import { createHmac, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nowIso, type SessionConfig } from './auth.js';
import type { UserRow } from './identity.js';
import {
  base32Decode,
  hashRecoveryCode,
  matchStep,
  newRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
} from './totp.js';

/**
 * Two-factor sign-in: something you know (the password) and something you
 * hold (the phone with the authenticator app on it).
 *
 * Why it lives here and nowhere else: every module that delegates logins to
 * PS-01 (`server/sso.ts` in each) forwards the code it was given, so one
 * enrolment protects every module that person can reach — on the phone from
 * outside the office included, which is the case that made it necessary. A
 * stack exposed to the internet with password-only logins is one reused
 * password away from someone else's invoices.
 *
 * The factor is opt-in per person. Making it mandatory per organization needs
 * an enrolment step inside the login flow and is the next step
 * (docs/MOBILE-PLAN.md); until then an administrator can see who has it
 * (`mfa_enabled` on the user list) and reset it for someone who lost their
 * phone (`POST /api/users/:id/mfa/reset`).
 *
 * The TOTP secret is stored as is. Encrypting it under a key from this
 * service's own environment would protect nothing against someone who holds
 * both the database and the environment, and would turn a rotation of that
 * key into "everyone's authenticator stops working". The database already
 * holds the password hashes and is backed up as key material
 * (docs/PROVISIONING.md); the secret is in the same class.
 */

export interface UserMfaRow extends UserRow {
  totp_secret: string | null;
  totp_enabled_at: string | null;
  totp_last_step: number | null;
  totp_pending_secret: string | null;
  totp_pending_at: string | null;
}

/** How long a scanned-but-unconfirmed secret stays usable. */
export const PENDING_TTL_MS = 15 * 60_000;
/** How long the gap between "password was right" and "now the code" may be (OAuth path). */
export const MFA_TICKET_TTL_MS = 5 * 60_000;

export function hasSecondFactor(user: UserRow): boolean {
  return (user as UserMfaRow).totp_enabled_at != null && (user as UserMfaRow).totp_secret != null;
}

export type FactorVerdict =
  | { ok: true; via: 'totp'; step: number }
  | { ok: true; via: 'recovery'; codeId: number }
  | { ok: false };

/**
 * Check a submitted code against the user's factor, WITHOUT consuming it.
 * Consumption (`consumeFactor`) is separate so the caller can decide to spend
 * a code only when everything else about the request also holds.
 *
 * A six-digit string is a TOTP; anything else is tried as a recovery code. A
 * TOTP from a step at or before the last one used is refused — replay.
 */
export function checkFactor(db: Database.Database, user: UserMfaRow, input: unknown, nowMs: number): FactorVerdict {
  if (typeof input !== 'string' || !user.totp_secret) return { ok: false };
  const code = input.replace(/\s/g, '');
  if (/^\d{6}$/.test(code)) {
    const step = matchStep(base32Decode(user.totp_secret), code, nowMs);
    if (step === null) return { ok: false };
    if (user.totp_last_step !== null && step <= user.totp_last_step) return { ok: false };
    return { ok: true, via: 'totp', step };
  }
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) return { ok: false };
  const hash = Buffer.from(hashRecoveryCode(normalized));
  const rows = db
    .prepare('SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
    .all(user.id) as { id: number; code_hash: string }[];
  let found: number | null = null;
  for (const row of rows) {
    const stored = Buffer.from(row.code_hash);
    if (stored.length === hash.length && timingSafeEqual(stored, hash) && found === null) found = row.id;
  }
  return found === null ? { ok: false } : { ok: true, via: 'recovery', codeId: found };
}

/** Spend what `checkFactor` accepted: advance the replay guard or burn the recovery code. */
export function consumeFactor(db: Database.Database, user: UserMfaRow, verdict: FactorVerdict, nowMs: number): void {
  if (!verdict.ok) return;
  if (verdict.via === 'totp') {
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(verdict.step, user.id);
  } else {
    db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL').run(
      nowIso(nowMs),
      verdict.codeId,
    );
  }
}

/** Replace every recovery code of a user with a fresh set; the plain codes are returned once. */
export function renewRecoveryCodes(db: Database.Database, userId: number, nowMs: number): string[] {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  db.transaction(() => {
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
    const insert = db.prepare('INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)');
    for (const code of codes) insert.run(userId, hashRecoveryCode(code), nowIso(nowMs));
  })();
  return codes;
}

export function recoveryCodesLeft(db: Database.Database, userId: number): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId) as {
      n: number;
    }
  ).n;
}

/** Remove the factor entirely — on the owner's request or an administrator's reset. */
export function clearSecondFactor(db: Database.Database, userId: number): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL,
                        totp_pending_secret = NULL, totp_pending_at = NULL
       WHERE id = ?`,
    ).run(userId);
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  })();
}

// ── The half-way ticket ────────────────────────────────────────────────
//
// A provider sign-in (OAuth) proves the first factor on a redirect, with no
// form to type a code into. Issuing a session there would make the provider
// a way around the second factor; instead the callback hands out this ticket,
// which says "the first factor is done for this user" and nothing else. It is
// not a session: it is signed under its own label, has a different shape, and
// only `POST /api/login/mfa` accepts it. Bound to `token_version`, so a
// password change or a revocation kills tickets in flight too.

function signTicket(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`mfa-ticket:${payload}`).digest('hex');
}

export function mintMfaTicket(session: SessionConfig, user: UserRow, nowMs: number): string {
  const payload = `${user.id}.${user.token_version}.${nowMs + MFA_TICKET_TTL_MS}`;
  return `mfa.${payload}.${signTicket(session.secret, payload)}`;
}

export function verifyMfaTicket(
  session: SessionConfig,
  ticket: unknown,
  nowMs: number,
): { userId: number; tokenVersion: number } | null {
  if (typeof ticket !== 'string') return null;
  const parts = ticket.split('.');
  if (parts.length !== 5 || parts[0] !== 'mfa') return null;
  const [, userId, version, expiry, mac] = parts as [string, string, string, string, string];
  if (![userId, version, expiry].every((p) => /^\d+$/.test(p))) return null;
  if (Number(expiry) < nowMs) return null;
  const expected = Buffer.from(signTicket(session.secret, `${userId}.${version}.${expiry}`));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { userId: Number(userId), tokenVersion: Number(version) };
}
