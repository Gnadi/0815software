import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { loadKey } from '../server/crypto.js';
import type { AuthConfig } from '../server/auth.js';
import { defaultMailTransport, type MailTransport } from '../server/imap.js';
import { rawMessage, startFakeImap, type FakeImap } from './fixtures/fake-imap.js';
import { TEST_CERT } from './fixtures/tls.js';

/**
 * Mailbox connections (provider `imap`): created with validated credentials
 * that are encrypted and never returned; read over real TLS — implicit and
 * STARTTLS — from a local IMAP server; fetched without being marked read;
 * acknowledged only within the same UIDVALIDITY; behind the egress check.
 */

const auth: AuthConfig = { username: 'admin', password: 'test-pass', secret: 'test-secret', ttlHours: 12, secureCookie: false, serviceToken: 'test-service' };
const encKey = loadKey('11'.repeat(32));
const SERVICE = { 'X-Service-Token': 'test-service' };
let ADMIN: Record<string, string> = {};
const trusted = defaultMailTransport({ ca: TEST_CERT });

let db: Database.Database;
let imap: FakeImap | null = null;

const appWith = (extra: Partial<Parameters<typeof createApp>[0]> = {}): Express =>
  createApp({ db, auth, encryptionKey: encKey, webhookSecret: 'whsec', mailTransport: trusted, ...extra });

beforeEach(async () => {
  db = openDb(':memory:');
  const token = (await request(appWith()).post('/api/login').send({ username: 'admin', password: 'test-pass' })).body.token as string;
  ADMIN = { Authorization: `Bearer ${token}` };
});

const mailbox = async (app: Express, port: number, extra: Record<string, unknown> = {}) =>
  (
    await request(app)
      .post('/api/connections')
      .set(ADMIN)
      .send({ provider: 'imap', name: 'Support inbox', credentials: { host: 'localhost', port, username: 'support@firma.example', password: 'pässwort "quoted"', ...extra } })
      .expect(201)
  ).body.connection as { id: number; external_account: string; scopes: string };

const inbox = () => [
  { uid: 101, raw: rawMessage({ From: 'Anna <anna@kunde.example>', Subject: 'Drucker', 'Message-ID': '<m1@kunde.example>' }, 'Der Drucker streikt.') },
  { uid: 102, raw: rawMessage({ From: 'old@kunde.example', Subject: 'Alt' }, 'schon gelesen'), seen: true },
  {
    uid: 105,
    raw: rawMessage(
      { From: 'Bob <bob@kunde.example>', Subject: 'Mit Anhang', 'Message-ID': '<m2@kunde.example>', 'Content-Type': 'multipart/mixed; boundary=b' },
      '--b\nContent-Type: text/plain\n\nsiehe Anhang\n--b\nContent-Type: application/pdf\nContent-Disposition: attachment; filename="log.pdf"\nContent-Transfer-Encoding: base64\n\nJVBERi0xLjQK\n--b--\n',
    ),
  },
  { uid: 107, raw: rawMessage({ From: 'MAILER-DAEMON@mx.example', Subject: 'Undelivered', 'Auto-Submitted': 'auto-replied' }, 'bounce') },
];

afterEach(async () => {
  await imap?.close();
  imap = null;
});

describe('creating a mailbox connection', () => {
  it('validates, encrypts, and never returns the password', async () => {
    const app = appWith();
    const refused = await request(app)
      .post('/api/connections')
      .set(ADMIN)
      .send({ provider: 'imap', name: 'x', credentials: { host: 'mail.example.com', security: 'none', username: 'u', mailbox: 'Böse' } })
      .expect(422);
    expect(refused.body.details.map((d: { field: string }) => d.field).sort()).toEqual(['credentials.mailbox', 'credentials.password', 'credentials.security']);
    const created = await mailbox(app, 993);
    expect(created).toMatchObject({ external_account: 'support@firma.example @ localhost', scopes: 'INBOX' });
    const stored = db.prepare('SELECT credentials_encrypted FROM connections WHERE id = ?').get(created.id) as { credentials_encrypted: string };
    expect(stored.credentials_encrypted).not.toContain('pässwort');
    expect(JSON.stringify((await request(app).get(`/api/connections/${created.id}`).set(ADMIN).expect(200)).body)).not.toContain('pässwort');
  });

  it('a module reads it with the service token; creating, revoking and proxying stay an administrator\'s', async () => {
    const app = appWith();
    const { id } = await mailbox(app, 993);
    await request(app).post('/api/connections').set(SERVICE).send({ provider: 'imap', name: 'x', credentials: {} }).expect(401);
    await request(app).delete(`/api/connections/${id}`).set(SERVICE).expect(401);
    await request(app).get(`/api/connections/${id}`).set(SERVICE).expect(401);
    await request(app).post(`/api/connections/${id}/mail/fetch`).set({ 'X-Service-Token': 'wrong' }).send({}).expect(401);
    await request(app).get('/api/connections').set(SERVICE).expect(401);
    const listed = (await request(app).get('/api/connections?provider=imap').set(SERVICE).expect(200)).body.connections;
    expect(listed).toEqual([expect.objectContaining({ id, provider: 'imap', name: 'Support inbox' })]);
    expect(JSON.stringify(listed)).not.toMatch(/credentials|pässwort/);
  });

  it('is not an HTTP API, and takes no webhooks', async () => {
    const app = appWith();
    const { id } = await mailbox(app, 993);
    await request(app).post(`/api/connections/${id}/proxy`).set(ADMIN).send({ path: '/' }).expect(422);
    await request(app).post('/api/webhooks/imap').send({}).expect(404);
  });
});

