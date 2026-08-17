import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { loginModeOf } from '../server/sso.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildPlatform, noopPlatform, type PlatformHooks, type TicketCreatedInfo } from '../server/platform.js';
import type { AuthConfig } from '../server/auth.js';

const auth: AuthConfig = {
  username: 'agent',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
  intakeSecret: 'test-intake-secret',
};

let db: Database.Database;

function appWith(platform: PlatformHooks): Express {
  return createApp({ db, auth, now: () => Date.parse('2026-07-19T09:00:00Z'), platform });
}

async function agentCookie(app: Express): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'agent', password: 'test-password' });
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
});

describe('platform integration', () => {
  it('fires ticketCreated on web intake', async () => {
    const calls: TicketCreatedInfo[] = [];
    const app = appWith({
      ...noopPlatform,
      async ticketCreated(info) {
        calls.push(info);
      },
    });
    const res = await request(app)
      .post('/api/intake/web')
      .send({ requester_name: 'Zoe', requester_email: 'zoe@example.com', subject: 'Help', body: 'It broke' });
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ref).toBe(res.body.ref);
    expect(calls[0]!.requesterEmail).toBe('zoe@example.com');
  });

  it('a failing ticketCreated hook never fails intake (best-effort)', async () => {
    const app = appWith({
      ...noopPlatform,
      async ticketCreated() {
        throw new Error('audit log down');
      },
    });
    const res = await request(app)
      .post('/api/intake/web')
      .send({ requester_name: 'Zoe', requester_email: 'zoe@example.com', subject: 'Help', body: 'x' });
    expect(res.status).toBe(201);
  });

  it('suggest-reply returns the AI draft, or 501 when unconfigured', async () => {
    // Configured AI → returns the draft.
    const withAi = appWith({
      ...noopPlatform,
      async suggestReply(info) {
        return `Draft reply for ${info.ref}`;
      },
    });
    const cookie = await agentCookie(withAi);
    const created = await request(withAi)
      .post('/api/intake/web')
      .send({ requester_name: 'Zoe', requester_email: 'zoe@example.com', subject: 'Help', body: 'x' });
    const suggest = await request(withAi).post(`/api/tickets/${created.body.ref}/suggest-reply`).set('Cookie', cookie);
    expect(suggest.status).toBe(200);
    expect(suggest.body.suggestion).toContain(created.body.ref);

    // Standalone (no AI) → 501.
    const standalone = createApp({ db, auth, platform: buildPlatform({}) });
    const c2 = await agentCookie(standalone);
    const s2 = await request(standalone).post(`/api/tickets/${created.body.ref}/suggest-reply`).set('Cookie', c2);
    expect(s2.status).toBe(501);
  });
});


describe('SSO login-exchange', () => {
  it('tells the login form which credentials this deployment accepts', async () => {
    // Public on purpose: the form reads it before anyone is signed in.
    await request(createApp({ db, auth }))
      .get('/api/auth-mode')
      .expect(200)
      .expect({ sso: false });
    await request(createApp({ db, auth, loginMode: { sso: true, org: 'acme' } }))
      .get('/api/auth-mode')
      .expect(200)
      .expect({ sso: true, org: 'acme' });
  });

  it('reads the login mode off the same config the verifier switches on', () => {
    expect(loginModeOf({})).toEqual({ sso: false });
    expect(loginModeOf({ identityUrl: 'http://ps01:4001' })).toEqual({ sso: false });
    expect(loginModeOf({ identityUrl: 'http://ps01:4001', identityOrg: 'acme' })).toEqual({
      sso: true,
      org: 'acme',
    });
  });

  it('lets PS-01 decide the login, bypassing local credentials', async () => {
    // The injected verifier stands in for a configured PS-01: it approves
    // despite a wrong local password, so the module must still issue a session.
    const app = createApp({ db, auth, verifyLogin: async () => ({ ok: true, actor: 'ada@acme.test' }) });
    await request(app).post('/api/login').send({ username: 'agent', password: 'wrong-password' }).expect(200);
  });

  it('rejects when PS-01 rejects, even with correct local credentials', async () => {
    const app = createApp({ db, auth, verifyLogin: async () => ({ ok: false }) });
    await request(app).post('/api/login').send({ username: 'agent', password: 'test-password' }).expect(401);
  });

  it('falls back to local credentials when SSO is unconfigured (null)', async () => {
    const app = createApp({ db, auth, verifyLogin: async () => null });
    await request(app).post('/api/login').send({ username: 'agent', password: 'nope' }).expect(401);
    await request(app).post('/api/login').send({ username: 'agent', password: 'test-password' }).expect(200);
  });
});

