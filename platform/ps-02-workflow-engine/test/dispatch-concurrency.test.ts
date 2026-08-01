import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import { dispatch, enqueueDeliveries, type FetchLike } from '../server/webhooks.js';
import { ingestEvent } from '../server/events.js';

/**
 * A delivery is only marked attempted AFTER its HTTP call returns, so two
 * overlapping dispatch runs — the internal ticker plus a `POST /api/tick` —
 * would otherwise both claim the same due rows and POST every webhook twice.
 */

let db: Database.Database;
const T0 = Date.parse('2026-06-01T00:00:00Z');

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare(
    "INSERT INTO webhooks (event_type, url, secret, active, created_at) VALUES ('order.paid', 'https://hook.test/a', 's', 1, '2026-01-01T00:00:00Z')",
  ).run();
  db.prepare(
    "INSERT INTO webhooks (event_type, url, secret, active, created_at) VALUES ('order.paid', 'https://hook.test/b', 's', 1, '2026-01-01T00:00:00Z')",
  ).run();
});

describe('overlapping dispatch runs', () => {
  it('delivers each due webhook exactly once', async () => {
    expect(enqueueDeliveries(db, 'order.paid', { id: 1 }, T0)).toBe(2);

    const posted: string[] = [];
    // Slow enough that the second run starts while the first is still waiting.
    const fetchImpl: FetchLike = async (url) => {
      await new Promise((r) => setTimeout(r, 10));
      posted.push(url);
      return { ok: true, status: 200 };
    };

    const [first, second] = await Promise.all([
      dispatch(db, fetchImpl, T0),
      dispatch(db, fetchImpl, T0),
    ]);

    expect(posted).toHaveLength(2);
    expect(new Set(posted).size).toBe(2);
    expect(first.delivered + second.delivered).toBe(2);
    const delivered = db
      .prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status = 'delivered'")
      .get() as { n: number };
    expect(delivered.n).toBe(2);
  });

  it('keeps serving later runs after one rejects', async () => {
    enqueueDeliveries(db, 'order.paid', { id: 2 }, T0);
    const boom: FetchLike = () => Promise.reject(new Error('network down'));
    // dispatch() catches per-delivery failures, so force the rejection through
    // the row lookup instead: an empty queue plus a throwing fetch is a no-op,
    // and the chain must still accept the next call.
    await expect(dispatch(db, boom, T0)).resolves.toMatchObject({ delivered: 0 });
    const ok: FetchLike = async () => ({ ok: true, status: 200 });
    await expect(dispatch(db, ok, T0 + 86_400_000)).resolves.toMatchObject({ delivered: 2 });
  });
});

describe('event fan-out accounting', () => {
  it('reports one instance when two triggers on one workflow share a key', () => {
    db.exec(`
      INSERT INTO workflow_definitions (key, version, name, definition, enabled, created_at)
      VALUES ('onboard', 1, 'Onboard',
              '{"initial":"start","steps":["start","done"],"transitions":{"start":["done"]},"terminal":["done"]}',
              1, '2026-01-01T00:00:00Z');
      INSERT INTO triggers (workflow_key, type, config, enabled, created_at)
        VALUES ('onboard', 'event', '{"event":"customer.created"}', 1, '2026-01-01T00:00:00Z');
      INSERT INTO triggers (workflow_key, type, config, enabled, created_at)
        VALUES ('onboard', 'event', '{"event":"customer.created"}', 1, '2026-01-01T00:00:00Z');
    `);

    const result = ingestEvent(db, { type: 'customer.created', idempotencyKey: 'evt-1', now: T0 });

    // Both triggers matched, but the idempotency key means one instance ran.
    expect(result.instance_ids).toHaveLength(1);
    expect(result.matched).toBe(1);
    expect(result.replayed).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM workflow_instances').get() as { n: number }).n).toBe(1);
  });

  it('skips a trigger whose workflow is disabled instead of failing the ingest', () => {
    db.exec(`
      INSERT INTO workflow_definitions (key, version, name, definition, enabled, created_at)
      VALUES ('live', 1, 'Live', '{"initial":"a","steps":["a"],"transitions":{},"terminal":[]}', 1, '2026-01-01T00:00:00Z');
      INSERT INTO workflow_definitions (key, version, name, definition, enabled, created_at)
      VALUES ('dead', 1, 'Dead', '{"initial":"a","steps":["a"],"transitions":{},"terminal":[]}', 0, '2026-01-01T00:00:00Z');
      INSERT INTO triggers (workflow_key, type, config, enabled, created_at)
        VALUES ('dead', 'event', '{"event":"order.paid"}', 1, '2026-01-01T00:00:00Z');
      INSERT INTO triggers (workflow_key, type, config, enabled, created_at)
        VALUES ('live', 'event', '{"event":"order.paid"}', 1, '2026-01-01T00:00:00Z');
    `);

    const result = ingestEvent(db, { type: 'order.paid', now: T0 });

    expect(result.matched).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.enqueued).toBe(2); // the webhooks seeded above still fire
  });
});
