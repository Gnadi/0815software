import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import { ingestEvent } from '../server/events.js';

/**
 * Defects found by the platform-wide review (docs/TEST-PLAN-PLATFORM.md).
 * Each test fails against the code as it was before the fix.
 */

const T0 = Date.parse('2026-03-01T09:00:00Z');
let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  db.exec(`
    INSERT INTO workflow_definitions (key, version, name, definition, enabled, created_at)
    VALUES ('onboard', 1, 'Onboard',
            '{"initial":"start","steps":["start","done"],"transitions":{"start":["done"]},"terminal":["done"]}',
            1, '2026-01-01T00:00:00Z');
    INSERT INTO triggers (workflow_key, type, config, enabled, created_at)
      VALUES ('onboard', 'event', '{"event":"customer.created"}', 1, '2026-01-01T00:00:00Z');
    INSERT INTO webhooks (event_type, url, secret, active, created_at)
      VALUES ('customer.created', 'https://subscriber.example/hook', 's3cret', 1, '2026-01-01T00:00:00Z');
  `);
});

const deliveries = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries').get() as { n: number }).n;

describe('P2-1 · An idempotency key covers the whole ingest, fan-out included', () => {
  it('does not enqueue a second delivery when the same event is replayed', () => {
    const first = ingestEvent(db, { type: 'customer.created', idempotencyKey: 'evt-1', now: T0 });
    expect(first.enqueued).toBe(1);
    expect(deliveries()).toBe(1);

    // The caller timed out and retried with the same key: the instance is
    // already deduped, and the subscriber must not be told twice either.
    const replay = ingestEvent(db, { type: 'customer.created', idempotencyKey: 'evt-1', now: T0 + 1000 });
    expect(replay.instance_ids).toEqual(first.instance_ids);
    expect(replay.enqueued).toBe(0);
    expect(deliveries()).toBe(1);
  });

  it('still fans out for a genuinely new event under a different key', () => {
    ingestEvent(db, { type: 'customer.created', idempotencyKey: 'evt-1', now: T0 });
    const second = ingestEvent(db, { type: 'customer.created', idempotencyKey: 'evt-2', now: T0 + 1000 });
    expect(second.enqueued).toBe(1);
    expect(deliveries()).toBe(2);
  });

  it('leaves the un-keyed ingest alone — at-least-once by design', () => {
    ingestEvent(db, { type: 'customer.created', now: T0 });
    ingestEvent(db, { type: 'customer.created', now: T0 + 1000 });
    expect(deliveries()).toBe(2);
  });
});

describe('P2-2 · A delivered webhook is not re-delivered by the retry button', () => {
  it('refuses to re-queue a delivery that already succeeded', async () => {
    const { createApp } = await import('../server/app.js');
    const request = (await import('supertest')).default;
    const auth = {
      username: 'admin',
      password: 'pw',
      secret: 'test-secret',
      ttlHours: 12,
      secureCookie: false,
      serviceToken: 'test-service',
    };
    const app = createApp({ db, auth });
    const login = await request(app).post('/api/login').send({ username: 'admin', password: 'pw' });
    const token = (login.body as { token: string }).token;

    ingestEvent(db, { type: 'customer.created', now: T0 });
    db.prepare(`UPDATE webhook_deliveries SET status = 'delivered', attempts = 1, response_status = 200`).run();

    const res = await request(app).post('/api/deliveries/1/retry').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(
      (db.prepare('SELECT status FROM webhook_deliveries WHERE id = 1').get() as { status: string }).status,
    ).toBe('delivered');
  });
});
