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

function locationQuery(location: string): URLSearchParams {
  const qIdx = location.indexOf('?');
  return new URLSearchParams(qIdx >= 0 ? location.slice(qIdx + 1) : '');
}

describe('OAuth connect flow (mock IdP)', () => {
  it('authorize → callback provisions an encrypted connection', async () => {
    const t = await token();
    const authorize = await request(app).get('/api/connections/github/authorize?name=my-gh').set(as(t)).redirects(0);
    expect(authorize.status).toBe(302);
    const loc = authorize.headers['location'] as string;
    expect(loc).toContain('/api/connections/github/callback');
    const q = locationQuery(loc);

    const callback = await request(app)
      .get(`/api/connections/github/callback?state=${q.get('state')}&code=${q.get('code')}`)
      .set(as(t))
      .redirects(0);
    expect(callback.status).toBe(201);
    expect(callback.body.connection.provider).toBe('github');
    expect(callback.body.connection.name).toBe('my-gh');
    // Credentials are never returned.
    expect(callback.body.connection.credentials).toBeUndefined();
    expect(callback.body.connection.credentials_encrypted).toBeUndefined();
  });

  it('rejects a callback with an invalid state', async () => {
    const t = await token();
    const res = await request(app).get('/api/connections/github/callback?state=nope&code=x').set(as(t)).redirects(0);
    expect(res.status).toBe(400);
  });

  it('unknown provider on authorize is 404', async () => {
    const t = await token();
    expect((await request(app).get('/api/connections/nope/authorize').set(as(t)).redirects(0)).status).toBe(404);
  });
});

describe('token refresh & sync worker', () => {
  it('refreshes a mock connection and rotates its access token', async () => {
    const t = await token();
    const authorize = await request(app).get('/api/connections/github/authorize').set(as(t)).redirects(0);
    const q = locationQuery(authorize.headers['location'] as string);
    const cb = await request(app)
      .get(`/api/connections/github/callback?state=${q.get('state')}&code=${q.get('code')}`)
      .set(as(t))
      .redirects(0);
    const id = cb.body.connection.id;

    const refresh = await request(app).post(`/api/connections/${id}/refresh`).set(as(t));
    expect(refresh.status).toBe(200);
    expect(refresh.body.refreshed).toBe(true);
  });

  it('drives sync jobs pending → done on tick', async () => {
    const t = await token();
    const conn = await request(app)
      .post('/api/connections')
      .set(as(t))
      .send({ provider: 'stripe', name: 'billing', credentials: { access_token: 'x' } });
    const id = conn.body.connection.id;
    const job = await request(app).post(`/api/connections/${id}/sync`).set(as(t)).send({ kind: 'charges' });
    expect(job.body.sync_job.status).toBe('pending');

    const tick = await request(app).post('/api/tick').set(as(t));
    expect(tick.body.ran).toBe(1);

    const jobs = await request(app).get('/api/sync-jobs').set(as(t));
    const done = jobs.body.sync_jobs.find((j: { id: number }) => j.id === job.body.sync_job.id);
    expect(done.status).toBe('done');
    expect(done.records).toBeGreaterThan(0);
  });
});

describe('inbound webhook signature schemes', () => {
  it('accepts a valid stripe signature and rejects a bad one', async () => {
    const entry = providerEntry('stripe')!;
    const payload = JSON.stringify({ id: 'evt_1' });
    const good = expectedSignature(entry, webhookSecret, payload);
    const ok = await request(app)
      .post('/api/webhooks/stripe')
      .set(entry.signature_header!, `${entry.signature_prefix}${good}`)
      .set('content-type', 'application/json')
      .send(payload);
    expect(ok.status).toBe(202);
    expect(ok.body.signature_valid).toBe(true);

    const bad = await request(app)
      .post('/api/webhooks/stripe')
      .set(entry.signature_header!, 'deadbeef')
      .set('content-type', 'application/json')
      .send(payload);
    expect(bad.status).toBe(403);
  });

  it('accepts a "none"-scheme provider without a signature', async () => {
    // google is auth_type oauth2 with signature_scheme none.
    const res = await request(app).post('/api/webhooks/google').set('content-type', 'application/json').send({ x: 1 });
    expect(res.status).toBe(202);
  });
});

describe('identity seam', () => {
  it('accepts a PS-01-verified token when IDENTITY_URL is set', async () => {
    const identityFetch = async (_url: string, init?: { body?: string }) => {
      const tok = init?.body ? (JSON.parse(init.body).token as string) : '';
      return { ok: true, status: 200, json: async () => ({ valid: tok === 'ps01-good', permissions: ['platform:admin'] }) };
    };
    const seamApp = createApp({
      db,
      auth: { ...auth, identityUrl: 'http://identity.test' },
      encryptionKey: encKey,
      webhookSecret,
      fetchImpl: mockFetch,
      identityFetch,
    });
    expect((await request(seamApp).get('/api/connections').set(as('ps01-good'))).status).toBe(200);
    expect((await request(seamApp).get('/api/connections').set(as('ps01-bad'))).status).toBe(401);
  });
});

describe('schema migrations', () => {
  it('adds sync_jobs.records to a legacy database', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ps05-mig-'));
    const path = join(dir, 'legacy.db');
    try {
      const legacy = new Database(path);
      legacy.exec(`
        CREATE TABLE sync_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, connection_id INTEGER NOT NULL,
          kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', cursor TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations VALUES (1, 'baseline', '2026-01-01T00:00:00Z');
      `);
      legacy.close();
      const upgraded = openDb(path);
      const cols = (upgraded.prepare("PRAGMA table_info('sync_jobs')").all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain('records'); // migration 2 applied
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
