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
  app = createApp({ db, auth, keySecret: '33'.repeat(32) });
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
    expect(res.text).toContain('http_requests_total{service="ps-12",path="/api/health",status="200"}');
  });

  it('counts connections a human has activated', async () => {
    db.prepare(
      `INSERT INTO bank_connections (key, display_name, bank_key, url, host_id, partner_id, user_id,
                                     ebics_version, es_version, max_amount_minor, max_transfers, created_at)
       VALUES ('main', 'Test', 'generic', 'https://b.example', 'H', 'P', 'U', 'H005', 'A005', 1000, 5, '2026-08-20T00:00:00Z')`,
    ).run();
    const key = db.prepare(
      `INSERT INTO bank_keys (connection_id, purpose, version, public_pem, digest, fetched_at, verified_at)
       VALUES (1, 'AUTH', 'X002', 'pem', 'digest', '2026-08-20T00:00:00Z', ?)`,
    );
    key.run(null);
    expect((await request(app).get('/api/metrics')).text).toContain('banking_connections_ready{service="ps-12"} 0');

    // The gauge counts the human step, not the protocol one: keys fetched but
    // unconfirmed are exactly the state that must NOT read as ready.
    db.prepare("UPDATE bank_keys SET verified_at = '2026-08-20T01:00:00Z'").run();
    expect((await request(app).get('/api/metrics')).text).toContain('banking_connections_ready{service="ps-12"} 1');
  });

  it('counts orders whose outcome is unknown', async () => {
    db.prepare(
      `INSERT INTO bank_connections (key, display_name, bank_key, url, host_id, partner_id, user_id,
                                     ebics_version, es_version, max_amount_minor, max_transfers, created_at)
       VALUES ('main', 'Test', 'generic', 'https://b.example', 'H', 'P', 'U', 'H005', 'A005', 1000, 5, '2026-08-20T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO orders (connection_id, public_id, msg_id, btf, payload_sha256, created_at)
       VALUES (1, 'ord_1', 'M1', '{}', 'abc', '2026-08-20T00:00:00Z')`,
    ).run();
    const ev = db.prepare("INSERT INTO order_events (order_id, type, meta, created_at) VALUES (1, ?, '{}', '2026-08-20T00:00:00Z')");
    ev.run('queued');
    expect((await request(app).get('/api/metrics')).text).toContain('banking_orders_failed{service="ps-12"} 0');

    // A failure is an order that may or may not be at the bank, so it stays
    // counted: this gauge is a list of things a human has to go and check.
    ev.run('failed');
    expect((await request(app).get('/api/metrics')).text).toContain('banking_orders_failed{service="ps-12"} 1');
  });
});
