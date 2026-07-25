import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/http.js';
import { ServiceError, ServiceUnavailableError } from '../src/http.js';
import {
  backoffDelayMs,
  CircuitBreaker,
  DEFAULT_RETRY,
  isIdempotentMethod,
  isRetriableStatus,
  newRequestId,
} from '../src/resilience.js';
import { WorkflowClient } from '../src/index.js';

// A concrete client just to exercise BaseClient's request loop.
function client(fetch: FetchLike, extra: Record<string, unknown> = {}): WorkflowClient {
  return new WorkflowClient({
    baseUrl: 'http://wf:4002',
    serviceToken: 's',
    fetch,
    // Deterministic + instant: no jitter, no real sleeping, fixed clock.
    rand: () => 0,
    sleep: async () => {},
    now: () => 0,
    ...extra,
  });
}

/** A fetch that returns the queued responses in order (status or thrown error). */
function scripted(steps: Array<{ status?: number; body?: unknown; throw?: string }>): {
  fetch: FetchLike;
  count: () => number;
  headersOf: (i: number) => Record<string, string> | undefined;
} {
  const calls: Array<Record<string, string> | undefined> = [];
  let i = 0;
  const fetch: FetchLike = async (_url, init) => {
    calls.push(init?.headers);
    const step = steps[Math.min(i, steps.length - 1)]!;
    i += 1;
    if (step.throw) throw new Error(step.throw);
    const status = step.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(step.body ?? {}),
    };
  };
  return { fetch, count: () => i, headersOf: (n) => calls[n] };
}

describe('backoff', () => {
  it('grows exponentially and caps at maxDelayMs', () => {
    const p = { ...DEFAULT_RETRY, jitter: false, baseDelayMs: 100, factor: 2, maxDelayMs: 1000 };
    expect(backoffDelayMs(1, p)).toBe(100);
    expect(backoffDelayMs(2, p)).toBe(200);
    expect(backoffDelayMs(3, p)).toBe(400);
    expect(backoffDelayMs(10, p)).toBe(1000); // capped
  });

  it('jitters into the [50%, 100%] band', () => {
    const p = { ...DEFAULT_RETRY, jitter: true, baseDelayMs: 100, factor: 2, maxDelayMs: 1000 };
    expect(backoffDelayMs(2, p, () => 0)).toBe(100); // 50% of 200
    expect(backoffDelayMs(2, p, () => 1)).toBe(200); // 100% of 200
  });
});

describe('retriable classification', () => {
  it('treats gateway/overload statuses as retriable and 4xx as terminal', () => {
    expect([429, 502, 503, 504].every(isRetriableStatus)).toBe(true);
    expect([400, 401, 404, 409, 422, 500].some(isRetriableStatus)).toBe(false);
  });
  it('marks reads and PUT/DELETE idempotent but not POST/PATCH', () => {
    expect(['GET', 'HEAD', 'PUT', 'DELETE'].every(isIdempotentMethod)).toBe(true);
    expect(isIdempotentMethod('POST')).toBe(false);
    expect(isIdempotentMethod('PATCH')).toBe(false);
  });
});

describe('CircuitBreaker', () => {
  it('opens after the threshold and half-opens after cooldown', () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100 }, () => t);
    expect(b.state()).toBe('closed');
    b.onFailure();
    expect(b.canRequest()).toBe(true);
    b.onFailure();
    expect(b.state()).toBe('open');
    expect(b.canRequest()).toBe(false);
    t = 100;
    expect(b.state()).toBe('half-open');
    expect(b.canRequest()).toBe(true);
    b.onSuccess();
    expect(b.state()).toBe('closed');
  });
});

describe('newRequestId', () => {
  it('produces a non-empty unique-ish id', () => {
    expect(newRequestId()).not.toBe(newRequestId());
    expect(newRequestId().length).toBeGreaterThan(7);
  });
});

describe('BaseClient request loop', () => {
  it('propagates a correlation id as X-Request-Id', async () => {
    const s = scripted([{ status: 200 }]);
    await client(s.fetch, { requestId: 'corr-123' }).emit({ type: 't', payload: {} });
    expect(s.headersOf(0)!['X-Request-Id']).toBe('corr-123');
  });

  it('retries a GET on 503 then succeeds', async () => {
    const s = scripted([{ status: 503 }, { status: 200, body: { instance: { id: 1 } } }]);
    const out = await client(s.fetch).getInstance(1);
    expect(s.count()).toBe(2);
    expect(out).toEqual({ instance: { id: 1 } });
  });

  it('does NOT retry a POST without an idempotency key', async () => {
    const s = scripted([{ status: 503, body: { error: 'busy' } }]);
    await expect(client(s.fetch).emit({ type: 't', payload: {} })).rejects.toBeInstanceOf(ServiceError);
    expect(s.count()).toBe(1);
  });

  it('DOES retry a POST when an idempotency key makes it safe, and sends the header', async () => {
    const s = scripted([{ status: 503 }, { status: 200, body: { accepted: true } }]);
    await client(s.fetch).emit({ type: 't', payload: {} }, { idempotencyKey: 'idem-1' });
    expect(s.count()).toBe(2);
    expect(s.headersOf(0)!['Idempotency-Key']).toBe('idem-1');
  });

  it('surfaces a transport failure as ServiceUnavailableError after exhausting retries', async () => {
    const s = scripted([{ throw: 'ECONNREFUSED' }]);
    const err = await client(s.fetch).getInstance(1).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err.status).toBe(503);
    expect(s.count()).toBe(1 + DEFAULT_RETRY.retries);
  });

  it('opens the breaker and fails fast once a peer is down', async () => {
    // Every call throws; threshold 2 with no cooldown reset.
    const s = scripted([{ throw: 'down' }]);
    const c = client(s.fetch, { breaker: { failureThreshold: 2, cooldownMs: 1_000 }, retry: false });
    await c.getInstance(1).catch(() => {});
    await c.getInstance(2).catch(() => {});
    const before = s.count();
    const err = await c.getInstance(3).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err.message).toMatch(/circuit is open/);
    expect(s.count()).toBe(before); // fast-failed without calling fetch
  });

  it('a 4xx does not trip the breaker (peer is healthy, request was rejected)', async () => {
    const s = scripted([{ status: 422, body: { error: 'bad' } }]);
    const c = client(s.fetch, { breaker: { failureThreshold: 1, cooldownMs: 1_000 } });
    await c.getInstance(1).catch(() => {});
    // Breaker still closed: a second call reaches fetch.
    await c.getInstance(2).catch(() => {});
    expect(s.count()).toBe(2);
  });
});
