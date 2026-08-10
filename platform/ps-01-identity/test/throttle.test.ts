import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { delayFor, throttleConfigFromEnv, type ThrottleConfig } from '../server/throttle.js';
import type { SessionConfig } from '../server/auth.js';

/**
 * The per-IP limiter cannot see a password spray: a thousand addresses, each
 * one attempt, all against one account. What this covers is the other axis —
 * guessing at ONE account gets slower no matter where the guesses come from,
 * without ever locking its owner out.
 */

const session: SessionConfig = { secret: 'test-secret', ttlHours: 12, secureCookie: false };
const throttle: ThrottleConfig = { threshold: 3, baseMs: 100, maxMs: 800, windowMs: 60_000 };

let db: Database.Database;
let app: Express;
let slept: number[];
let clock: number;

beforeEach(async () => {
  db = openDb(':memory:');
  await seed(db);
  slept = [];
  clock = Date.parse('2026-06-01T00:00:00Z');
  app = createApp({
    db,
    session,
    throttle,
    now: () => clock,
    sleep: async (ms) => void slept.push(ms),
  });
});

const attempt = (email: string, password: string, org = 'acme') =>
  request(app).post('/api/login').send({ org_slug: org, email, password });

describe('delay schedule', () => {
  it('is free below the threshold and then doubles up to the cap', () => {
    expect(delayFor(0, throttle)).toBe(0);
    expect(delayFor(2, throttle)).toBe(0);
    expect(delayFor(3, throttle)).toBe(100);
    expect(delayFor(4, throttle)).toBe(200);
    expect(delayFor(5, throttle)).toBe(400);
    expect(delayFor(6, throttle)).toBe(800);
    expect(delayFor(99, throttle)).toBe(800); // capped, never Infinity
  });

  it('reads its knobs from the environment, with sane defaults', () => {
    expect(throttleConfigFromEnv({}).threshold).toBe(5);
    expect(throttleConfigFromEnv({ LOGIN_THROTTLE_THRESHOLD: '2', LOGIN_THROTTLE_MAX_MS: '5000' })).toMatchObject({
      threshold: 2,
      maxMs: 5000,
    });
    // Nonsense falls back rather than disabling the brake by accident.
    expect(throttleConfigFromEnv({ LOGIN_THROTTLE_THRESHOLD: 'lots' }).threshold).toBe(5);
  });
});

describe('login backoff', () => {
  it('starts charging only after the threshold', async () => {
    for (let i = 0; i < 3; i++) expect((await attempt('owner@acme.test', 'nope')).status).toBe(401);
    expect(slept).toEqual([]); // the first three were free

    expect((await attempt('owner@acme.test', 'nope')).status).toBe(401);
    expect((await attempt('owner@acme.test', 'nope')).status).toBe(401);
    expect(slept).toEqual([100, 200]);
  });

  it('charges the same for an account that does not exist', async () => {
    for (let i = 0; i < 5; i++) await attempt('ghost@acme.test', 'nope');
    // Identical to the real-account case above: the delay cannot be used to
    // find out which addresses are real.
    expect(slept).toEqual([100, 200]);
  });

  it('never locks anyone out — the right password still works, once', async () => {
    for (let i = 0; i < 5; i++) await attempt('owner@acme.test', 'nope');
    const before = slept.length;

    const ok = await attempt('owner@acme.test', 'demo-owner');
    expect(ok.status).toBe(200);
    expect(slept.length).toBe(before + 1); // paid the wait once

    // …and the record is cleared, so the next login is free again.
    const again = await attempt('owner@acme.test', 'demo-owner');
    expect(again.status).toBe(200);
    expect(slept.length).toBe(before + 1);
  });

  it('forgets failures once the window passes', async () => {
    for (let i = 0; i < 5; i++) await attempt('owner@acme.test', 'nope');
    slept = [];

    clock += throttle.windowMs + 1_000;
    expect((await attempt('owner@acme.test', 'nope')).status).toBe(401);
    expect(slept).toEqual([]);
  });

  it('throttles per account, not across them', async () => {
    for (let i = 0; i < 5; i++) await attempt('owner@acme.test', 'nope');
    slept = [];

    // A different account in the same org is untouched by the first one's
    // failures — otherwise one noisy account would slow down everybody.
    expect((await attempt('admin@acme.test', 'demo-admin')).status).toBe(200);
    expect(slept).toEqual([]);
  });

  it('records the wait on the auth trail', async () => {
    for (let i = 0; i < 4; i++) await attempt('owner@acme.test', 'nope');
    const last = db
      .prepare("SELECT meta FROM auth_events WHERE type = 'login_fail' ORDER BY id DESC LIMIT 1")
      .get() as { meta: string };
    expect(JSON.parse(last.meta).delayed_ms).toBe(100);
  });
});
