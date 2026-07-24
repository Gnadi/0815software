import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import type { FetchLike } from '../server/providers/index.js';
import { MAX_ATTEMPTS } from '../server/retry.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};

let app: Express;
let db: Database.Database;
let clock: number;
let fetchOutcome: 'ok' | 'fail';
let fetchCalls: number;

const mockFetch: FetchLike = async () => {
  fetchCalls++;
  return fetchOutcome === 'ok' ? { ok: true, status: 200 } : { ok: false, status: 500 };
};

async function token(): Promise<string> {
  return (await request(app).post('/api/login').send({ username: 'admin', password: 'test-pass' })).body.token as string;
}
const svc = { 'X-Service-Token': 'test-service' };
const as = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeEach(() => {
  db = openDb(':memory:');
  clock = Date.parse('2026-07-01T00:00:00Z');
  fetchOutcome = 'ok';
  fetchCalls = 0;
  app = createApp({ db, auth, now: () => clock, resendApiKey: null, fetchImpl: mockFetch });
});

async function makeChannel(t: string, spec: Record<string, unknown>): Promise<void> {
  await request(app).post('/api/channels').set(as(t)).send(spec).expect(201);
}

describe('auth & health', () => {
  it('gates admin routes', async () => {
    expect((await request(app).get('/api/health')).body).toEqual({ ok: true });
    expect((await request(app).get('/api/channels')).status).toBe(401);
    expect((await request(app).post('/api/login').send({ username: 'admin', password: 'x' })).status).toBe(401);
  });
});

describe('templates & rendering', () => {
  it('interpolates, escapes html, versions, and 422s on missing vars', async () => {
    const t = await token();
    await request(app)
      .post('/api/templates')
      .set(as(t))
      .send({ key: 'welcome', channel_type: 'email', subject: 'Hi {{name}}', body: '<p>{{name}} at {{org}}</p>' })
      .expect(201);

    const preview = await request(app)
      .post('/api/templates/welcome/preview')
      .set(as(t))
      .send({ variables: { name: 'A&B', org: 'Acme' } });
    expect(preview.body.rendered.subject).toBe('Hi A&amp;B');
    expect(preview.body.rendered.body).toBe('<p>A&amp;B at Acme</p>');

    const missing = await request(app).post('/api/templates/welcome/preview').set(as(t)).send({ variables: { name: 'x' } });
    expect(missing.status).toBe(422);

    await request(app)
      .post('/api/templates/welcome/versions')
      .set(as(t))
      .send({ channel_type: 'email', subject: 'Hello {{name}}', body: 'v2 {{name}}' })
      .expect(201);
    const latest = await request(app).get('/api/templates/welcome').set(as(t));
    expect(latest.body.template.version).toBe(2);
  });
});

describe('send + queue', () => {
  it('enqueues via the console provider and sends with no external call', async () => {
    const t = await token();
    await makeChannel(t, { type: 'email', name: 'mail', provider: 'console' });

    const sent = await request(app).post('/api/send').set(svc).send({ channel: 'mail', to: 'x@y.z', subject: 'S', body: 'B' });
    expect(sent.status).toBe(201);
    expect(sent.body.message.status).toBe('queued');

    const tick = await request(app).post('/api/tick').set(as(t));
    expect(tick.body.sent).toBe(1);
    expect(fetchCalls).toBe(0); // console provider never touches the network

    const list = await request(app).get('/api/messages?status=sent').set(as(t));
    expect(list.body.messages.length).toBe(1);
  });

  it('requires the service token', async () => {
    const t = await token();
    await makeChannel(t, { type: 'email', name: 'mail', provider: 'console' });
    expect((await request(app).post('/api/send').send({ channel: 'mail', to: 'x', body: 'B' })).status).toBe(401);
    expect((await request(app).post('/api/send').set({ 'X-Service-Token': 'no' }).send({ channel: 'mail', to: 'x', body: 'B' })).status).toBe(403);
  });

  it('dedupes by idempotency key', async () => {
    const t = await token();
    await makeChannel(t, { type: 'email', name: 'mail', provider: 'console' });
    const first = await request(app).post('/api/send').set(svc).send({ channel: 'mail', to: 'x', body: 'B', idempotency_key: 'k1' });
    expect(first.status).toBe(201);
    const again = await request(app).post('/api/send').set(svc).send({ channel: 'mail', to: 'x', body: 'B', idempotency_key: 'k1' });
    expect(again.status).toBe(200);
    expect(again.body.message.id).toBe(first.body.message.id);
  });

  it('renders a template on send', async () => {
    const t = await token();
    await makeChannel(t, { type: 'email', name: 'mail', provider: 'console' });
    await request(app).post('/api/templates').set(as(t)).send({ key: 'greet', channel_type: 'email', subject: 'Hi {{name}}', body: 'Hello {{name}}' });
    const sent = await request(app).post('/api/send').set(svc).send({ channel: 'mail', to: 'x', template_key: 'greet', variables: { name: 'Zoe' } });
    expect(sent.body.message.subject).toBe('Hi Zoe');
    expect(sent.body.message.body).toBe('Hello Zoe');
    // Missing variable → 422.
    expect((await request(app).post('/api/send').set(svc).send({ channel: 'mail', to: 'x', template_key: 'greet' })).status).toBe(422);
  });
});

