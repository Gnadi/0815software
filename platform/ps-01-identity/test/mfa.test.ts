import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { SessionConfig } from '../server/auth.js';
import { base32Decode, hotp, newTotpSecret, stepAt } from '../server/totp.js';
import { DEFAULT_THROTTLE } from '../server/throttle.js';

const session: SessionConfig = { secret: 'test-secret', ttlHours: 12, secureCookie: false };

let db: Database.Database;
let app: Express;
let clock: number;
let slept: number[];

beforeEach(async () => {
  db = openDb(':memory:');
  await seed(db);
  clock = Date.parse('2026-11-07T09:00:00Z');
  slept = [];
  app = createApp({ db, session, now: () => clock, sleep: async (ms) => void slept.push(ms) });
});

/** The code an authenticator app shows right now — `offset` steps away. */
function codeFor(secret: string, offset = 0): string {
  return hotp(base32Decode(secret), stepAt(clock) + offset);
}

const ORG = 'acme';
const EMAIL = 'member@acme.test';
const PASSWORD = 'demo-member';

async function signIn(extra: Record<string, unknown> = {}) {
  return request(app).post('/api/login').send({ org_slug: ORG, email: EMAIL, password: PASSWORD, ...extra });
}

/** Enrol the member and return the secret, the recovery codes and the fresh token. */
async function enrol(): Promise<{ secret: string; codes: string[]; token: string }> {
  const token = (await signIn()).body.token as string;
  const setup = await request(app)
    .post('/api/me/mfa/totp/setup')
    .set('Authorization', `Bearer ${token}`)
    .send({ current_password: PASSWORD });
  expect(setup.status).toBe(200);
  const secret = setup.body.secret as string;
  const confirm = await request(app)
    .post('/api/me/mfa/totp/confirm')
    .set('Authorization', `Bearer ${token}`)
    .send({ otp: codeFor(secret) });
  expect(confirm.status).toBe(200);
  clock += 30_000; // the enrolment code is spent; the next login needs the next one
  return { secret, codes: confirm.body.recovery_codes as string[], token: confirm.body.token as string };
}

