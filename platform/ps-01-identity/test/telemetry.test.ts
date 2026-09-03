import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { SessionConfig } from '../server/auth.js';

const session: SessionConfig = { secret: 'test-secret', ttlHours: 12, secureCookie: false };

let db: Database.Database;
let app: Express;

beforeEach(async () => {
  db = openDb(':memory:');
  await seed(db);
  app = createApp({ db, session });
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
    expect(res.text).toContain('http_requests_total{service="ps-01",path="/api/health",status="200"}');
  });
});

describe('the structured request log', () => {
  it('emits one JSON line per request, carrying the request id', async () => {
    // Off by default so test output stays readable; `index.ts` passes true, so
    // this is the shape a deployment's log aggregator actually receives.
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const logged = createApp({ db, session, logRequests: true });
    await request(logged).get('/api/health').set('X-Request-Id', 'trace-me').expect(200);
    spy.mockRestore();

    const entry = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e.path === '/api/health');
    expect(entry).toMatchObject({
      service: 'ps-01',
      request_id: 'trace-me',
      method: 'GET',
      path: '/api/health',
      status: 200,
    });
    expect(typeof entry!.duration_ms).toBe('number');
    expect(String(entry!.ts)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('says nothing when logging is off', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    await request(app).get('/api/health').expect(200);
    spy.mockRestore();
    expect(lines.filter((l) => l.includes('"path":"/api/health"'))).toHaveLength(0);
  });

  it('labels a parameterised route by its pattern, not by the id in it', async () => {
    // Otherwise every user id becomes its own counter series and the metric is
    // unusable — the cardinality problem every Prometheus exporter has to solve.
    const token = (
      await request(app).post('/api/login').send({ org_slug: 'acme', email: 'owner@acme.test', password: 'demo-owner' })
    ).body.token as string;
    await request(app).get('/api/users/1').set({ Authorization: `Bearer ${token}` });
    await request(app).get('/api/users/2').set({ Authorization: `Bearer ${token}` });
    const metrics = await request(app).get('/api/metrics').expect(200);
    expect(metrics.text).not.toMatch(/path="\/api\/users\/1"/);
  });
});

describe('the password-spray gauge', () => {
  it('counts nothing on a quiet deployment', async () => {
    const res = await request(app).get('/api/metrics').expect(200);
    expect(res.text).toContain('# TYPE identity_throttled_accounts gauge');
    expect(res.text).toMatch(/identity_throttled_accounts\{service="ps-01"\} 0/);
  });

  it('counts an account only once it is past the backoff threshold', async () => {
    const spray = async (email: string, times: number): Promise<void> => {
      for (let i = 0; i < times; i++) {
        await request(app).post('/api/login').send({ org_slug: 'acme', email, password: `guess-${i}` });
      }
    };
    // Four failures is somebody mistyping; the default threshold is five.
    await spray('victim@acme.test', 4);
    expect((await request(app).get('/api/metrics')).text).toMatch(/identity_throttled_accounts\{service="ps-01"\} 0/);

    await spray('victim@acme.test', 2);
    expect((await request(app).get('/api/metrics')).text).toMatch(/identity_throttled_accounts\{service="ps-01"\} 1/);
  });

  it('forgets an account once the window has passed', async () => {
    let clock = Date.parse('2026-07-01T00:00:00Z');
    const timed = createApp({ db, session, now: () => clock, sleep: async () => undefined });
    for (let i = 0; i < 6; i++) {
      await request(timed).post('/api/login').send({ org_slug: 'acme', email: 'victim@acme.test', password: `g${i}` });
    }
    expect((await request(timed).get('/api/metrics')).text).toMatch(/identity_throttled_accounts\{service="ps-01"\} 1/);

    clock += 16 * 60_000; // past the 15-minute window
    expect((await request(timed).get('/api/metrics')).text).toMatch(/identity_throttled_accounts\{service="ps-01"\} 0/);
  });

  it('reports -1 rather than throwing when a gauge cannot be read', async () => {
    // A scrape must never fail: Prometheus would record the whole target as
    // down, which is a different and much louder thing than one broken number.
    const { renderMetrics } = await import('../server/telemetry.js');
    const text = renderMetrics('ps-01', [
      {
        name: 'broken_gauge',
        help: 'always throws',
        value: () => {
          throw new Error('the query is wrong');
        },
      },
    ]);
    expect(text).toContain('broken_gauge{service="ps-01"} -1');
  });
});
