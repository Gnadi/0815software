import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import type { People, PersonEvent } from '../server/people.js';

let db: Database.Database;
let sent: PersonEvent[];
const people: People = { enabled: true, notify: (e) => void sent.push(e), flush: async () => {} };
const T = '2026-11-09T09:00:00Z';
const NOW = Date.parse(T);
import { collectInbox, watchDocuments } from '../server/inbox-rules.js';

/** MOD-09's notification rule: a document past its retention period, to the matter's owners. */

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO users (id, username, name, role, password_hash, created_at) VALUES (1, 'ada@acme.test', 'Ada', 'member', 'x', ?), (2, 'bob', 'Bob', 'member', 'x', ?)").run(T, T);
  db.prepare("INSERT INTO retention_classes (id, name, years, created_by, created_at) VALUES (1, 'Books', 7, 1, ?)").run(T);
  db.prepare("INSERT INTO matters (id, key, name, created_by, created_at) VALUES (1, 'M-1', 'Accounts 2015', 1, ?)").run(T);
  db.prepare("INSERT INTO matter_members (matter_id, user_id, role, created_at) VALUES (1, 1, 'owner', ?), (1, 2, 'owner', ?)").run(T, T);
  db.prepare("INSERT INTO documents (id, matter_id, title, created_by, created_at, retention_class_id, document_date) VALUES (1, 1, 'Ledger 2015', 1, ?, 1, '2015-06-30')").run(T);
  db.prepare("INSERT INTO documents (id, matter_id, title, created_by, created_at, retention_class_id, document_date) VALUES (2, 1, 'Ledger 2025', 1, ?, 1, '2025-06-30')").run(T);
  sent = [];
});

describe('MOD-09', () => {
  it('tells the owners who have an address, once per document and due date; the others are not reachable', () => {
    watchDocuments(db, people, NOW);
    expect(sent).toEqual([expect.objectContaining({ kind: 'retention-due', recipients: ['ada@acme.test'], urgency: 'digest', key: expect.stringMatching(/^retention:1:/) })]);
    expect(collectInbox(db, 'ada@acme.test', 'view', NOW).items.map((i) => i.id)).toEqual(['doc-1']);
    expect(collectInbox(db, 'bob@acme.test', 'view', NOW).count).toBe(0);
  });
});
