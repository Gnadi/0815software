import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * The reporter's access code — the only credential in this module that
 * matters, and the one thing it deliberately cannot recover.
 *
 * A whistleblower has no account, no email and no name. The code is how they
 * come back to read the answer they are owed and to add to their report, and
 * it is the ONLY link between the person and the case. That shapes three
 * decisions:
 *
 * 1. **It is random, not derived.** MOD-12 signs its ticket ref with the
 *    server secret, which is fine for a help desk: anyone who legitimately
 *    knows a ref may see the ticket. Here the ref must NOT be enough. A code
 *    derived from the ref would mean a handler who can list case refs — or
 *    anyone who ever sees the secret — can read every reporter's channel and
 *    post as them.
 * 2. **Only its hash is stored.** A database copy, a backup on a laptop or a
 *    subpoena of the file yields hashes, not codes. Nobody in the
 *    organisation, including whoever runs it, can open a reporter's channel.
 * 3. **A lost code cannot be reset.** There is no "forgot my code" flow,
 *    because building one would require knowing who the reporter is — which
 *    is precisely what this module refuses to know. The UI says so plainly
 *    at the moment the code is shown.
 *
 * SHA-256 rather than scrypt: the code has 100 bits of entropy from a CSPRNG,
 * so there is no dictionary to run and no cost factor that would add
 * anything. (Compare `auth.ts`, where the admin PASSWORD is human-chosen and
 * therefore hashed with a KDF.)
 */

/**
 * Crockford's base32 alphabet: no I, L, O or U. A reporter may be copying
 * this off a screen onto paper under stress, and 0/O and 1/I/L are the pairs
 * that get transcribed wrong.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 20 symbols × 5 bits = 100 bits of entropy. */
const LENGTH = 20;
const GROUP = 4;

export function generateCode(): string {
  let raw = '';
  for (let i = 0; i < LENGTH; i += 1) {
    // randomInt is rejection-sampled, so no modulo bias — and 32 divides 256
    // anyway, but relying on that would break the day the alphabet changes.
    raw += ALPHABET[randomInt(ALPHABET.length)];
  }
  return raw.match(new RegExp(`.{1,${GROUP}}`, 'g'))!.join('-');
}

/**
 * Fold a code the way a human might have typed it back: any case, any
 * grouping, spaces instead of dashes. Transcription slips must not cost
 * somebody their only way back into their own report.
 */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function hashCode(input: string): string {
  return createHash('sha256').update(normalizeCode(input)).digest('hex');
}

/** Is this even shaped like a code? Cheap rejection before touching the db. */
export function looksLikeCode(input: unknown): input is string {
  if (typeof input !== 'string') return false;
  const normalized = normalizeCode(input);
  return normalized.length === LENGTH && [...normalized].every((char) => ALPHABET.includes(char));
}

/**
 * Constant-time comparison of two hex digests.
 *
 * The lookup itself is by indexed hash, so this is belt and braces rather
 * than the load-bearing defence — but a comparison that returns early is a
 * habit worth not having in the one file that guards a whistleblower's
 * identity.
 */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
