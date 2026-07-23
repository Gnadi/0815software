import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { loadKey } from '../server/crypto.js';
import { providerEntry } from '../server/provider-registry.js';
import { expectedSignature } from '../server/webhooks.js';
import type { AuthConfig } from '../server/auth.js';
import type { FetchLike } from '../server/proxy.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};
const encKey = loadKey('11'.repeat(32));
const webhookSecret = 'whsec-test';
const as = (t: string) => ({ Authorization: `Bearer ${t}` });

let db: Database.Database;
let app: Express;
let lastCall: { url: string; init: { method: string; headers: Record<string, string>; body?: string } } | null;

const mockFetch: FetchLike = async (url, init) => {
  lastCall = { url, init };
  return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
};

async function token(): Promise<string> {
  return (await request(app).post('/api/login').send({ username: 'admin', password: 'test-pass' })).body.token as string;
}

beforeEach(() => {
  db = openDb(':memory:');
  lastCall = null;
  app = createApp({ db, auth, encryptionKey: encKey, webhookSecret, fetchImpl: mockFetch });
});

describe('encryption key', () => {
  it('rejects a malformed key (fail fast)', () => {
    expect(() => loadKey('too-short')).toThrow();
    expect(() => loadKey('zz'.repeat(32))).toThrow();
    expect(loadKey('ab'.repeat(32)).length).toBe(32);
  });
});

describe('auth & registry', () => {
  it('gates admin routes and lists providers', async () => {
    expect((await request(app).get('/api/health')).body).toEqual({ ok: true });
    expect((await request(app).get('/api/connections')).status).toBe(401);
    const t = await token();
    const providers = await request(app).get('/api/providers').set(as(t));
    expect(providers.body.providers.map((p: { key: string }) => p.key)).toContain('github');
  });
});

describe('connections: credentials encrypted at rest', () => {
  it('never returns plaintext credentials and stores only ciphertext', async () => {
    const t = await token();
    const created = await request(app)
      .post('/api/connections')
      .set(as(t))
      .send({ provider: 'github', name: 'gh', credentials: { access_token: 'super-secret-token' } });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain('super-secret-token');
    expect(created.body.connection.credentials).toBeUndefined();

    const fetched = await request(app).get(`/api/connections/${created.body.connection.id}`).set(as(t));
    expect(JSON.stringify(fetched.body)).not.toContain('super-secret-token');

    // Stored column is ciphertext, not the plaintext.
    const row = db.prepare('SELECT credentials_encrypted FROM connections WHERE id = ?').get(created.body.connection.id) as {
      credentials_encrypted: string;
    };
    expect(row.credentials_encrypted).not.toContain('super-secret-token');
    expect(row.credentials_encrypted.split(':').length).toBe(3); // iv:tag:ciphertext

    expect((await request(app).get('/api/connections/9999').set(as(t))).status).toBe(404);
  });
});

describe('inbound webhooks', () => {
  it('verifies signatures: 401 missing, 403 bad, 202 good (all recorded)', async () => {
    const t = await token();
    const payload = { action: 'opened', number: 7 };
    const raw = JSON.stringify(payload);
    const good = expectedSignature(providerEntry('github')!, webhookSecret, raw);

    // Missing signature.
    expect((await request(app).post('/api/webhooks/github').send(payload)).status).toBe(401);

    // Bad signature → 403, recorded invalid.
    const bad = await request(app).post('/api/webhooks/github').set('X-Hub-Signature-256', 'sha256=deadbeef').send(payload);
    expect(bad.status).toBe(403);
    expect(bad.body.signature_valid).toBe(false);

    // Good signature → 202, recorded valid.
    const ok = await request(app).post('/api/webhooks/github').set('X-Hub-Signature-256', good).send(payload);
    expect(ok.status).toBe(202);
    expect(ok.body.signature_valid).toBe(true);

    const events = await request(app).get('/api/webhook-events').set(as(t));
    expect(events.body.webhook_events.length).toBe(2);
    expect(events.body.webhook_events.some((e: { signature_valid: boolean }) => e.signature_valid)).toBe(true);

    // Unknown provider → 404.
    expect((await request(app).post('/api/webhooks/nope').send(payload)).status).toBe(404);
  });
});

describe('proxy', () => {
  it('injects the provider auth header and shapes the outbound request', async () => {
    const t = await token();
    const conn = await request(app)
      .post('/api/connections')
      .set(as(t))
      .send({ provider: 'github', name: 'gh', credentials: { access_token: 'tok-123' } });
    const id = conn.body.connection.id;

    const proxied = await request(app).post(`/api/connections/${id}/proxy`).set(as(t)).send({ method: 'GET', path: '/user' });
    expect(proxied.status).toBe(200);
    expect(lastCall?.url).toBe('https://api.github.com/user');
    expect(lastCall?.init.headers.authorization).toBe('Bearer tok-123');

    // GraphQL shapes the body.
    await request(app).post(`/api/connections/${id}/graphql`).set(as(t)).send({ query: '{ viewer { login } }' });
    expect(JSON.parse(lastCall!.init.body!).query).toBe('{ viewer { login } }');

    // Unknown connection → 404.
    expect((await request(app).post('/api/connections/424242/proxy').set(as(t)).send({ method: 'GET', path: '/x' })).status).toBe(404);
  });
});
