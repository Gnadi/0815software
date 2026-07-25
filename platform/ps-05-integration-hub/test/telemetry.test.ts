import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { loadKey } from '../server/crypto.js';
import type { AuthConfig } from '../server/auth.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};

let db: Database.Database;
let app: Express;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, auth, encryptionKey: loadKey('11'.repeat(32)), webhookSecret: 'whsec-test' });
});

describe('telemetry', () => {
  it('reports readiness once migrations are current', async () => {
    const res = await request(app).get('/api/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ready: true });
  });

  it('stamps X-Request-Id and echoes a provided one', async () => {
    const fresh = await request(app).get('/api/health');
    expect(fresh.headers['x-request-id']).toMatch(/^[0-9a-f]{16}$/);
    const echoed = await request(app).get('/api/health').set('X-Request-Id', 'fixed-id');
    expect(echoed.headers['x-request-id']).toBe('fixed-id');
  });

  it('exposes request counters in Prometheus text format', async () => {
    await request(app).get('/api/health').expect(200);
    const res = await request(app).get('/api/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('# TYPE http_requests_total counter');
    expect(res.text).toContain('http_requests_total{service="ps-05",path="/api/health",status="200"}');
  });

  it('counts pending and failed sync jobs', async () => {
    db.prepare(
      "INSERT INTO connections (provider, name, credentials_encrypted, status, created_at, updated_at) VALUES ('mock', 'c', 'enc', 'connected', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
    ).run();
    const ins = db.prepare(
      "INSERT INTO sync_jobs (connection_id, kind, status, created_at, updated_at) VALUES (1, 'pull', ?, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
    );
    ins.run('pending');
    ins.run('running');
    ins.run('failed');
    ins.run('done');
    const res = await request(app).get('/api/metrics');
    expect(res.text).toContain('integration_pending_sync_jobs{service="ps-05"} 2');
    expect(res.text).toContain('integration_failed_sync_jobs{service="ps-05"} 1');
  });
});
