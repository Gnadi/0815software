/**
 * Production boot guard.
 *
 * Every service ships local-dev defaults for its secrets so `npm run dev:api`
 * works out of the box. In production those defaults are a critical
 * misconfiguration, so the guard REFUSES TO BOOT (throws before `listen`)
 * when NODE_ENV=production and any secret still carries a well-known default.
 * Outside production it stays silent — the existing console warnings cover dev.
 */

const KNOWN_DEFAULTS = new Set([
  'dev-secret-change-me',
  'change-me',
  'admin',
  'agent',
  'dev-service-token',
  'dev-webhook-secret',
  'dev-intake-secret',
  '0'.repeat(64), // PS-05 all-zero encryption key
]);

export interface SecretCheck {
  /** Env-style name shown in the error message, e.g. "SESSION_SECRET". */
  name: string;
  value: string | undefined;
}

export function assertProductionConfig(secrets: SecretCheck[], env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  const offenders = secrets.filter((s) => s.value !== undefined && KNOWN_DEFAULTS.has(s.value));
  if (offenders.length > 0) {
    throw new Error(
      `refusing to start in production with default secrets: ${offenders.map((o) => o.name).join(', ')} — ` +
        'set real values (openssl rand -hex 32) before deploying',
    );
  }
}
