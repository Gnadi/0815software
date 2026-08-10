/**
 * The service's headline claim is that the log is tamper-EVIDENT. This suite is
 * the adversarial proof of it: every way a row can be attacked at the SQL
 * level, with the verdict `GET /api/verify` would return.
 *
 * The last two cases are the regression: a chain of per-row hashes proves
 * nothing about events removed from the END of the log — the survivors still
 * chain perfectly. Truncating the tail, and wiping the table outright, both
 * used to verify `{ valid: true }`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { pruneForRetention, recordEvent, verifyChain } from '../server/audit.js';
import type { AuthConfig } from '../server/auth.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};
const START = Date.parse('2026-01-01T00:00:00Z');

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  for (let i = 1; i <= 5; i++) {
    recordEvent(db, { actor: `u${i}`, action: 'invoice.issued', resource: `invoice/${i}` }, START + i * 1000);
  }
  expect(verifyChain(db).valid).toBe(true);
});

describe('tamper evidence', () => {
  it('catches a rewritten event', () => {
    db.prepare("UPDATE audit_events SET actor = 'mallory' WHERE id = 3").run();
    expect(verifyChain(db)).toMatchObject({ valid: false, broken_at: 3, broken_kind: 'link' });
  });

  it('catches an event removed from the middle', () => {
    db.prepare('DELETE FROM audit_events WHERE id = 3').run();
    expect(verifyChain(db)).toMatchObject({ valid: false, broken_at: 4, broken_kind: 'link' });
  });

  it('catches reordered events', () => {
    db.prepare('UPDATE audit_events SET id = 99 WHERE id = 2').run();
    expect(verifyChain(db).valid).toBe(false);
  });

  it('catches a truncated tail — the edit that covers the attacker’s tracks', () => {
    db.prepare('DELETE FROM audit_events WHERE id >= 4').run();
    const verdict = verifyChain(db);
    // The three survivors chain flawlessly; only the head marker gives it away.
    expect(verdict).toMatchObject({ valid: false, count: 3, broken_kind: 'truncated' });
  });

  it('catches the whole log being wiped', () => {
    db.prepare('DELETE FROM audit_events').run();
    expect(verifyChain(db)).toMatchObject({ valid: false, count: 0, broken_kind: 'truncated' });
  });

  it('still verifies after legitimate retention pruning', () => {
    // Pruning deletes a PREFIX and re-anchors; the head is untouched.
    const result = pruneForRetention(db, 1, START + 5000 + 3 * 86_400_000);
    expect(result.pruned).toBe(5);
    expect(verifyChain(db)).toMatchObject({ valid: true, count: 0 });

    // …and the chain keeps going from the anchor afterwards.
    recordEvent(db, { actor: 'u6', action: 'invoice.issued', resource: 'invoice/6' }, START + 9000);
    expect(verifyChain(db)).toMatchObject({ valid: true, count: 1 });
  });

  it('reports the verdict through GET /api/verify', async () => {
    const app: Express = createApp({ db, auth });
    const token = (await request(app).post('/api/login').send({ username: 'admin', password: 'test-pass' })).body
      .token as string;
    const before = await request(app).get('/api/verify').set({ Authorization: `Bearer ${token}` });
    expect(before.body.valid).toBe(true);

    db.prepare('DELETE FROM audit_events WHERE id >= 4').run();
    const after = await request(app).get('/api/verify').set({ Authorization: `Bearer ${token}` });
    expect(after.body).toMatchObject({ valid: false, broken_kind: 'truncated' });
  });
});
