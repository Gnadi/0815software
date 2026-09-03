/**
 * The production boot guard, as a unit.
 *
 * `boot.test.ts` proves `server/index.ts` really calls this and really refuses;
 * this file proves the decision itself, across the combinations a deployment
 * actually produces. Both are wanted: the subprocess case is the one that would
 * catch somebody deleting the call, and this one is where the rule lives.
 *
 * `server/guard.ts` is copy-in and byte-identical across every package, so a
 * case here is a case for all twenty-eight of them.
 */
import { describe, expect, it } from 'vitest';
import { assertProductionConfig } from '../server/guard.js';

const prod = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const dev = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;

const check = (secrets: { name: string; value: string | undefined }[], env = prod): (() => void) =>
  () => assertProductionConfig(secrets, env);

describe('outside production it never refuses', () => {
  it('lets every shipped default through — that is what dev is for', () => {
    expect(check([{ name: 'SESSION_SECRET', value: 'dev-secret-change-me' }], dev)).not.toThrow();
    expect(check([{ name: 'ADMIN_PASSWORD', value: '' }], dev)).not.toThrow();
    expect(check([{ name: 'SESSION_SECRET', value: 'change-me' }], {} as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe('in production it refuses a secret that is not one', () => {
  it('refuses every known shipped default', () => {
    for (const value of [
      'dev-secret-change-me',
      'change-me',
      'admin',
      'agent',
      'dev-service-token',
      'dev-webhook-secret',
      'dev-intake-secret',
      '0'.repeat(64), // PS-05's all-zero encryption key
    ]) {
      expect(check([{ name: 'SECRET', value }]), value).toThrow(/still set to a shipped default: SECRET/);
    }
  });

  it('refuses an empty or whitespace value', () => {
    // `??` falls back only on undefined, so `SESSION_SECRET=` in a compose file
    // yields an EMPTY secret rather than the dev default: a session HMAC keyed
    // on the empty string, and an admin login that accepts an empty password.
    for (const value of ['', ' ', '\t', '\n  ']) {
      expect(check([{ name: 'SESSION_SECRET', value }]), JSON.stringify(value)).toThrow(
        /empty or blank: SESSION_SECRET/,
      );
    }
  });

  it('reports both kinds at once, and every offending name', () => {
    const err = (): void =>
      assertProductionConfig(
        [
          { name: 'SESSION_SECRET', value: 'change-me' },
          { name: 'SERVICE_TOKEN', value: '' },
          { name: 'WEBHOOK_SECRET', value: 'dev-webhook-secret' },
          { name: 'FINE', value: 'a'.repeat(64) },
        ],
        prod,
      );
    expect(err).toThrow(/still set to a shipped default: SESSION_SECRET, WEBHOOK_SECRET/);
    expect(err).toThrow(/empty or blank: SERVICE_TOKEN/);
    expect(err).not.toThrow(/FINE/);
  });

  it('names the fix, so the log says what to do', () => {
    expect(check([{ name: 'SECRET', value: 'admin' }])).toThrow(/openssl rand -hex 32/);
  });
});

describe('what it deliberately allows', () => {
  it('ignores a secret that is not set at all — genuinely optional, not used', () => {
    expect(check([{ name: 'OPTIONAL', value: undefined }])).not.toThrow();
  });

  it('accepts a real value', () => {
    expect(check([{ name: 'SESSION_SECRET', value: 'f3a9c2e1b7d4' }])).not.toThrow();
  });

  it('accepts a value that merely CONTAINS a default, rather than being one', () => {
    // The test is equality, not substring: a generated secret that happens to
    // embed the word must not be refused.
    expect(check([{ name: 'SECRET', value: 'change-me-not-really-abc123' }])).not.toThrow();
  });

  it('accepts an empty list of secrets', () => {
    expect(check([])).not.toThrow();
  });
});
