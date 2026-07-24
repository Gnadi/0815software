import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
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
  app = createApp({ db, auth, webhookSecret: 'whsec-test' });
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
    expect(res.text).toContain('http_requests_total{service="ps-08",path="/api/health",status="200"}');
  });

  it('counts intents whose latest event is processing', async () => {
    db.prepare(
      "INSERT INTO payment_intents (public_id, reference, provider, amount_minor, currency, created_at) VALUES ('pi_1', 'r1', 'mock', 1000, 'EUR', '2026-07-01T00:00:00Z')",
    ).run();
    const ev = db.prepare("INSERT INTO intent_events (intent_id, type, created_at) VALUES (1, ?, '2026-07-01T00:00:00Z')");
    ev.run('created');
    ev.run('processing');
    expect((await request(app).get('/api/metrics')).text).toContain('payments_processing_intents{service="ps-08"} 1');
    ev.run('succeeded');
    expect((await request(app).get('/api/metrics')).text).toContain('payments_processing_intents{service="ps-08"} 0');
  });
});
