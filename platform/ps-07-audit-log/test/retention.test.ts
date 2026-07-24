import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { pruneForRetention, verifyChain } from '../server/audit.js';
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
const as = (t: string) => ({ Authorization: `Bearer ${t}` });

let db: Database.Database;
let app: Express;
let clock: number;

const DAY = 86_400_000;

async function token(): Promise<string> {
  return (await request(app).post('/api/login').send({ username: 'admin', password: 'test-pass' })).body.token as string;
}
async function record(action: string): Promise<void> {
  await request(app).post('/api/events').set(svc).send({ actor: 'user:1', action, resource: 'r' }).expect(201);
}

beforeEach(() => {
  db = openDb(':memory:');
  clock = Date.parse('2026-01-01T00:00:00Z');
  app = createApp({ db, auth, now: () => clock });
});

describe('retention with chain integrity', () => {
  it('prunes old events, advances the anchor, and still verifies', async () => {
    // Three events, ten days apart: a@day0, b@day10, c@day20.
    await record('a');
    clock += 10 * DAY;
    await record('b');
    clock += 10 * DAY;
    await record('c');

    // Keep 15 days at day20 → cutoff day5 → only 'a' is old enough to prune.
    const result = pruneForRetention(db, 15, clock);
    expect(result.pruned).toBe(1);
    expect(result.anchor).not.toBeNull();

    // b and c remain, and the surviving chain still verifies from the anchor
    // even though its predecessor ('a') was deleted.
    const verdict = verifyChain(db);
    expect(verdict.valid).toBe(true);
    expect(verdict.count).toBe(2);
  });

  it('exposes rotation over HTTP and keeps /api/verify valid afterwards', async () => {
    await record('x');
    clock += DAY;
    await record('y');
    clock += 30 * DAY;

    const t = await token();
    const rot = await request(app).post('/api/rotate').set(as(t)).send({ retention_days: 1 });
    expect(rot.status).toBe(200);
    expect(rot.body.pruned).toBeGreaterThanOrEqual(1);

    const verify = await request(app).get('/api/verify').set(as(t));
    expect(verify.body.valid).toBe(true);
  });

  it('detects tampering in the surviving segment after a prune', async () => {
    await record('a');
    clock += 10 * DAY;
    await record('b');
    clock += 10 * DAY;
    await record('c');
    pruneForRetention(db, 15, clock); // prunes 'a', keeps b + c

    // Tamper with a surviving event.
    const survivor = db.prepare('SELECT id FROM audit_events ORDER BY id DESC LIMIT 1').get() as { id: number };
    db.prepare("UPDATE audit_events SET action = 'tampered' WHERE id = ?").run(survivor.id);
    expect(verifyChain(db).valid).toBe(false);
  });
});