describe.each(['tls', 'starttls'] as const)('reading mail over %s', (mode) => {
  it('probes, fetches unread mail parsed and unmarked, then acknowledges it', async () => {
    imap = await startFakeImap({ mode, username: 'support@firma.example', password: 'pässwort "quoted"', messages: inbox() });
    const app = appWith();
    const { id } = await mailbox(app, imap.port, { security: mode });

    const probe = (await request(app).post(`/api/connections/${id}/mail/probe`).set(SERVICE).send({}).expect(200)).body;
    expect(probe).toEqual({ mailbox: 'INBOX', uidvalidity: 3857529045, exists: 4, unseen: 3 });
    // The UTF-8 password with quotes in it went as a literal, the rest quoted.
    expect(imap.commands).toContain('LOGIN support@firma.example pässwort "quoted"');
    if (mode === 'starttls') expect(imap.commands[0]).toBe('STARTTLS');

    const fetched = (await request(app).post(`/api/connections/${id}/mail/fetch`).set(SERVICE).send({ limit: 10 }).expect(200)).body;
    expect(fetched).toMatchObject({ mailbox: 'INBOX', uidvalidity: 3857529045, remaining: 0 });
    expect(fetched.messages.map((m: { uid: number }) => m.uid)).toEqual([101, 105, 107]);
    expect(fetched.messages[0]).toMatchObject({ message_id: 'm1@kunde.example', from: { name: 'Anna', address: 'anna@kunde.example' }, subject: 'Drucker', text: 'Der Drucker streikt.', automated: null, body_omitted: false });
    expect(fetched.messages[1].attachments).toEqual([{ filename: 'log.pdf', content_type: 'application/pdf', size: 9, inline: false, content_id: null, content_base64: 'JVBERi0xLjQK' }]);
    expect(fetched.messages[2].automated).toBe('Auto-Submitted: auto-replied');
    // Fetching marked nothing read.
    expect(imap.messages.filter((m) => m.seen).map((m) => m.uid)).toEqual([102]);

    const ack = (await request(app).post(`/api/connections/${id}/mail/ack`).set(SERVICE).send({ uidvalidity: 3857529045, uids: [101, 105] }).expect(200)).body;
    expect(ack).toEqual({ acknowledged: 2 });
    expect(imap.messages.filter((m) => !m.seen).map((m) => m.uid)).toEqual([107]);
  });
});

describe('the limits', () => {
  it('a limit on count, a large message as headers only, and the rest left for the next fetch', async () => {
    const big = rawMessage({ From: 'c@kunde.example', Subject: 'Riesig', 'Message-ID': '<big@x>' }, 'x'.repeat(5000));
    imap = await startFakeImap({ mode: 'tls', username: 'support@firma.example', password: 'pässwort "quoted"', messages: [...inbox(), { uid: 110, raw: big }] });
    const app = appWith({ mailLimits: { timeoutMs: 5000, maxMessageBytes: 2000, maxFetchBytes: 400 } });
    const { id } = await mailbox(app, imap.port);
    const first = (await request(app).post(`/api/connections/${id}/mail/fetch`).set(SERVICE).send({ limit: 2 }).expect(200)).body;
    // 101 fits; 105 would exceed the 400-byte fetch budget — it waits.
    expect(first.messages.map((m: { uid: number }) => m.uid)).toEqual([101]);
    expect(first.remaining).toBe(3);
    await request(app).post(`/api/connections/${id}/mail/ack`).set(SERVICE).send({ uidvalidity: 3857529045, uids: [101, 105, 107] }).expect(200);
    const second = (await request(app).post(`/api/connections/${id}/mail/fetch`).set(SERVICE).send({}).expect(200)).body;
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).toMatchObject({ uid: 110, subject: 'Riesig', message_id: 'big@x', body_omitted: true, text: '', attachments: [] });
    expect(second.messages[0].size).toBeGreaterThan(5000);
  });
});

