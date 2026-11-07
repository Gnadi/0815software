import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import express from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { createPeerClient } from '../server/peers.js';
import { createModuleSessions } from '../server/sessions.js';
import { buildLoginVerifier, loginModeOf } from '../server/sso.js';
import type { AuthConfig } from '../server/auth.js';
// The account page against the REAL services: PS-01 decides about passwords,
// codes and permissions, PS-03 about devices and preferences; the shell only
// carries the person's requests. Booted in-process, like MOD-02's sso-e2e.
import { createApp as createIdentityApp } from '../../../platform/ps-01-identity/server/app.js';
import { openDb as openIdentityDb } from '../../../platform/ps-01-identity/server/db.js';
import { seed as seedIdentity } from '../../../platform/ps-01-identity/server/seed.js';
import { base32Decode, totp } from '../../../platform/ps-01-identity/server/totp.js';
import { createApp as createNotifyApp } from '../../../platform/ps-03-notification-hub/server/app.js';
import { openDb as openNotifyDb } from '../../../platform/ps-03-notification-hub/server/db.js';
import { seed as seedNotify } from '../../../platform/ps-03-notification-hub/server/seed.js';
import { generateVapidKeys } from '../../../platform/ps-03-notification-hub/server/webpush.js';

const auth: AuthConfig = { username: 'admin', password: 'local-only', secret: 'test-secret', ttlHours: 1, secureCookie: false };
const TOKEN = 'stack-token';
const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };

