/**
 * Production boot guard.
 *
 * Every service ships local-dev defaults for its secrets so `npm run dev:api`
 * works out of the box. In production those defaults are a critical
 * misconfiguration, so the guard REFUSES TO BOOT (throws before `listen`)
 * when NODE_ENV=production and any secret is unusable.
 * Outside production it stays silent — the existing console warnings cover dev.
 *
 * Two ways a secret is unusable, and the second is the likelier accident:
 *
 *  - it still carries a **well-known default** from the shipped .env.example;
 *  - it is **empty or blank**. Config reads secrets as `env.X ?? 'dev-default'`,
 *    and `??` falls back only on undefined — so `SESSION_SECRET=` in a compose
 *    file, or an unset variable interpolated into one, yields an EMPTY secret
 *    rather than the default. That boots a service whose session HMAC is keyed
 *    on the empty string (forgeable by anyone who guesses it is empty) and
 *    whose admin login accepts an empty password. Checking only against known
 *    defaults let exactly that through.
 *
 * In THIS service one secret is worse to get wrong than the others.
 * `EBICS_KEY_SECRET` encrypts the RSA private keys that sign payments, so
 * booting on the shipped default means every key in the store is encrypted
 * under a value published in this repository. `keystore.ts` adds the other
 * half of that check: it refuses to start when the configured secret cannot
 * decrypt what is already stored, because a silently rotated secret is
 * unrecoverable without re-initialising with the bank on paper.
 */

const KNOWN_DEFAULTS = new Set([
  'dev-secret-change-me',
  'change-me',
  'admin',
  'agent',
  'dev-service-token',
  'dev-webhook-secret',
  'dev-intake-secret',
  '0'.repeat(64), // PS-05 all-zero encryption key, and PS-12's key-store default
]);

export interface SecretCheck {
  /** Env-style name shown in the error message, e.g. "SESSION_SECRET". */
  name: string;
  value: string | undefined;
}

export function assertProductionConfig(secrets: SecretCheck[], env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;

  const blank: string[] = [];
  const defaulted: string[] = [];
  for (const secret of secrets) {
    if (secret.value === undefined) continue; // genuinely optional — not set, not used
    if (secret.value.trim() === '') blank.push(secret.name);
    else if (KNOWN_DEFAULTS.has(secret.value)) defaulted.push(secret.name);
  }

  const problems: string[] = [];
  if (defaulted.length > 0) problems.push(`still set to a shipped default: ${defaulted.join(', ')}`);
  if (blank.length > 0) problems.push(`empty or blank: ${blank.join(', ')}`);
  if (problems.length > 0) {
    throw new Error(
      `refusing to start in production with unusable secrets — ${problems.join('; ')}. ` +
        'Set real values (openssl rand -hex 32) before deploying.',
    );
  }
}