describe('when something is wrong', () => {
  it('a wrong password is the mailbox refusing, recorded on the connection without the secret', async () => {
    imap = await startFakeImap({ mode: 'tls', username: 'support@firma.example', password: 'other', messages: [] });
    const app = appWith();
    const { id } = await mailbox(app, imap.port);
    const res = await request(app).post(`/api/connections/${id}/mail/fetch`).set(SERVICE).send({}).expect(502);
    expect(res.body.error).toBe('The mailbox refused the login');
    const events = db.prepare("SELECT meta FROM connection_events WHERE type = 'error'").all() as { meta: string }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.meta).not.toContain('pässwort');
  });

  it('a certificate nobody vouches for is refused', async () => {
    imap = await startFakeImap({ mode: 'tls', username: 'support@firma.example', password: 'pässwort "quoted"', messages: [] });
    const app = appWith({ mailTransport: defaultMailTransport() });
    const { id } = await mailbox(app, imap.port);
    expect((await request(app).post(`/api/connections/${id}/mail/probe`).set(SERVICE).send({}).expect(502)).body.details[0].message).toMatch(/certificate/i);
  });

  it('UIDs from before the folder changed mark nothing', async () => {
    imap = await startFakeImap({ mode: 'tls', username: 'support@firma.example', password: 'pässwort "quoted"', messages: inbox() });
    const app = appWith();
    const { id } = await mailbox(app, imap.port);
    imap.uidvalidity = 42;
    await request(app).post(`/api/connections/${id}/mail/ack`).set(SERVICE).send({ uidvalidity: 3857529045, uids: [101] }).expect(409);
    expect(imap.messages.find((m) => m.uid === 101)!.seen).toBeFalsy();
    await request(app).post(`/api/connections/${id}/mail/ack`).set(SERVICE).send({ uidvalidity: 3857529045, uids: ['x'] }).expect(422);
  });

  it('a revoked connection, an unreachable host, and not a mailbox at all', async () => {
    const app = appWith({ mailLimits: { timeoutMs: 2000, maxMessageBytes: 1e6, maxFetchBytes: 1e7 } });
    const { id } = await mailbox(app, 1); // nothing listens on port 1
    expect((await request(app).post(`/api/connections/${id}/mail/probe`).set(SERVICE).send({}).expect(502)).body.error).toBe('The mailbox could not be read');
    await request(app).delete(`/api/connections/${id}`).set(ADMIN).expect(200);
    await request(app).post(`/api/connections/${id}/mail/probe`).set(SERVICE).send({}).expect(409);
    const rest = (await request(app).post('/api/connections').set(ADMIN).send({ provider: 'rest', name: 'api', credentials: { token: 't' } }).expect(201)).body.connection;
    await request(app).post(`/api/connections/${rest.id}/mail/fetch`).set(SERVICE).send({}).expect(422);
  });
});

describe('the egress check covers mailboxes', () => {
  it('an internal address is refused, and the socket goes to exactly the address that was checked', async () => {
    imap = await startFakeImap({ mode: 'tls', username: 'support@firma.example', password: 'pässwort "quoted"', messages: [] });
    const opened: { host: string; address: string }[] = [];
    const spy: MailTransport = {
      open(t) {
        opened.push({ host: t.host, address: t.address });
        return trusted.open({ ...t, host: 'localhost', address: '127.0.0.1' });
      },
      upgrade: trusted.upgrade,
    };
    const resolve = async (host: string) => (host === 'intranet.example.com' ? ['10.0.0.7'] : ['203.0.113.10']);
    const app = appWith({ mailTransport: spy, egress: { mode: 'block', allowHosts: new Set() }, resolveHost: resolve });

    const internal = (await request(app).post('/api/connections').set(ADMIN).send({ provider: 'imap', name: 'x', credentials: { host: 'intranet.example.com', username: 'u', password: 'p' } }).expect(201)).body.connection;
    const refused = await request(app).post(`/api/connections/${internal.id}/mail/fetch`).set(SERVICE).send({}).expect(403);
    expect(refused.body.details[0].message).toBe('intranet.example.com resolves to the internal address 10.0.0.7');
    expect(opened).toEqual([]);

    const external = (await request(app).post('/api/connections').set(ADMIN).send({ provider: 'imap', name: 'y', credentials: { host: 'mail.example.com', port: imap.port, username: 'support@firma.example', password: 'pässwort "quoted"' } }).expect(201)).body.connection;
    await request(app).post(`/api/connections/${external.id}/mail/probe`).set(SERVICE).send({}).expect(200);
    expect(opened).toEqual([{ host: 'mail.example.com', address: '203.0.113.10' }]);
  });
});
