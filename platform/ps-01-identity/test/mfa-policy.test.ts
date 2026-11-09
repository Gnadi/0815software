import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { SessionConfig } from '../server/auth.js';
import { base32Decode, hotp, stepAt } from '../server/totp.js';
import { deviceLabel, type SecurityKind } from '../server/security-notify.js';

const session: SessionConfig = { secret: 'test-secret', ttlHours: 12, secureCookie: false };
const PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';
const LAPTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

let db: Database.Database;
let app: Express;
let clock: number;
let sent: { kind: SecurityKind; email: string; detail: string | null; key: string }[];

beforeEach(async () => {
  db = openDb(':memory:');
  await seed(db);
  clock = Date.parse('2026-11-07T09:00:00Z');
  sent = [];
  app = createApp({ db, session, now: () => clock, sleep: async () => {}, securityNotify: (e) => void sent.push(e) });
});

const login = (email: string, password: string, extra: Record<string, unknown> = {}) =>
  request(app).post('/api/login').send({ org_slug: 'acme', email, password, ...extra });
const code = (secret: string, offset = 0) => hotp(base32Decode(secret), stepAt(clock) + offset);
const asAdmin = async () => (await login('admin@acme.test', 'demo-admin')).body.token as string;

async function requireMfa(on: boolean) {
  return request(app).patch('/api/orgs/current').set('Authorization', `Bearer ${await asAdmin()}`).send({ mfa_required: on });
}

