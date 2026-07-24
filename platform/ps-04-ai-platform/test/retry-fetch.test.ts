import { describe, expect, it } from 'vitest';
import { withRetry } from '../server/retry-fetch.js';

type Res = { ok: boolean; status: number; headers?: { get(n: string): string | null } };

/** A fetch stub that returns a scripted sequence of statuses. */
function scripted(statuses: number[], header?: string) {
  let i = 0;
  const urls: string[] = [];
  const fn = async (url: string): Promise<Res> => {
    urls.push(url);
    const status = statuses[Math.min(i++, statuses.length - 1)]!;
    return {
      ok: status < 400,
      status,
      headers: header ? { get: (n) => (n.toLowerCase() === 'retry-after' ? header : null) } : undefined,
    };
  };
  return { fn, urls };
}

describe('withRetry', () => {
  it('returns immediately on a 2xx (no retry, no sleep)', async () => {
    let slept = 0;
    const { fn, urls } = scripted([200]);
    const res = await withRetry(fn, { sleep: async (ms) => void (slept += ms) })('https://x');
    expect(res.status).toBe(200);
    expect(urls).toHaveLength(1);
    expect(slept).toBe(0);
  });

  it('does not retry a non-transient 4xx', async () => {
    const { fn, urls } = scripted([400]);
    const res = await withRetry(fn, { sleep: async () => {} })('https://x');
    expect(res.status).toBe(400);
    expect(urls).toHaveLength(1);
  });

  it('retries a 503 then succeeds, backing off exponentially', async () => {
    const waits: number[] = [];
    const { fn, urls } = scripted([503, 503, 200]);
    const res = await withRetry(fn, { baseDelayMs: 100, sleep: async (ms) => void waits.push(ms) })('https://x');
    expect(res.status).toBe(200);
    expect(urls).toHaveLength(3);
    expect(waits).toEqual([100, 200]); // 100 * 2**0, 100 * 2**1
  });

  it('gives up after the configured retries and returns the last failure', async () => {
    const { fn, urls } = scripted([429, 429, 429, 429]);
    const res = await withRetry(fn, { retries: 2, sleep: async () => {} })('https://x');
    expect(res.status).toBe(429);
    expect(urls).toHaveLength(3); // first + 2 retries
  });

  it('honors a numeric Retry-After header over the backoff schedule', async () => {
    const waits: number[] = [];
    const { fn } = scripted([429, 200], '2');
    await withRetry(fn, { baseDelayMs: 100, sleep: async (ms) => void waits.push(ms) })('https://x');
    expect(waits).toEqual([2000]); // 2 seconds, not the 100ms backoff
  });
});
