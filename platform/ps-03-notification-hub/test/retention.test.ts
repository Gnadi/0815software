import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import { pruneMessages } from '../server/queue.js';

let db: Database.Database;
const DAY = 86_400_000;
const T0 = Date.parse('2026-06-01T00:00:00Z');

function insert(status: string, createdMs: number): void {
  const at = new Date(createdMs).toISOString();
  db.prepare(
    `INSERT INTO messages (channel_id, to_address, body, status, next_attempt_at, created_at, updated_at)
     VALUES (1, 'a@b.test', 'hi', ?, ?, ?, ?)`,
  ).run(status, at, at, at);
}

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare(
    "INSERT INTO channels (type, name, provider, config, created_at) VALUES ('email', 'c', 'console', '{}', '2026-01-01T00:00:00Z')",
  ).run();
});

describe('message retention (PII bounding)', () => {
  it('prunes old sent + dead messages but keeps recent and in-flight ones', () => {
    insert('sent', T0 - 40 * DAY); // old terminal → pruned
    insert('dead', T0 - 40 * DAY); // old terminal → pruned
    insert('sent', T0 - 5 * DAY); // recent terminal → kept
    insert('queued', T0 - 40 * DAY); // in-flight → kept regardless of age
    insert('failed', T0 - 40 * DAY); // retrying → kept

    const removed = pruneMessages(db, 30, T0);
    expect(removed).toBe(2);

    const remaining = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    expect(remaining).toBe(3);
  });

  it('is a no-op when retention is disabled (0)', () => {
    insert('sent', T0 - 400 * DAY);
    expect(pruneMessages(db, 0, T0)).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(1);
  });
});