describe('enrolment', () => {
  it('asks for the password before showing a secret — a stolen session cannot enrol a phone', async () => {
    const token = (await signIn()).body.token as string;
    const res = await request(app)
      .post('/api/me/mfa/totp/setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: 'wrong' });
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe('current_password');
  });

  it('returns a scannable URI and switches on only after a correct first code', async () => {
    const token = (await signIn()).body.token as string;
    const setup = await request(app)
      .post('/api/me/mfa/totp/setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: PASSWORD });
    expect(setup.body.otpauth_uri).toMatch(/^otpauth:\/\/totp\/Acme.*:member%40acme\.test\?/);

    const wrong = await request(app)
      .post('/api/me/mfa/totp/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ otp: '000000' === codeFor(setup.body.secret) ? '111111' : '000000' });
    expect(wrong.status).toBe(422);
    // Still off: a mistyped scan must not lock anyone out.
    expect((await signIn()).status).toBe(200);

    const ok = await request(app)
      .post('/api/me/mfa/totp/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ otp: codeFor(setup.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.recovery_codes).toHaveLength(10);
    expect(new Set(ok.body.recovery_codes).size).toBe(10);
  });

  it('signs out every other session when it switches on, and keeps the caller signed in', async () => {
    const other = (await signIn()).body.token as string;
    const { token } = await enrol();
    expect((await request(app).get('/api/me').set('Authorization', `Bearer ${other}`)).status).toBe(401);
    expect((await request(app).get('/api/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
  });

  it('expires an unconfirmed setup', async () => {
    const token = (await signIn()).body.token as string;
    const setup = await request(app)
      .post('/api/me/mfa/totp/setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: PASSWORD });
    clock += 16 * 60_000;
    const res = await request(app)
      .post('/api/me/mfa/totp/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ otp: codeFor(setup.body.secret) });
    expect(res.status).toBe(409);
  });

  it('shows the administrator who has a factor, never the factor', async () => {
    await enrol();
    const owner = (await request(app).post('/api/login').send({ org_slug: ORG, email: 'owner@acme.test', password: 'demo-owner' })).body.token;
    const users = await request(app).get('/api/users').set('Authorization', `Bearer ${owner}`);
    const member = users.body.users.find((u: { email: string }) => u.email === EMAIL);
    expect(member.mfa_enabled).toBe(true);
    expect(JSON.stringify(users.body)).not.toMatch(/totp|secret/i);
  });
});

describe('signing in with a second factor', () => {
  it('says the code is required — the field a login form shows', async () => {
    await enrol();
    const res = await signIn();
    expect(res.status).toBe(401);
    expect(res.body.details).toEqual([{ field: 'otp', message: 'is required' }]);
    expect(res.body.token).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('accepts the current code, and one step of clock drift either way', async () => {
    const { secret } = await enrol();
    expect((await signIn({ otp: codeFor(secret) })).status).toBe(200);
    clock += 30_000;
    expect((await signIn({ otp: codeFor(secret, -1) })).status).toBe(401); // older than the one just used
    expect((await signIn({ otp: codeFor(secret, 1) })).status).toBe(200);
  });

  it('refuses a replayed code — one read over a shoulder is dead once used', async () => {
    const { secret } = await enrol();
    const code = codeFor(secret);
    expect((await signIn({ otp: code })).status).toBe(200);
    const again = await signIn({ otp: code });
    expect(again.status).toBe(401);
    expect(again.body.details).toEqual([{ field: 'otp', message: 'is invalid' }]);
  });

  it('a wrong password still answers as a wrong password, whatever the code', async () => {
    const { secret } = await enrol();
    const res = await request(app)
      .post('/api/login')
      .send({ org_slug: ORG, email: EMAIL, password: 'nope', otp: codeFor(secret) });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid organization, email or password');
  });

  it('puts wrong codes on the throttle, and a right password does not clear it', async () => {
    const { secret } = await enrol();
    for (let i = 0; i < DEFAULT_THROTTLE.threshold + 2; i++) {
      expect((await signIn({ otp: '999999' === codeFor(secret) ? '888888' : '999999' })).status).toBe(401);
      // The password was right every time; the backoff grows anyway.
      expect((await signIn()).status).toBe(401);
    }
    expect(slept.length).toBeGreaterThan(0);
    const before = slept.length;
    await signIn({ otp: '000001' });
    expect(slept.length).toBe(before + 1);
    const events = db.prepare("SELECT COUNT(*) AS n FROM auth_events WHERE type = 'mfa_failed'").get() as { n: number };
    expect(events.n).toBeGreaterThanOrEqual(DEFAULT_THROTTLE.threshold);
  });

  it('a recovery code signs in once and only once', async () => {
    const { codes } = await enrol();
    const typed = codes[0]!.toUpperCase().replace('-', ' ');
    expect((await signIn({ otp: typed })).status).toBe(200);
    expect((await signIn({ otp: codes[0] })).status).toBe(401);
    const left = db.prepare("SELECT meta FROM auth_events WHERE type = 'recovery_code_used'").get() as { meta: string };
    expect(JSON.parse(left.meta).left).toBe(9);
  });

  it('a provider sign-in on such an account yields a ticket, not a session', async () => {
    // First provider sign-in provisions the account; give it a factor by hand
    // (it has no password to enrol with).
    const first = await oauthCallback();
    expect(first.body.token).toBeTruthy();
    const secret = newTotpSecret();
    db.prepare("UPDATE users SET totp_secret = ?, totp_enabled_at = '2026-11-07T08:00:00Z' WHERE id = ?").run(
      secret,
      first.body.user.id,
    );

    const second = await oauthCallback();
    expect(second.status).toBe(200);
    expect(second.body.token).toBeUndefined();
    expect(second.body.mfa_required).toBe(true);
    const ticket = second.body.mfa_ticket as string;

    // The ticket is not a session anywhere.
    expect((await request(app).get('/api/me').set('Authorization', `Bearer ${ticket}`)).status).toBe(401);
    expect((await request(app).post('/api/tokens/verify').send({ token: ticket })).body.valid).toBe(false);

    const wrong = await request(app).post('/api/login/mfa').send({ mfa_ticket: ticket, otp: '000000' === codeFor(secret) ? '111111' : '000000' });
    expect(wrong.status).toBe(401);
    const ok = await request(app).post('/api/login/mfa').send({ mfa_ticket: ticket, otp: codeFor(secret) });
    expect(ok.status).toBe(200);
    expect((await request(app).post('/api/tokens/verify').send({ token: ok.body.token })).body.valid).toBe(true);

    clock += 6 * 60_000;
    const late = await request(app).post('/api/login/mfa').send({ mfa_ticket: ticket, otp: codeFor(secret) });
    expect(late.status).toBe(401);
  });

  it('refuses a forged or tampered ticket', async () => {
    for (const ticket of ['mfa.1.1.99999999999999.deadbeef', 'garbage', 42]) {
      expect((await request(app).post('/api/login/mfa').send({ mfa_ticket: ticket, otp: '123456' })).status).toBe(401);
    }
  });
});

async function oauthCallback() {
  const authorize = await request(app).get('/api/oauth/google/authorize?org_slug=acme').redirects(0);
  const q = new URL(authorize.headers['location'] as string, 'http://x').searchParams;
  return request(app).get(`/api/oauth/google/callback?state=${q.get('state')}&code=${q.get('code')}`).redirects(0);
}

describe('turning it off, renewing codes, the administrator reset', () => {
  it('turning off needs the password and a code', async () => {
    const { secret, token } = await enrol();
    const noCode = await request(app)
      .post('/api/me/mfa/totp/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: PASSWORD, otp: '12' });
    expect(noCode.status).toBe(422);
    const noPassword = await request(app)
      .post('/api/me/mfa/totp/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: 'nope', otp: codeFor(secret) });
    expect(noPassword.status).toBe(422);
    const ok = await request(app)
      .post('/api/me/mfa/totp/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: PASSWORD, otp: codeFor(secret) });
    expect(ok.status).toBe(200);
    expect((await signIn()).status).toBe(200);
  });

  it('renewing the recovery codes kills the old set', async () => {
    const { secret, codes, token } = await enrol();
    const renewed = await request(app)
      .post('/api/me/mfa/recovery-codes')
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: PASSWORD, otp: codeFor(secret) });
    expect(renewed.status).toBe(200);
    expect((await signIn({ otp: codes[0] })).status).toBe(401);
    expect((await signIn({ otp: renewed.body.recovery_codes[0] })).status).toBe(200);
    const status = await request(app)
      .get('/api/me/mfa')
      .set('Authorization', `Bearer ${(await signIn({ otp: renewed.body.recovery_codes[1] })).body.token}`);
    expect(status.body).toMatchObject({ totp_enabled: true, recovery_codes_left: 8 });
  });

  it('an administrator resets a lost phone; the person signs in with the password again', async () => {
    const { token } = await enrol();
    const admin = (await request(app).post('/api/login').send({ org_slug: ORG, email: 'admin@acme.test', password: 'demo-admin' })).body.token;
    const member = db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL) as { id: number };
    const reset = await request(app).post(`/api/users/${member.id}/mfa/reset`).set('Authorization', `Bearer ${admin}`);
    expect(reset.status).toBe(200);
    expect(reset.body.user.mfa_enabled).toBe(false);
    // The phone's sessions die with the factor.
    expect((await request(app).get('/api/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await signIn()).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM auth_events WHERE type = 'mfa_reset'").get()).toEqual({ n: 1 });
  });

  it('an administrator cannot reset the owner, nor themselves by this route', async () => {
    const admin = (await request(app).post('/api/login').send({ org_slug: ORG, email: 'admin@acme.test', password: 'demo-admin' })).body.token;
    const owner = db.prepare("SELECT id FROM users WHERE email = 'owner@acme.test'").get() as { id: number };
    const self = db.prepare("SELECT id FROM users WHERE email = 'admin@acme.test'").get() as { id: number };
    expect((await request(app).post(`/api/users/${owner.id}/mfa/reset`).set('Authorization', `Bearer ${admin}`)).status).toBe(403);
    expect((await request(app).post(`/api/users/${self.id}/mfa/reset`).set('Authorization', `Bearer ${admin}`)).status).toBe(403);
  });

  it('a member cannot reset anyone', async () => {
    const token = (await signIn()).body.token;
    const owner = db.prepare("SELECT id FROM users WHERE email = 'owner@acme.test'").get() as { id: number };
    expect((await request(app).post(`/api/users/${owner.id}/mfa/reset`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('erasing a person removes the factor and the recovery codes', async () => {
    await enrol();
    const owner = (await request(app).post('/api/login').send({ org_slug: ORG, email: 'owner@acme.test', password: 'demo-owner' })).body.token;
    const member = db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL) as { id: number };
    expect((await request(app).post(`/api/users/${member.id}/erase`).set('Authorization', `Bearer ${owner}`)).status).toBe(200);
    expect(db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(member.id)).toEqual({ totp_secret: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?').get(member.id)).toEqual({ n: 0 });
  });
});

describe('concurrent use of one code', () => {
  // The login reads the account, then awaits scrypt, then checks the code.
  // Two requests racing with the same code both read the old replay guard
  // before either spends it — unless spending is itself the check.
  it('lets one of two simultaneous logins with the same TOTP through, not both', async () => {
    const { secret } = await enrol();
    const code = codeFor(secret);
    const [a, b] = await Promise.all([signIn({ otp: code }), signIn({ otp: code })]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
  });

  it('spends a recovery code once, however many logins race with it', async () => {
    const { codes } = await enrol();
    const [a, b] = await Promise.all([signIn({ otp: codes[0] }), signIn({ otp: codes[0] })]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
  });
});