describe('delivery failures & graceful degradation', () => {
  it('retries with backoff and dead-letters a failing provider', async () => {
    const t = await token();
    await makeChannel(t, { type: 'webhook', name: 'hook', provider: 'webhook', config: { url: 'https://example.invalid/h' } });
    await request(app).post('/api/send').set(svc).send({ channel: 'hook', to: 'x', body: 'B' });

    fetchOutcome = 'fail';
    const msg = async () => (await request(app).get('/api/messages').set(as(t))).body.messages[0];
    let guard = 0;
    while ((await msg()).status !== 'dead' && guard++ < 20) {
      const cur = await msg();
      clock = Date.parse(cur.next_attempt_at) + 1000;
      await request(app).post('/api/tick').set(as(t));
    }
    const dead = await msg();
    expect(dead.status).toBe('dead');
    expect(dead.attempts).toBe(MAX_ATTEMPTS);

    await request(app).post(`/api/messages/${dead.id}/retry`).set(as(t)).expect(200);
    fetchOutcome = 'ok';
    await request(app).post('/api/tick').set(as(t));
    expect((await msg()).status).toBe('sent');
  });

  it('degrades an email channel to console when RESEND_API_KEY is unset', async () => {
    const t = await token();
    await makeChannel(t, { type: 'email', name: 'grace', provider: 'resend-email' });
    await request(app).post('/api/send').set(svc).send({ channel: 'grace', to: 'x', body: 'B' });
    fetchOutcome = 'fail'; // even if the network would fail, console is used
    await request(app).post('/api/tick').set(as(t));
    const m = (await request(app).get('/api/messages').set(as(t))).body.messages[0];
    expect(m.status).toBe('sent');
    expect(fetchCalls).toBe(0);
  });
});

describe('real channel adapters', () => {
  it('slack/teams/discord deliver via their webhook url (single fetch each)', async () => {
    const t = await token();
    for (const [type, provider] of [
      ['slack', 'slack'],
      ['teams', 'teams'],
      ['discord', 'discord'],
    ] as const) {
      await makeChannel(t, { type, name: `${type}-ch`, provider, config: { url: `https://hook.invalid/${type}` } });
      await request(app).post('/api/send').set(svc).send({ channel: `${type}-ch`, to: '#ops', subject: 'S', body: 'B' });
    }
    fetchCalls = 0;
    await request(app).post('/api/tick').set(as(t));
    expect(fetchCalls).toBe(3); // one real POST per configured channel
    const sent = await request(app).get('/api/messages?status=sent').set(as(t));
    expect(sent.body.messages.length).toBe(3);
  });

  it('degrades slack to console when no webhook url is configured', async () => {
    const t = await token();
    await makeChannel(t, { type: 'slack', name: 'slack-bare', provider: 'slack', config: {} });
    await request(app).post('/api/send').set(svc).send({ channel: 'slack-bare', to: '#ops', body: 'B' });
    await request(app).post('/api/tick').set(as(t));
    const m = (await request(app).get('/api/messages').set(as(t))).body.messages[0];
    expect(m.status).toBe('sent');
    expect(fetchCalls).toBe(0);
  });

  it('sends sms via Twilio only when credentials are configured', async () => {
    const t = await token();
    // Unconfigured → console, no network.
    await makeChannel(t, { type: 'sms', name: 'sms-off', provider: 'twilio-sms' });
    await request(app).post('/api/send').set(svc).send({ channel: 'sms-off', to: '+1555', body: 'hi' });
    await request(app).post('/api/tick').set(as(t));
    expect(fetchCalls).toBe(0);

    // Configured Twilio → real single fetch.
    const twilioApp = createApp({
      db: openDb(':memory:'),
      auth,
      now: () => clock,
      twilio: { accountSid: 'AC1', authToken: 'tok', from: '+1999' },
      fetchImpl: mockFetch,
    });
    const t2 = (await request(twilioApp).post('/api/login').send({ username: 'admin', password: 'test-pass' })).body.token;
    await request(twilioApp).post('/api/channels').set(as(t2)).send({ type: 'sms', name: 'sms-on', provider: 'twilio-sms' }).expect(201);
    await request(twilioApp).post('/api/send').set(svc).send({ channel: 'sms-on', to: '+1555', body: 'hi' });
    fetchCalls = 0;
    await request(twilioApp).post('/api/tick').set(as(t2));
    expect(fetchCalls).toBe(1);
  });
});

describe('channel patch & message history', () => {
  it('patches a channel and reads a message with its event history', async () => {
    const t = await token();
    await makeChannel(t, { type: 'email', name: 'mail', provider: 'console' });
    const channels = await request(app).get('/api/channels').set(as(t));
    const id = channels.body.channels[0].id;
    await request(app).patch(`/api/channels/${id}`).set(as(t)).send({ enabled: false }).expect(200);

    const send = await request(app).post('/api/send').set(svc).send({ channel: 'mail', to: 'x', body: 'B' });
    await request(app).post('/api/tick').set(as(t));
    const detail = await request(app).get(`/api/messages/${send.body.message.id}`).set(as(t));
    expect(detail.status).toBe(200);
    expect(Array.isArray(detail.body.message.events ?? detail.body.events)).toBe(true);
  });
});

describe('identity seam', () => {
  it('accepts a PS-01-verified token when IDENTITY_URL is configured', async () => {
    const identityFetch = async (_url: string, init?: { body?: string }) => {
      const tok = init?.body ? (JSON.parse(init.body).token as string) : '';
      return { ok: true, status: 200, json: async () => ({ valid: tok === 'ps01-good' }) };
    };
    const seamApp = createApp({
      db,
      auth: { ...auth, identityUrl: 'http://identity.test' },
      now: () => clock,
      resendApiKey: null,
      fetchImpl: mockFetch,
      identityFetch,
    });
    expect((await request(seamApp).get('/api/channels').set(as('ps01-good'))).status).toBe(200);
    expect((await request(seamApp).get('/api/channels').set(as('ps01-bad'))).status).toBe(401);
  });
});
