import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import { enqueue, tick } from '../server/queue.js';
import type { ProviderResolver } from '../server/providers/index.js';

/**
 * A message is only marked sent AFTER the provider call returns, so two
 * overlapping ticks — the internal ticker plus a `POST /api/tick`, or a slow
 * provider and the next timer firing — would otherwise both pick up the same
 * queued row and the recipient would get two copies of the same mail.
 */

let db: Database.Database;
const T0 = Date.parse('2026-06-01T00:00:00Z');

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare(
    "INSERT INTO channels (type, name, provider, config, created_at) VALUES ('email', 'c', 'console', '{}', '2026-01-01T00:00:00Z')",
  ).run();
});

describe('overlapping ticks', () => {
  it('sends each queued message exactly once', async () => {
    for (let i = 0; i < 3; i++) {
      enqueue(db, {
        channelId: 1,
        templateKey: null,
        to: `person-${i}@example.test`,
        subject: 'Invoice',
        body: 'hello',
        variables: {},
        idempotencyKey: null,
        now: T0,
      });
    }

    // A provider slow enough that a second tick starts while the first is
    // still waiting on it — the exact shape of the double-send.
    const sent: string[] = [];
    const resolve: ProviderResolver = () => ({
      name: 'slow',
      async send({ to }) {
        await new Promise((r) => setTimeout(r, 10));
        sent.push(to);
        return { ok: true, providerMessageId: `m-${sent.length}` };
      },
    });

    const [first, second] = await Promise.all([
      tick(db, resolve, T0, 0),
      tick(db, resolve, T0, 0),
    ]);

    expect(sent).toHaveLength(3);
    expect(new Set(sent).size).toBe(3);
    expect(first.sent + second.sent).toBe(3);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'sent'").get() as { n: number };
    expect(rows.n).toBe(3);
  });
});
