import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { hashPassword, verifyPassword, type SessionConfig } from '../server/auth.js';

/**
 * PS-01 is the service every module and every other service authenticates
 * through, so anything that blocks its event loop stops the whole platform,
 * not just the request that caused it.
 *
 * Password hashing is the one deliberately expensive thing it does (~90ms of
 * scrypt per call, tuned to be slow). It used to run through `scryptSync`,
 * on the loop: 30 concurrent login attempts — a password spray spread across
 * different accounts, which the per-account throttle intentionally does not
 * delay — queued behind each other and pushed `/api/tokens/verify`, the call
 * every service makes to authorize every request, from 2ms to 854ms.
 *
 * These tests fail if the synchronous variant ever comes back.
 */

const session: SessionConfig = { secret: 'test-secret', ttlHours: 12, secureCookie: false };

let server: Server;
let port: number;
let db: Database.Database;

beforeAll(async () => {
  db = openDb(':memory:');
  await seed(db);
  // No `hardening`: the per-IP login limiter would answer 429 long before the
  // interesting part of this test, and it is covered in api.test.ts. What
  // matters here is where the work runs, not whether it is rate limited.
  server = createApp({ db, session }).listen(0);
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
  db.close();
});

/**
 * Peak delay a 10ms interval actually experienced while `work` ran.
 *
 * `work` is a thunk, not a promise, and is invoked only once the timer is
 * armed AND the loop has turned once. A synchronous implementation does all
 * its blocking during the call itself, so a promise handed in already-resolved
 * would hide exactly the stall this measures.
 */
async function maxTimerLagDuring(work: () => Promise<unknown>): Promise<number> {
  const period = 10;
  let last = Date.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last - period);
    last = now;
  }, period);
  try {
    await new Promise((r) => setTimeout(r, period * 2));
    last = Date.now();
    await work();
    // Let the loop turn before disarming: a synchronous implementation
    // finishes its blocking inside `work()`, and the timer it delayed only
    // gets to run — and record how late it is — on the next tick. Clearing
    // the interval straight after the await (a microtask) would beat it.
    await new Promise((r) => setTimeout(r, period * 2));
  } finally {
    clearInterval(timer);
  }
  return worst;
}

/** One raw request on its own socket (undici pools one connection per origin). */
function raw(path: string, payload?: unknown): Promise<{ status: number; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const body = payload === undefined ? null : JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: body ? 'POST' : 'GET',
        agent: new http.Agent({ keepAlive: false }),
        headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, ms: Date.now() - started }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('password hashing stays off the event loop', () => {
  it('hashing passwords does not stall timers', async () => {
    // Warm up: the first call pays module init, not hashing.
    await hashPassword('warm-up-password');
    const lag = await maxTimerLagDuring(() =>
      Promise.all(Array.from({ length: 8 }, (_, i) => hashPassword(`password-${i}`))),
    );
    // Eight hashes: on the loop that is eight blocking scrypts back to back,
    // several hundred ms during which nothing else in the process runs. On the
    // threadpool the loop keeps turning throughout. The bar sits far above the
    // jitter of a busy CI runner and far below even one serialized hash.
    expect(lag, `a 10ms timer slipped ${lag}ms while 8 passwords were hashed`).toBeLessThan(50);
  });

  it('verifies several passwords concurrently rather than one after another', async () => {
    const stored = await hashPassword('a-password');

    // Both arms do the SAME four hashes, back to back, so whatever else the
    // machine is doing hits them equally and cancels out of the ratio.
    //
    // The earlier shape compared the batch against a single warm-up hash, and
    // that denominator was the whole problem: one sample landing in a quiet
    // window (39ms, where a loaded runner's typical is ~90ms) made a perfectly
    // parallel batch look 3x too slow. It failed CI roughly one run in seven
    // under load while the implementation was entirely correct.
    const attempts = 4;
    let started = Date.now();
    for (let i = 0; i < attempts; i++) await verifyPassword('a-password', stored);
    const serial = Date.now() - started;

    started = Date.now();
    await Promise.all(Array.from({ length: attempts }, () => verifyPassword('a-password', stored)));
    const concurrent = Date.now() - started;

    // libuv's threadpool is 4 threads by default, so four hashes overlap and
    // the batch costs about one. On the event loop they cannot overlap at all,
    // and the two arms come out equal — measured at 0.98–1.02 with `scryptSync`
    // restored, against 0.25–0.46 for the async form even with every core
    // saturated. The bar sits in the wide gap between those.
    const ratio = concurrent / serial;
    expect(
      ratio,
      `4 verifications took ${concurrent}ms concurrently vs ${serial}ms serially (${ratio.toFixed(2)}) —` +
        ' a ratio near 1 means they did not overlap, so the hashing is back on the event loop',
    ).toBeLessThan(0.7);
  });

  it('keeps answering /api/tokens/verify while logins are being processed', async () => {
    // A spray: every guess hits a DIFFERENT account, so the per-account
    // backoff never engages and each one costs a full scrypt.
    const spray = Array.from({ length: 30 }, (_, i) =>
      raw('/api/login', { org_slug: 'acme', email: `victim${i}@acme.test`, password: 'guess' }),
    );
    // Give them a moment to actually arrive before measuring.
    await new Promise((r) => setTimeout(r, 50));
    const verify = await raw('/api/tokens/verify', { token: 'not-a-real-token' });
    await Promise.all(spray);

    expect(verify.status).toBe(200);
    // Measured at 854ms with scryptSync, 5ms with the async form.
    expect(
      verify.ms,
      `/api/tokens/verify took ${verify.ms}ms while 30 logins were in flight — the loop is blocked`,
    ).toBeLessThan(250);
  });
});