describe('the session carries who is acting', () => {
  /** Sign in through a configured PS-01 and keep the resulting session. */
  async function ssoSession(actor: string): Promise<{ app: Express; cookie: string }> {
    const app = createApp({
      db,
      auth,
      now: () => Date.parse('2026-07-19T09:00:00Z'),
      verifyLogin: async () => ({ ok: true, actor }),
    });
    const res = await request(app).post('/api/login').send({ username: 'anything', password: 'anything' });
    expect(res.status).toBe(200);
    expect(res.body.agent).toBe(actor);
    return { app, cookie: res.headers['set-cookie']![0]!.split(';')[0]! };
  }

  it('records the PS-01 identity on the ticket history, not "agent"', async () => {
    const { app, cookie } = await ssoSession('ada@acme.test');
    const created = await request(app)
      .post('/api/intake/web')
      .send({ subject: 'Printer on fire', body: 'again', requester_name: 'R', requester_email: 'r@x.test' });
    const ref = created.body.ref as string;

    await request(app).post(`/api/tickets/${ref}/status`).set('Cookie', cookie).send({ to: 'open' }).expect(200);

    const detail = await request(app).get(`/api/tickets/${ref}`).set('Cookie', cookie);
    const actors = (detail.body.events as { actor: string }[]).map((e) => e.actor);
    expect(actors).toContain('ada@acme.test');
    expect(actors).not.toContain('agent');
  });

  it('tells two people apart on the same ticket', async () => {
    const ada = await ssoSession('ada@acme.test');
    const bob = await ssoSession('bob@acme.test');
    const created = await request(ada.app)
      .post('/api/intake/web')
      .send({ subject: 'Two hands', body: 'x', requester_name: 'R', requester_email: 'r@x.test' });
    const ref = created.body.ref as string;

    await request(ada.app).post(`/api/tickets/${ref}/status`).set('Cookie', ada.cookie).send({ to: 'open' });
    await request(bob.app).post(`/api/tickets/${ref}/priority`).set('Cookie', bob.cookie).send({ priority: 'high' });

    const detail = await request(ada.app).get(`/api/tickets/${ref}`).set('Cookie', ada.cookie);
    const actors = new Set((detail.body.events as { actor: string }[]).map((e) => e.actor));
    expect(actors.has('ada@acme.test')).toBe(true);
    expect(actors.has('bob@acme.test')).toBe(true);
  });

  it('falls back to the local admin when SSO is not configured', async () => {
    const app = createApp({ db, auth, now: () => Date.parse('2026-07-19T09:00:00Z') });
    const cookie = await agentCookie(app);
    const me = await request(app).get('/api/config').set('Cookie', cookie);
    expect(me.body.agent).toBe('agent');
  });

  it('does not sign out sessions issued before the actor existed', async () => {
    // The pre-upgrade token shape: "<expiry>.<hmac(expiry)>" with no actor. It
    // stays valid until it expires and reads as the local admin.
    const { createHmac } = await import('node:crypto');
    const expiry = String(Date.now() + 3600_000);
    const legacy = `${expiry}.${createHmac('sha256', auth.secret).update(expiry).digest('hex')}`;
    const app = createApp({ db, auth, now: () => Date.parse('2026-07-19T09:00:00Z') });

    const res = await request(app).get('/api/config').set('Cookie', `mod12_session=${legacy}`);
    expect(res.status).toBe(200);
    expect(res.body.agent).toBe('agent');
  });

  it('refuses a token whose actor was tampered with', async () => {
    const { cookie } = await ssoSession('ada@acme.test');
    const app = createApp({ db, auth, now: () => Date.parse('2026-07-19T09:00:00Z') });
    const [name, token] = cookie.split('=') as [string, string];
    const [expiry, , mac] = token.split('.') as [string, string, string];
    const forged = `${expiry}.${Buffer.from('root@acme.test').toString('base64url')}.${mac}`;

    const res = await request(app).get('/api/config').set('Cookie', `${name}=${forged}`);
    expect(res.status).toBe(401);
  });
});
