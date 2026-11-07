import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { AuthConfig } from '../server/auth.js';
import { generateVapidKeys } from '../server/webpush.js';
import { localTime } from '../server/notify.js';
import { createDecipheriv, createECDH, createHmac } from 'node:crypto';

/** Decrypt what the push service would carry, as the browser would (RFC 8291). */
function decrypt(body: Uint8Array): Record<string, unknown> {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const idlen = buf.readUInt8(20);
  const asPublic = buf.subarray(21, 21 + idlen);
  const data = buf.subarray(21 + idlen);
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(Buffer.from('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', 'base64url'));
  const hmac = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();
  const one = Buffer.from([1]);
  const ecdh = ua.computeSecret(asPublic);
  const ikm = hmac(hmac(Buffer.from(KEYS.auth, 'base64url'), ecdh), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, one]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), one])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), one])).subarray(0, 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
}

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};
const svc = { 'X-Service-Token': 'test-service' };
const vapid = { privateKey: generateVapidKeys().privateKey, subject: 'mailto:ops@example.test' };
// A real browser key pair shape (RFC 8291 Appendix A's user agent key).
const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };

let app: Express;
let db: Database.Database;
let clock: number;
let pushes: { url: string; headers: Record<string, string>; body: Uint8Array }[];
let pushStatus: number;

