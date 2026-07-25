/**
 * Outbound resilience (copy-in, dependency-free). Wraps any fetch-like function
 * so transient upstream failures — HTTP 429 and 5xx — are retried with
 * exponential backoff, honoring a numeric `Retry-After` header when the
 * response exposes one. Applied to the real vendor adapters only; injected
 * test fetches are never wrapped, so unit tests stay deterministic.
 */

interface RetryableResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
}
type FetchLikeFn<R extends RetryableResponse> = (url: string, init: never) => Promise<R>;

export interface RetryConfig {
  /** Extra attempts after the first (default 2 → up to 3 calls). */
  retries?: number;
  /** Base backoff, doubled each attempt (default 250ms). */
  baseDelayMs?: number;
  /** Backoff ceiling (default 5000ms). */
  maxDelayMs?: number;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function withRetry<R extends RetryableResponse, F extends FetchLikeFn<R>>(fetchImpl: F, cfg: RetryConfig = {}): F {
  const retries = cfg.retries ?? 2;
  const base = cfg.baseDelayMs ?? 250;
  const max = cfg.maxDelayMs ?? 5000;
  const sleep = cfg.sleep ?? defaultSleep;
  const wrapped = async (url: string, init: never): Promise<R> => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, init);
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt >= retries) return res;
      const retryAfter = res.headers?.get?.('retry-after');
      const wait =
        retryAfter && /^\d+$/.test(retryAfter)
          ? Math.min(max, Number(retryAfter) * 1000)
          : Math.min(max, base * 2 ** attempt);
      await sleep(wait);
    }
  };
  return wrapped as unknown as F;
}
