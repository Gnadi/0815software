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
const svc = { 'X-Service-Token': 'test-service' };
let clock: number;

let db: Database.Database;
let app: Express;

beforeEach(() => {
  db = openDb(':memory:');
  clock = Date.parse('2026-07-01T00:00:00Z');
  app = createApp({ db, auth, now: () => clock });
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
    expect(res.text).toContain('http_requests_total{service="ps-07",path="/api/health",status="200"}');
  });

  it('exposes audit_chain_valid and flips it on tampering (after the cache expires)', async () => {
    await request(app)
      .post('/api/events')
      .set(svc)
      .send({ actor: 'user:1', action: 'thing.done', resource: 'thing:1' })
      .expect(201);
    expect((await request(app).get('/api/metrics')).text).toContain('audit_chain_valid{service="ps-07"} 1');

    db.prepare("UPDATE audit_events SET action = 'tampered' WHERE id = 1").run();
    // Verdict is cached for a minute — still reported valid…
    expect((await request(app).get('/api/metrics')).text).toContain('audit_chain_valid{service="ps-07"} 1');
    // …until the cache expires.
    clock += 60_000;
    expect((await request(app).get('/api/metrics')).text).toContain('audit_chain_valid{service="ps-07"} 0');
  });
});