/** 2026-11-09 is a Monday. Vienna is UTC+1 in November. */
const vienna = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+01:00`);

async function tickAsAdmin() {
  const token = (await request(app).post('/api/login').send({ username: 'admin', password: 'test-pass' })).body.token;
  return (await request(app).post('/api/tick').set('Authorization', `Bearer ${token}`)).body;
}

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
  clock = vienna('2026-11-09', '10:00');
  pushes = [];
  pushStatus = 201;
  app = createApp({
    db,
    auth,
    now: () => clock,
    resendApiKey: null,
    vapid,
    pushFetch: async (url, init) => {
      pushes.push({ url, headers: init.headers, body: init.body });
      return { status: pushStatus };
    },
  });
});

async function subscribe(recipient: string, endpoint = 'https://fcm.googleapis.com/fcm/send/dev-1') {
  return request(app).post('/api/push/subscriptions').set(svc).send({ recipient, device: 'Pixel', subscription: { endpoint, keys: KEYS } });
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    module: 'support',
    kind: 'ticket-assigned',
    category: 'assignments',
    urgency: 'now',
    recipients: ['ada@acme.test'],
    actor: 'bob@acme.test',
    title: 'A ticket was assigned to you',
    detail: 'T-104 · Printer on fire · Acme GmbH',
    href: '/tickets/104',
    idempotency_key: 'support:ticket-assigned:104:1',
    ...overrides,
  };
}

const send = (e: Record<string, unknown>) => request(app).post('/api/events').set(svc).send(e);
const states = () => db.prepare('SELECT recipient, state FROM notify_events ORDER BY id').all();

describe('events in', () => {
  it('need the service token', async () => {
    expect((await request(app).post('/api/events').send(event())).status).toBe(401);
  });

  it('are validated field by field', async () => {
    const res = await send(event({ urgency: 'whenever', href: 'https://evil.test', recipients: ['not-an-email'] }));
    expect(res.status).toBe(422);
    expect(res.body.details.map((d: { field: string }) => d.field).sort()).toEqual(['href', 'recipients', 'urgency']);
  });

  it('never notify the person who caused them, and dedupe per person', async () => {
    const res = await send(event({ recipients: ['ada@acme.test', 'Bob@acme.test'] }));
    expect(res.body).toEqual({ recorded: 1, skipped: 1 });
    expect((await send(event())).body).toEqual({ recorded: 0, skipped: 1 });
  });
});

describe('now: pushed, with nothing confidential on the lock screen', () => {
  it('pushes to every device of the person, high urgency, detail withheld by default', async () => {
    await subscribe('ada@acme.test', 'https://fcm.googleapis.com/fcm/send/phone');
    await subscribe('ada@acme.test', 'https://web.push.apple.com/ipad');
    await send(event());
    const out = await tickAsAdmin();
    expect(out.notify.pushed).toBe(1);
    expect(pushes.map((p) => new URL(p.url).hostname).sort()).toEqual(['fcm.googleapis.com', 'web.push.apple.com']);
    expect(pushes[0]!.headers.Urgency).toBe('high');
    expect(states()).toEqual([{ recipient: 'ada@acme.test', state: 'pushed' }]);
    // The payload is encrypted — but what went into it is in the feed contract:
    const feed = await request(app).get('/api/notifications?recipient=ada@acme.test').set(svc);
    expect(feed.body.notifications[0]).toMatchObject({ title: 'A ticket was assigned to you', state: 'pushed' });
  });

  it('falls back to mail when no device takes it', async () => {
    await send(event());
    const out = await tickAsAdmin();
    expect(out.notify.emailed).toBe(1);
    const mail = db.prepare("SELECT to_address, subject, body FROM messages WHERE idempotency_key LIKE 'notify-event-%'").get() as Record<string, string>;
    expect(mail).toMatchObject({ to_address: 'ada@acme.test', subject: 'A ticket was assigned to you' });
    // Mail sits behind a login of its own, so the detail may go there.
    expect(mail.body).toContain('Printer on fire');
  });

  it('drops a subscription the browser gave up on', async () => {
    await subscribe('ada@acme.test');
    pushStatus = 410;
    await send(event());
    const out = await tickAsAdmin();
    expect(out.notify.subscriptions_dropped).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 0 });
  });
});

describe('quiet hours, mutes, security', () => {
  it('holds a normal event during quiet hours for the next briefing', async () => {
    clock = vienna('2026-11-09', '21:00');
    await subscribe('ada@acme.test');
    await send(event());
    expect((await tickAsAdmin()).notify.held).toBe(1);
    expect(pushes).toHaveLength(0);

    // Next morning, 07:35 local: the briefing carries it.
    clock = vienna('2026-11-10', '07:35');
    const out = await tickAsAdmin();
    expect(out.notify.digests).toBe(1);
    expect(pushes).toHaveLength(1);
    expect(states()).toEqual([{ recipient: 'ada@acme.test', state: 'digested' }]);
  });

  it('on-call and security go through quiet hours', async () => {
    clock = vienna('2026-11-09', '23:30');
    await subscribe('ada@acme.test');
    await send(event({ oncall: true, idempotency_key: 'k1' }));
    await send(event({ security: true, category: 'security', idempotency_key: 'k2' }));
    expect((await tickAsAdmin()).notify.pushed).toBe(2);
  });

  it('a muted category is dropped — except security, which cannot be muted', async () => {
    await subscribe('ada@acme.test');
    const put = await request(app).put('/api/prefs').set(svc).send({ recipient: 'ada@acme.test', prefs: { muted: ['assignments', 'security'] } });
    expect(put.body.prefs.muted).toEqual(['assignments']);
    await send(event({ idempotency_key: 'k1' }));
    await send(event({ category: 'security', security: true, idempotency_key: 'k2' }));
    const out = await tickAsAdmin();
    expect(out.notify).toMatchObject({ muted: 1, pushed: 1 });
  });

  it('badge-only events are counted, never pushed', async () => {
    await subscribe('ada@acme.test');
    await send(event({ urgency: 'badge' }));
    expect((await tickAsAdmin()).notify.counted).toBe(1);
    expect(pushes).toHaveLength(0);
  });
});

describe('the morning briefing and the evening wrap-up', () => {
  it('collect digest events and go once, inside the window after the configured time', async () => {
    await subscribe('ada@acme.test');
    clock = vienna('2026-11-09', '12:00');
    await send(event({ urgency: 'digest', idempotency_key: 'a' }));
    await send(event({ urgency: 'digest', idempotency_key: 'b', title: 'A leave request waits for you' }));
    expect((await tickAsAdmin()).notify.held).toBe(2);

    clock = vienna('2026-11-09', '16:59');
    expect((await tickAsAdmin()).notify.digests).toBe(0);
    clock = vienna('2026-11-09', '17:02');
    expect((await tickAsAdmin()).notify.digests).toBe(1);
    clock = vienna('2026-11-09', '17:30');
    expect((await tickAsAdmin()).notify.digests).toBe(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.headers.Urgency).toBe('normal');
  });

  it('a late item outside the window waits for the next digest, not a stray one at noon', async () => {
    await subscribe('ada@acme.test');
    clock = vienna('2026-11-09', '11:00');
    await send(event({ urgency: 'digest' }));
    await tickAsAdmin();
    clock = vienna('2026-11-09', '11:30');
    expect((await tickAsAdmin()).notify.digests).toBe(0);
  });

  it('respects the person’s own times, days and channel', async () => {
    await request(app)
      .put('/api/prefs')
      .set(svc)
      .send({ recipient: 'ada@acme.test', prefs: { briefing: { enabled: true, at: '06:00' }, wrapup: { enabled: false, at: '17:00' }, digest_via: 'email', workdays: [1, 2, 3, 4, 5, 6] } });
    clock = vienna('2026-11-13', '20:00'); // Friday evening
    await send(event({ urgency: 'digest' }));
    await tickAsAdmin();
    clock = vienna('2026-11-14', '06:10'); // Saturday is a working day for Ada
    expect((await tickAsAdmin()).notify.digests).toBe(1);
    const mail = db.prepare("SELECT subject FROM messages WHERE idempotency_key LIKE 'notify-digest-%'").get() as { subject: string };
    expect(mail.subject).toMatch(/^Good morning — 1 thing waits for you$/);
  });

  it('skips non-working days', async () => {
    clock = vienna('2026-11-14', '12:00'); // Saturday
    await send(event({ urgency: 'digest' }));
    await tickAsAdmin();
    clock = vienna('2026-11-15', '07:40'); // Sunday
    expect((await tickAsAdmin()).notify.digests).toBe(0);
    clock = vienna('2026-11-16', '07:40'); // Monday
    expect((await tickAsAdmin()).notify.digests).toBe(1);
  });
});

describe('preferences and the administrator’s defaults', () => {
  it('a person sees defaults until they change something, and keeps only what differs', async () => {
    const before = await request(app).get('/api/prefs?recipient=ada@acme.test').set(svc);
    expect(before.body.prefs.briefing).toEqual({ enabled: true, at: '07:30' });
    await request(app).put('/api/prefs').set(svc).send({ recipient: 'ada@acme.test', prefs: { lock_screen_details: true } });
    // The administrator moves the briefing; Ada, who never touched it, follows.
    await request(app).put('/api/notify/settings').set(svc).send({ defaults: { briefing: { enabled: true, at: '08:00' } } });
    const after = await request(app).get('/api/prefs?recipient=ada@acme.test').set(svc);
    expect(after.body.prefs).toMatchObject({ briefing: { at: '08:00' }, lock_screen_details: true });
    expect(after.body.overrides).toEqual({ lock_screen_details: true });
  });

  it('refuses unknown or malformed preferences rather than ignoring them', async () => {
    const res = await request(app)
      .put('/api/prefs')
      .set(svc)
      .send({ recipient: 'ada@acme.test', prefs: { lock_screen_detail: true, timezone: 'Mars/Olympus', quiet: { from: '25:00', to: '07:00' } } });
    expect(res.status).toBe(422);
    expect(res.body.details.map((d: { field: string }) => d.field).sort()).toEqual(['lock_screen_detail', 'quiet', 'timezone']);
  });

  it('shows the detail on the lock screen only when the person asked for it', async () => {
    await subscribe('ada@acme.test');
    await send(event({ idempotency_key: 'k1' }));
    await tickAsAdmin();
    const hidden = decrypt(pushes[0]!.body);
    expect(hidden).toMatchObject({ title: 'A ticket was assigned to you', body: 'Open the app to see it.', module: 'support', href: '/tickets/104', badge: 'recount' });
    expect(JSON.stringify(hidden)).not.toContain('Printer');

    await request(app).put('/api/prefs').set(svc).send({ recipient: 'ada@acme.test', prefs: { lock_screen_details: true } });
    await send(event({ idempotency_key: 'k2' }));
    await tickAsAdmin();
    expect(decrypt(pushes[1]!.body).body).toBe('T-104 · Printer on fire · Acme GmbH');
  });
});

describe('devices', () => {
  it('only accept known push services — a subscription is not a way to make this service call anywhere', async () => {
    const bad = await subscribe('ada@acme.test', 'https://10.0.0.5/internal');
    expect(bad.status).toBe(422);
    expect((await subscribe('ada@acme.test')).status).toBe(201);
  });

  it('a device moves to whoever signs in on it, and can be removed one by one or all at once', async () => {
    await subscribe('ada@acme.test', 'https://fcm.googleapis.com/fcm/send/shared');
    await subscribe('bob@acme.test', 'https://fcm.googleapis.com/fcm/send/shared');
    expect((await request(app).get('/api/push/subscriptions?recipient=ada@acme.test').set(svc)).body.devices).toHaveLength(0);
    const bobs = (await request(app).get('/api/push/subscriptions?recipient=bob@acme.test').set(svc)).body.devices;
    expect(bobs[0]).not.toHaveProperty('endpoint');
    await subscribe('bob@acme.test', 'https://web.push.apple.com/b2');
    expect((await request(app).post('/api/push/subscriptions/remove').set(svc).send({ recipient: 'bob@acme.test', id: bobs[0].id })).body.removed).toBe(1);
    expect((await request(app).post('/api/push/subscriptions/remove').set(svc).send({ recipient: 'bob@acme.test' })).body.removed).toBe(1);
  });

  it('publishes the public key, and refuses devices when push is not configured', async () => {
    expect((await request(app).get('/api/push/public-key')).body.public_key).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    const noPush = createApp({ db, auth, resendApiKey: null });
    expect((await request(noPush).get('/api/push/public-key')).body.public_key).toBeNull();
    const res = await request(noPush)
      .post('/api/push/subscriptions')
      .set(svc)
      .send({ recipient: 'ada@acme.test', subscription: { endpoint: 'https://fcm.googleapis.com/x', keys: KEYS } });
    expect(res.status).toBe(409);
  });
});

describe('local time', () => {
  it('reads wall-clock time in the person’s zone, across the DST change', () => {
    expect(localTime(Date.parse('2026-11-09T06:30:00Z'), 'Europe/Vienna')).toEqual({ date: '2026-11-09', minutes: 7 * 60 + 30, weekday: 1 });
    expect(localTime(Date.parse('2026-07-01T05:30:00Z'), 'Europe/Vienna').minutes).toBe(7 * 60 + 30);
    expect(localTime(Date.parse('2026-11-09T23:30:00Z'), 'Europe/Vienna')).toMatchObject({ date: '2026-11-10', weekday: 2 });
  });
});