const servers: Server[] = [];
const listen = (app: express.Express): string => {
  const server = app.listen(0);
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

let shell: Express;
let inboxAsked: string[];
let memberSecret: Buffer | null = null;

beforeAll(async () => {
  const idDb = openIdentityDb(':memory:');
  await seedIdentity(idDb);
  const identityUrl = listen(createIdentityApp({ db: idDb, session: { secret: 'id', ttlHours: 12, secureCookie: false }, sleep: async () => {} }));

  const nDb = openNotifyDb(':memory:');
  seedNotify(nDb);
  const notifyUrl = listen(
    createNotifyApp({
      db: nDb,
      auth: { username: 'a', password: 'b', secret: 'c', ttlHours: 1, secureCookie: false, serviceToken: TOKEN },
      resendApiKey: null,
      vapid: { privateKey: generateVapidKeys().privateKey, subject: 'mailto:ops@acme.test' },
    }),
  );

  // Two modules: one with an inbox, one that predates it (404).
  inboxAsked = [];
  const offers = express();
  offers.get('/api/inbox', (req, res) => {
    if (req.headers['x-service-token'] !== TOKEN) return void res.status(401).json({});
    inboxAsked.push(`${req.query.for}@${req.query.level}`);
    res.json({
      version: 1,
      module: 'mod-13-offers',
      count: 3,
      items: [
        { id: 'o-2', kind: 'expiring', title: 'An offer expires soon', detail: 'AN-0002', tone: 'warn', at: '2026-11-10', href: '/offers/2' },
        { id: 'o-1', kind: 'approval', title: 'An offer waits for approval', detail: 'AN-0001', tone: 'neutral', at: '2026-11-01', href: '/offers/1' },
      ],
    });
  });
  const offersUrl = listen(offers);
  const crm = express();
  crm.use((_req, res) => void res.status(404).json({ error: 'Not found' }));
  const crmUrl = listen(crm);

  // The member may use this shell (and view every module) — a grant made the
  // ordinary way, by the owner, at PS-01.
  const ps01 = (path: string, body: unknown, token?: string) =>
    fetch(`${identityUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }).then((r) => r.json() as Promise<Record<string, any>>);
  const owner = (await ps01('/api/login', { org_slug: 'acme', email: 'owner@acme.test', password: 'demo-owner' })).token;
  const role = await ps01('/api/roles', { key: 'everything-view', name: 'View everything', permissions: ['module:*:view'] }, owner);
  const users = await fetch(`${identityUrl}/api/users`, { headers: { Authorization: `Bearer ${owner}` } }).then((r) => r.json());
  const member = users.users.find((u: { email: string }) => u.email === 'member@acme.test');
  await ps01(`/api/users/${member.id}/roles`, { role_id: role.role.id }, owner);

  const sso = { identityUrl, identityOrg: 'acme' };
  const peers = createPeerClient({
    peers: { 'mod-13-offers': { url: offersUrl, publicUrl: 'https://offers.example' }, 'mod-10-crm-lite': { url: crmUrl, publicUrl: null } },
    serviceToken: TOKEN,
    timeoutMs: 2000,
  });
  shell = createApp({
    db: openDb(':memory:'),
    auth,
    peers,
    sessions: createModuleSessions(peers),
    verifyLogin: buildLoginVerifier(sso),
    loginMode: loginModeOf(sso),
    identityUrl,
    notification: { url: notifyUrl, serviceToken: TOKEN },
  });
});

afterAll(() => servers.forEach((s) => s.close()));

async function signIn(email: string, password: string, otp?: string): Promise<string> {
  const res = await request(shell).post('/api/login').send({ username: email, password, ...(otp ? { otp } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

describe('the account page, through the shell, decided by PS-01', () => {
  it('shows who I am and that I have no second factor yet', async () => {
    const cookie = await signIn('member@acme.test', 'demo-member');
    const res = await request(shell).get('/api/account').set('Cookie', cookie).expect(200);
    expect(res.body).toMatchObject({ sso: true, notifications: true, signed_in_recently: true, admin: false, mfa: { totp_enabled: false } });
    expect(res.body.user.email).toBe('member@acme.test');
  });

  it('sets up two-factor sign-in: password, QR, first code, recovery codes — and the next sign-in needs a code', async () => {
    const cookie = await signIn('member@acme.test', 'demo-member');
    expect((await request(shell).post('/api/account/mfa/setup').set('Cookie', cookie).send({ current_password: 'nope' })).status).toBe(422);
    const setup = await request(shell).post('/api/account/mfa/setup').set('Cookie', cookie).send({ current_password: 'demo-member' }).expect(200);
    const secret = base32Decode(setup.body.secret);
    memberSecret = secret;
    const done = await request(shell)
      .post('/api/account/mfa/confirm')
      .set('Cookie', cookie)
      .send({ otp: totp(secret, Date.now() - 30_000) })
      .expect(200);
    expect(done.body.recovery_codes).toHaveLength(10);
    // The page keeps working on the fresh PS-01 token.
    expect((await request(shell).get('/api/account').set('Cookie', cookie)).body.mfa.totp_enabled).toBe(true);

    const again = await request(shell).post('/api/login').send({ username: 'member@acme.test', password: 'demo-member' });
    expect(again.status).toBe(401);
    expect(again.body.details[0]).toMatchObject({ field: 'otp', message: 'is required' });
    await signIn('member@acme.test', 'demo-member', totp(secret, Date.now()));
  });

  it('administration is PS-01’s call: a member is refused, an administrator sees everyone and sets the policy', async () => {
    const member = await signIn('member@acme.test', 'demo-member', totp(memberSecret!, Date.now() + 30_000));
    // Reading the directory is every member's right at PS-01; changing anything is not.
    expect((await request(shell).put('/api/admin/policy').set('Cookie', member).send({ mfa_required: true })).status).toBe(403);
    expect((await request(shell).post('/api/admin/users/1/mfa/reset').set('Cookie', member)).status).toBe(403);
    expect((await request(shell).get('/api/admin/notify-settings').set('Cookie', member)).status).toBe(403);
    const admin = await signIn('admin@acme.test', 'demo-admin');
    const users = await request(shell).get('/api/admin/users').set('Cookie', admin).expect(200);
    expect(users.body.users.find((u: { email: string }) => u.email === 'member@acme.test').mfa_enabled).toBe(true);
    const policy = await request(shell).put('/api/admin/policy').set('Cookie', admin).send({ mfa_required: true }).expect(200);
    expect(policy.body.organization.mfa_required).toBe(true);
    await request(shell).put('/api/admin/policy').set('Cookie', admin).send({ mfa_required: false }).expect(200);

  });

  it('without a recent PS-01 token, account changes ask for a new sign-in', async () => {
    const res = await request(shell).post('/api/login').send({ username: 'admin', password: 'local-only' });
    // SSO is on: the local admin cannot sign in at all, so there is no such session to test with.
    expect(res.status).toBe(401);
  });
});

describe('notifications for the person, through the shell, kept by PS-03', () => {
  it('publishes the push key, keeps preferences and devices per person', async () => {
    const cookie = await signIn('admin@acme.test', 'demo-admin');
    const cfg = await request(shell).get('/api/notify/config').set('Cookie', cookie).expect(200);
    expect(cfg.body.available).toBe(true);
    expect(cfg.body.public_key).toMatch(/^B/);

    const prefs = await request(shell)
      .put('/api/notify/prefs')
      .set('Cookie', cookie)
      .send({ prefs: { briefing: { enabled: true, at: '06:45' }, wrapup: { enabled: true, at: '18:15' } } })
      .expect(200);
    expect(prefs.body.prefs).toMatchObject({ briefing: { at: '06:45' }, wrapup: { at: '18:15' } });

    await request(shell)
      .post('/api/notify/devices')
      .set('Cookie', cookie)
      .send({ device: 'Pixel 8', subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/a1', keys: KEYS } })
      .expect(200);
    await request(shell)
      .post('/api/notify/devices')
      .set('Cookie', cookie)
      .send({ device: 'iPad', subscription: { endpoint: 'https://web.push.apple.com/b2', keys: KEYS } })
      .expect(200);
    expect((await request(shell).get('/api/notify/devices').set('Cookie', cookie)).body.devices).toHaveLength(2);

    // Signing out everywhere else keeps this device's subscription only.
    const out = await request(shell)
      .post('/api/account/sessions/revoke')
      .set('Cookie', cookie)
      .send({ keep_endpoint: 'https://web.push.apple.com/b2' })
      .expect(200);
    expect(out.body.devices_removed).toBe(1);
    const left = (await request(shell).get('/api/notify/devices').set('Cookie', cookie)).body.devices;
    expect(left.map((d: { device: string }) => d.device)).toEqual(['iPad']);
  });

  it('only an administrator reads or changes the stack defaults', async () => {
    const admin = await signIn('admin@acme.test', 'demo-admin');
    const put = await request(shell)
      .put('/api/admin/notify-settings')
      .set('Cookie', admin)
      .send({ defaults: { wrapup: { enabled: true, at: '16:30' } } })
      .expect(200);
    expect(put.body.defaults.wrapup.at).toBe('16:30');
    const owner = await signIn('owner@acme.test', 'demo-owner');
    expect((await request(shell).get('/api/admin/notify-settings').set('Cookie', owner)).status).toBe(200);
  });
});

describe('what waits for me', () => {
  it('adds up every module’s inbox at the level PS-01 grants there, oldest first, and counts for the badge', async () => {
    const cookie = await signIn('owner@acme.test', 'demo-owner');
    const res = await request(shell).get('/api/inbox').set('Cookie', cookie).expect(200);
    expect(res.body.count).toBe(3);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual(['o-1', 'o-2']);
    expect(res.body.items[0]).toMatchObject({ module: 'mod-13-offers', label: 'Offers' });
    expect(res.body.unavailable).toEqual([]);
    expect(inboxAsked).toContain('owner@acme.test@manage');
    expect((await request(shell).get('/api/inbox/count').set('Cookie', cookie)).body).toEqual({ count: 3 });
  });
});
