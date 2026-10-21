import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ACCESS_LEVELS, type AccessLevel } from '@0815software/platform-clients';
import { ACCESS_RULES, MODULE_SLUG } from '../server/access.js';
import { COOKIE_NAME, createToken, readToken, requireAuth, type AuthConfig } from '../server/auth.js';
import { buildLoginVerifier } from '../server/sso.js';

/**
 * Access levels: what a signed-in person may do here, and the one place that
 * enforces it.
 *
 * Byte-identical in every module with a staff login. What differs between them
 * is `server/access.ts` — the rules — and this suite reads them rather than
 * restating them, so it proves each module's own policy without being edited
 * per module.
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

const cookieFor = (access: AccessLevel): string => `${COOKIE_NAME}=${createToken(auth, 'ada@example', Date.now(), access)}`;

/** The session gate in front of a stand-in for every route: past it is 204. */
function gated(): express.Express {
  const app = express();
  app.use('/api', requireAuth(auth));
  app.use((_req, res) => {
    res.status(204).end();
  });
  return app;
}

/** A rule's path with every `:param` filled in. */
const concrete = (path: string): string => path.replace(/:[^/]+/g, '1');

const send = (app: express.Express, method: string, path: string, cookie: string) =>
  request(app)[method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](path).set('Cookie', cookie);

describe('the session token carries the level', () => {
  it('round-trips every level, and an omitted one is the local admin’s', () => {
    for (const access of ACCESS_LEVELS) {
      expect(readToken(auth, createToken(auth, 'ada@example', Date.now(), access))).toEqual({ actor: 'ada@example', access });
    }
    expect(readToken(auth, createToken(auth))).toEqual({ actor: 'admin', access: 'manage' });
  });

  it('cannot be raised by editing the token', () => {
    const [expiry, actor, , mac] = createToken(auth, 'ada@example', Date.now(), 'view').split('.');
    expect(readToken(auth, [expiry, actor, 'manage', mac].join('.'))).toBeNull();
    // Nor by dropping the level to look like the older, admin-only format.
    expect(readToken(auth, [expiry, actor, mac].join('.'))).toBeNull();
  });
});

describe('the gate', () => {
  it('lets view read and nothing more', async () => {
    const app = gated();
    await send(app, 'GET', '/api/anything', cookieFor('view')).expect(204);
    const write = await send(app, 'POST', '/api/anything', cookieFor('view')).expect(403);
    expect(write.body).toEqual({ error: 'Insufficient access', required: 'edit', access: 'view' });
  });

  it('lets edit write by default', async () => {
    const app = gated();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await send(app, method, '/api/anything', cookieFor('edit')).expect(204);
    }
  });

  it('never refuses signing out', async () => {
    await send(gated(), 'POST', '/api/logout', cookieFor('view')).expect(204);
  });

  it('applies every rule in server/access.ts', async () => {
    const app = gated();
    for (const rule of ACCESS_RULES) {
      const path = concrete(rule.path);
      await send(app, rule.method, path, cookieFor(rule.access)).expect(204);
      const below = ACCESS_LEVELS[ACCESS_LEVELS.indexOf(rule.access) - 1];
      if (below) await send(app, rule.method, path, cookieFor(below)).expect(403);
    }
  });

  it('still answers 401, not 403, without a session', async () => {
    await request(gated()).get('/api/anything').expect(401);
  });
});

describe('server/access.ts', () => {
  it('names only routes this module actually has', () => {
    const app = readFileSync(new URL('../server/app.ts', import.meta.url), 'utf8');
    for (const rule of ACCESS_RULES) {
      expect(app, `${rule.method} ${rule.path}`).toContain(`app.${rule.method.toLowerCase()}('${rule.path}'`);
    }
  });

  it('uses this module’s registry slug', () => {
    const registry = JSON.parse(readFileSync(new URL('../../registry.json', import.meta.url), 'utf8')) as {
      modules: { id: string; slug: string }[];
    };
    const here = new URL('..', import.meta.url).pathname.split('/').filter(Boolean).pop();
    expect(registry.modules.find((m) => m.id === here)?.slug).toBe(MODULE_SLUG);
  });
});

describe('an SSO login gets the level PS-01 grants', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A PS-01 that knows one user, holding `permissions`. */
  function identity(permissions: string[]) {
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      const body =
        path === '/api/login'
          ? { token: 'ps01-token', user: { id: 1, email: 'ada@example' } }
          : { valid: true, permissions };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    return buildLoginVerifier({ identityUrl: 'http://identity.test', identityOrg: 'acme' });
  }

  // The two shells still admit platform administrators only (see their sso.ts).
  const shell = MODULE_SLUG === 'workspace' || MODULE_SLUG === 'mosaic';

  it('platform:admin manages, as it always did', async () => {
    const outcome = await identity(['platform:admin'])('ada@example', 'pw');
    expect(outcome).toMatchObject({ ok: true, actor: 'ada@example', access: 'manage' });
  });

  it(shell ? 'a module grant alone does not open a shell' : 'a module grant gives exactly its level', async () => {
    const outcome = await identity([`module:${MODULE_SLUG}:view`])('ada@example', 'pw');
    if (shell) expect(outcome).toEqual({ ok: false, reason: 'rejected' });
    else expect(outcome).toMatchObject({ ok: true, access: 'view' });
  });

  it('no grant on this module is a rejected login', async () => {
    const outcome = await identity(['org:read', 'module:some-other-module:manage'])('ada@example', 'pw');
    expect(outcome).toEqual({ ok: false, reason: 'rejected' });
  });
});
