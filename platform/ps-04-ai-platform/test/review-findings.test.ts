import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import { runChat, type ChatConfig } from '../server/chat.js';

/**
 * Defects found by the platform-wide review (docs/TEST-PLAN-PLATFORM.md).
 * Each test fails against the code as it was before the fix.
 */

let db: Database.Database;

const config: ChatConfig = {
  anthropicApiKey: null,
  anthropicModel: 'x',
  openaiApiKey: null,
  openaiModel: 'x',
  geminiApiKey: null,
  geminiModel: 'x',
  ollamaBaseUrl: null,
  ollamaModel: 'x',
  kimiApiKey: null,
  kimiModel: 'x',
  kimiBaseUrl: 'x',
};

beforeEach(() => {
  db = openDb(':memory:');
});

describe('P4-1 · An idempotency key answers, even when two callers race', () => {
  it('gives both concurrent callers the same completion instead of a 500', async () => {
    const messages = [{ role: 'user' as const, content: 'draft a reply' }];
    // Two requests in flight at once under one key: both pass the "has this
    // key been seen?" check before either has written its row.
    const [a, b] = await Promise.all([
      runChat(db, config, { messages, idempotencyKey: 'k1' }),
      runChat(db, config, { messages, idempotencyKey: 'k1' }),
    ]);

    expect(a.id).toBe(b.id);
    expect(a.text).toBe(b.text);
    // Exactly one completion is stored under the key.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM completions WHERE idempotency_key = 'k1'").get() as { n: number }).n,
    ).toBe(1);
  });

  it('still replays a sequential repeat from the store', async () => {
    const messages = [{ role: 'user' as const, content: 'hello' }];
    const first = await runChat(db, config, { messages, idempotencyKey: 'k2' });
    const again = await runChat(db, config, { messages, idempotencyKey: 'k2' });
    expect(again.id).toBe(first.id);
    expect((db.prepare('SELECT COUNT(*) AS n FROM completions').get() as { n: number }).n).toBe(1);
  });
});