describe('the organization requires two-factor sign-in', () => {
  it('is an administrator’s switch, and a member cannot flip it', async () => {
    const member = (await login('member@acme.test', 'demo-member')).body.token;
    expect((await request(app).patch('/api/orgs/current').set('Authorization', `Bearer ${member}`).send({ mfa_required: true })).status).toBe(403);
    const admin = await asAdmin();
    expect((await request(app).patch('/api/orgs/current').set('Authorization', `Bearer ${admin}`).send({ mfa_required: 'yes' })).status).toBe(422);
    const res = await request(app).patch('/api/orgs/current').set('Authorization', `Bearer ${admin}`).send({ mfa_required: true });
    expect(res.status).toBe(200);
    expect(res.body.organization.mfa_required).toBe(true);
    // The administrator too sets up a factor at their next sign-in.
    expect((await login('admin@acme.test', 'demo-admin')).body.details).toEqual([{ field: 'otp', message: 'must be set up' }]);
  });

  it('ends sessions opened without a factor — but not the administrator’s own', async () => {
    const memberToken = (await login('member@acme.test', 'demo-member')).body.token;
    const adminToken = await asAdmin();
    await request(app).patch('/api/orgs/current').set('Authorization', `Bearer ${adminToken}`).send({ mfa_required: true });
    expect((await request(app).get('/api/me').set('Authorization', `Bearer ${memberToken}`)).status).toBe(401);
    expect((await request(app).get('/api/me').set('Authorization', `Bearer ${adminToken}`)).body.organization.mfa_required).toBe(true);
  });

  it('enrols the person inside the sign-in: QR first, then the first code switches it on', async () => {
    await requireMfa(true);
    clock += 60_000;
    const first = await login('member@acme.test', 'demo-member');
    expect(first.status).toBe(401);
    expect(first.body.details).toEqual([{ field: 'otp', message: 'must be set up' }]);
    const { secret, otpauth_uri } = first.body.mfa_setup;
    expect(otpauth_uri).toContain(`secret=${secret}`);

    // The same secret on a second attempt — the scanned QR code stays valid.
    expect((await login('member@acme.test', 'demo-member')).body.mfa_setup.secret).toBe(secret);

    const wrong = await login('member@acme.test', 'demo-member', { otp: code(secret) === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.details).toEqual([{ field: 'otp', message: 'is invalid' }]);
    expect(wrong.body.mfa_setup.secret).toBe(secret);

    const ok = await login('member@acme.test', 'demo-member', { otp: code(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.recovery_codes).toHaveLength(10);
    expect(ok.body.user.mfa_enabled).toBe(true);
    expect((await request(app).get('/api/me').set('Authorization', `Bearer ${ok.body.token}`)).status).toBe(200);
    expect(sent.map((e) => e.kind)).toContain('mfa-enabled');

    // From now on it is an ordinary second factor.
    clock += 30_000;
    expect((await login('member@acme.test', 'demo-member')).body.details).toEqual([{ field: 'otp', message: 'is required' }]);
  });

  it('a wrong password never reaches the setup — nothing about the factor leaks', async () => {
    await requireMfa(true);
    const res = await login('member@acme.test', 'wrong');
    expect(res.status).toBe(401);
    expect(res.body.mfa_setup).toBeUndefined();
  });

  it('cannot be escaped by turning the factor off, and lets nobody in without one', async () => {
    await requireMfa(true);
    clock += 60_000;
    const secret = (await login('member@acme.test', 'demo-member')).body.mfa_setup.secret;
    const { token } = (await login('member@acme.test', 'demo-member', { otp: code(secret) })).body;
    clock += 30_000;
    const off = await request(app)
      .post('/api/me/mfa/totp/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: 'demo-member', otp: code(secret) });
    expect(off.status).toBe(409);
  });

  it('a provider sign-in in such an organization goes through the ticket and enrols there', async () => {
    const authorize = async () => {
      const a = await request(app).get('/api/oauth/google/authorize?org_slug=acme').redirects(0);
      const q = new URL(a.headers['location'] as string, 'http://x').searchParams;
      return request(app).get(`/api/oauth/google/callback?state=${q.get('state')}&code=${q.get('code')}`).redirects(0);
    };
    await authorize(); // provisions the account
    await requireMfa(true);
    const res = await authorize();
    expect(res.body.mfa_required).toBe(true);
    const step1 = await request(app).post('/api/login/mfa').send({ mfa_ticket: res.body.mfa_ticket });
    expect(step1.body.details).toEqual([{ field: 'otp', message: 'must be set up' }]);
    const step2 = await request(app)
      .post('/api/login/mfa')
      .send({ mfa_ticket: res.body.mfa_ticket, otp: code(step1.body.mfa_setup.secret) });
    // Enrolling bumped token_version — the ticket was bound to the old one,
    // and the session comes from the same response, so it holds.
    expect(step2.status).toBe(200);
    expect(step2.body.recovery_codes).toHaveLength(10);
  });
});

describe('security notifications to the person', () => {
  it('a sign-in from a device never seen before — not the very first sign-in', async () => {
    await login('member@acme.test', 'demo-member', { device: { user_agent: PHONE, ip: '203.0.113.7' } });
    expect(sent).toEqual([]);
    await login('member@acme.test', 'demo-member', { device: { user_agent: PHONE } });
    expect(sent).toEqual([]);
    await login('member@acme.test', 'demo-member', { device: { user_agent: LAPTOP, ip: '198.51.100.2' } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'new-device', email: 'member@acme.test' });
    expect(sent[0]!.detail).toContain('Safari on macOS · 198.51.100.2');
    expect(db.prepare("SELECT COUNT(*) AS n FROM auth_events WHERE type = 'new_device'").get()).toEqual({ n: 1 });
  });

  it('crossing into the backoff is told once, not once per guess', async () => {
    for (let i = 0; i < 9; i++) await login('member@acme.test', 'wrong');
    expect(sent.filter((e) => e.kind === 'login-throttled')).toHaveLength(1);
  });

  it('password changes, administrator resets and sign-out-everywhere are told', async () => {
    const admin = await asAdmin();
    const member = db.prepare("SELECT id FROM users WHERE email = 'member@acme.test'").get() as { id: number };
    await request(app).post(`/api/users/${member.id}/password`).set('Authorization', `Bearer ${admin}`).send({ new_password: 'new-password-1' });
    await request(app).post(`/api/users/${member.id}/sessions/revoke`).set('Authorization', `Bearer ${admin}`);
    const own = (await login('member@acme.test', 'new-password-1')).body.token;
    await request(app).post(`/api/users/${member.id}/password`).set('Authorization', `Bearer ${own}`).send({ current_password: 'new-password-1', new_password: 'new-password-2' });
    expect(sent.map((e) => e.kind)).toEqual(['password-reset', 'sessions-revoked', 'password-changed']);
    // Signing YOURSELF out everywhere is not news to you.
    const again = (await login('member@acme.test', 'new-password-2')).body.token;
    await request(app).post('/api/me/sessions/revoke').set('Authorization', `Bearer ${again}`);
    expect(sent).toHaveLength(3);
  });
});

describe('device labels are coarse on purpose', () => {
  it('name the browser family and system, never the version', () => {
    expect(deviceLabel(PHONE)).toBe('Chrome on Android');
    expect(deviceLabel(LAPTOP)).toBe('Safari on macOS');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0')).toBe('Edge on Windows');
    expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0')).toBe('Firefox on Linux');
    expect(deviceLabel(undefined)).toBeNull();
  });
});
