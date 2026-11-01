import { describe, expect, it } from 'vitest';
import { clearedCookie, COOKIE_NAME } from '../server/auth.js';
import { signOutResponse } from '../server/handoff.js';

/**
 * Signing out from the shell (server/handoff.ts: signOutResponse) — copy-in,
 * byte-identical in every module a shell can frame. The route that serves it
 * is mounted beside the handoff routes; deploy/test/pwa.test.ts checks that
 * every module with a handoff mounts it.
 */

describe('GET /session/logout, as the shell asks it', () => {
  it('ends this module\'s session and what it kept in this browser — from the stack only', () => {
    for (const site of ['same-origin', 'same-site']) {
      const out = signOutResponse(site, clearedCookie());
      expect(out.status).toBe(200);
      expect(out.headers['Set-Cookie']).toBe(clearedCookie());
      expect(out.headers['Set-Cookie']).toMatch(new RegExp(`^${COOKIE_NAME}=;.*Max-Age=0`));
      expect(out.headers['Clear-Site-Data']).toBe('"storage"');
      expect(out.headers['Cache-Control']).toBe('no-store');
    }
  });

  it('never clears the cookies of the whole domain', () => {
    expect(signOutResponse('same-site', clearedCookie()).headers['Clear-Site-Data']).not.toContain('cookies');
  });

  it('refuses a cross-site page, a typed-in address and a browser that does not say', () => {
    for (const site of ['cross-site', 'none', undefined, '', ['same-site']]) {
      const out = signOutResponse(site, clearedCookie());
      expect(out.status, String(site)).toBe(403);
      expect(out.headers['Set-Cookie']).toBeUndefined();
      expect(out.headers['Clear-Site-Data']).toBeUndefined();
    }
  });
});
