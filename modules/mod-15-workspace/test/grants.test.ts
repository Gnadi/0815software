import { describe, expect, it } from 'vitest';
import { createGrants, slugOf } from '../server/grants.js';

/**
 * What a shell tells each module about the person it signs in. Byte-identical
 * in both shells (MOD-15, MOD-16), like `server/grants.ts` itself.
 */

describe('grants', () => {
  it('standalone, the local admin manages every module', () => {
    const grants = createGrants({ sso: false, ttlMs: 1000 });
    expect(grants.levelFor('admin', 'mod-04-invoice-billing')).toEqual({ ok: true, access: 'manage' });
  });

  it('with SSO, each module gets the level PS-01 grants on it', () => {
    const grants = createGrants({ sso: true, ttlMs: 1000 });
    grants.remember('ada@example', ['module:offers:view', 'module:*:edit', 'module:crm-lite:manage']);
    expect(grants.levelFor('ada@example', 'mod-13-offers')).toEqual({ ok: true, access: 'edit' });
    expect(grants.levelFor('ada@example', 'mod-10-crm-lite')).toEqual({ ok: true, access: 'manage' });
  });

  it('refuses a module PS-01 grants nothing on, and a person it never saw sign in', () => {
    const grants = createGrants({ sso: true, ttlMs: 1000 });
    grants.remember('ada@example', ['module:offers:view']);
    expect(grants.levelFor('ada@example', 'mod-04-invoice-billing')).toMatchObject({ ok: false });
    expect(grants.levelFor('bob@example', 'mod-13-offers')).toMatchObject({ ok: false, problem: expect.stringMatching(/sign in again/) });
  });

  it('forgets on logout and when the shell session would have expired', () => {
    let clock = 0;
    const grants = createGrants({ sso: true, ttlMs: 1000, now: () => clock });
    grants.remember('ada@example', ['platform:admin']);
    grants.remember('bob@example', ['platform:admin']);
    grants.forget('bob@example');
    expect(grants.levelFor('bob@example', 'mod-13-offers').ok).toBe(false);
    expect(grants.levelFor('ada@example', 'mod-13-offers').ok).toBe(true);
    clock = 1000;
    expect(grants.levelFor('ada@example', 'mod-13-offers').ok).toBe(false);
    expect(grants.size()).toBe(0);
  });

  it('reads the slug the way the registry writes it', () => {
    expect(slugOf('mod-04-invoice-billing')).toBe('invoice-billing');
  });
});
