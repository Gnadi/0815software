import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238 on top of RFC 4226 HOTP), with the
 * RFC 4648 base32 every authenticator app expects for the shared secret.
 *
 * Written against Node's crypto rather than pulled in, because the whole of it
 * is an HMAC and a truncation — and because it is pinned to the RFCs' own
 * reference vectors (`test/totp.test.ts`), which is the evidence that matters
 * here, not a library's reputation.
 *
 * Parameters are the ones every app agrees on without being told: SHA-1, six
 * digits, 30-second steps. Anything else is technically allowed by the
 * `otpauth://` format and silently ignored by enough apps (Google
 * Authenticator ignored `algorithm` for years) that a code which "never works"
 * is the likely outcome.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/**
 * Steps accepted either side of now. One step tolerates a phone clock that is
 * up to 30 s off and a code typed just as it rolled over; more widens the
 * window an observed code stays usable for, which the replay guard narrows
 * again but does not remove.
 */
export const TOTP_DRIFT_STEPS = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Buffer): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  while (out.length % 8 !== 0) out += '=';
  return out;
}

/** Decode base32, tolerant of case, spaces and missing padding (people type these). */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 character "${ch}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 4226 HOTP: HMAC over the 8-byte counter, dynamic truncation, modulo 10^digits. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS, algorithm = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The RFC 6238 time step for a wall-clock instant. */
export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export function totp(secret: Buffer, nowMs: number, digits = TOTP_DIGITS, algorithm = 'sha1'): string {
  return hotp(secret, stepAt(nowMs), digits, algorithm);
}

/**
 * The step a submitted code belongs to, or null if it matches none in the
 * drift window. Returning the STEP rather than a boolean is what makes the
 * replay guard possible: the caller records it and refuses any code from that
 * step or an earlier one, so a code read over someone's shoulder is dead the
 * moment its owner has used it.
 *
 * Every candidate is compared, in constant time, even after a match — the
 * loop's duration must not say which step matched.
 */
export function matchStep(secret: Buffer, code: string, nowMs: number, drift = TOTP_DRIFT_STEPS): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepAt(nowMs);
  let matched: number | null = null;
  for (let step = now - drift; step <= now + drift; step++) {
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code)) && matched === null) matched = step;
  }
  return matched;
}

/** A fresh 160-bit secret — the length RFC 4226 recommends for SHA-1. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20)).replace(/=+$/, '');
}

/**
 * The `otpauth://` URI an authenticator app scans as a QR code. Issuer goes in
 * both the label and the parameter: older apps read only the label, newer ones
 * prefer the parameter, and each shows the account under the wrong name if the
 * other is missing.
 */
export function otpauthUri(secret: string, issuer: string, account: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── Recovery codes ─────────────────────────────────────────────────────
//
// The answer to "my phone is gone": ten single-use codes shown once at
// enrolment. Stored as SHA-256, not scrypt — each carries 50 bits from a CSPRNG,
// so there is no dictionary to slow down, and the login path already pays one
// scrypt for the password. The alphabet drops 0/O and 1/I/L, because these get
// read off paper.

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function newRecoveryCode(): string {
  // Rejection sampling: 256 is not a multiple of the alphabet's 31 letters,
  // and a plain modulo would make the first eight a little likelier.
  const limit = 256 - (256 % RECOVERY_ALPHABET.length);
  let s = '';
  while (s.length < 10) {
    for (const b of randomBytes(16)) {
      if (b < limit && s.length < 10) s += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
    }
  }
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** Normalize what was typed (case, spaces, a missing dash) before hashing it. */
export function normalizeRecoveryCode(input: string): string | null {
  const clean = input.toLowerCase().replace(/[\s-]/g, '');
  if (clean.length !== 10 || [...clean].some((c) => !RECOVERY_ALPHABET.includes(c))) return null;
  return `${clean.slice(0, 5)}-${clean.slice(5)}`;
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
