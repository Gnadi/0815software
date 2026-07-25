/**
 * Resilience primitives shared by every Platform Service client.
 *
 * These are the mechanics that make service-to-service calls survive a
 * slow, flaky, or briefly-unavailable peer without crashing the caller:
 *
 *   - retry with exponential backoff + jitter (which failures are safe to
 *     replay, and how long to wait before each attempt);
 *   - a circuit breaker (stop hammering a peer that is clearly down, and
 *     fail fast instead of piling up timeouts).
 *
 * They are deliberately pure and dependency-free so they can be unit
 * tested in isolation and reused unchanged in the browser or Node. Wall
 * clock and randomness are injected so tests stay deterministic.
 */

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  /** Maximum retry attempts after the first try (0 disables retrying). */
  retries: number;
  /** Delay before the first retry, in milliseconds. */
  baseDelayMs: number;
  /** Upper bound on any single backoff delay. */
  maxDelayMs: number;
  /** Exponential growth factor between attempts. */
  factor: number;
  /** Apply full jitter (50–100 % of the computed delay) to avoid thundering herds. */
  jitter: boolean;
}

/**
 * Conservative defaults: two retries, ~100 ms → ~400 ms, capped at 2 s.
 * Enough to ride out a peer restart or a transient blip without turning a
 * request into a multi-second stall.
 */
export const DEFAULT_RETRY: RetryPolicy = {
  retries: 2,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
  factor: 2,
  jitter: true,
};

/**
 * Backoff delay before retry number `attempt` (1-based). Exponential in the
 * attempt number, capped at `maxDelayMs`, then optionally jittered down into
 * the [50 %, 100 %] band so concurrent callers don't retry in lockstep.
 */
export function backoffDelayMs(attempt: number, policy: RetryPolicy, rand: () => number = Math.random): number {
  const exp = policy.baseDelayMs * Math.pow(policy.factor, Math.max(0, attempt - 1));
  const capped = Math.min(policy.maxDelayMs, exp);
  if (!policy.jitter) return Math.round(capped);
  return Math.round(capped * (0.5 + rand() * 0.5));
}

/**
 * HTTP methods whose semantics let us safely replay a request without an
 * idempotency key. Writes (POST/PATCH) are only retried when the caller
 * supplies an idempotency key so the server can dedupe.
 */
export function isIdempotentMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'PUT' || m === 'DELETE' || m === 'OPTIONS';
}

/**
 * Statuses worth retrying: the peer is up but temporarily unable to serve
 * (gateway/overload/maintenance). 4xx other than 429 are the caller's fault
 * and never retried.
 */
export function isRetriableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export interface BreakerPolicy {
  /** Consecutive failures that trip the breaker open. */
  failureThreshold: number;
  /** How long the breaker stays open before allowing a trial request. */
  cooldownMs: number;
}

export const DEFAULT_BREAKER: BreakerPolicy = {
  failureThreshold: 5,
  cooldownMs: 10_000,
};

export type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * A minimal consecutive-failure circuit breaker, one per client instance
 * (i.e. one per downstream service). When a peer racks up
 * `failureThreshold` failures in a row the breaker opens and calls fail
 * fast for `cooldownMs`; the next call after that is allowed through as a
 * trial (half-open) and either closes the breaker (success) or re-opens it
 * (failure). This keeps a caller from stacking up timeouts against a peer
 * that is plainly down.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly policy: BreakerPolicy = DEFAULT_BREAKER,
    private readonly now: () => number = Date.now,
  ) {}

  state(): BreakerState {
    if (this.openedAt === null) return 'closed';
    if (this.now() - this.openedAt >= this.policy.cooldownMs) return 'half-open';
    return 'open';
  }

  /** True when a request may be attempted (closed or half-open). */
  canRequest(): boolean {
    return this.state() !== 'open';
  }

  onSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  onFailure(): void {
    this.failures += 1;
    if (this.failures >= this.policy.failureThreshold) {
      this.openedAt = this.now();
    }
  }
}

// ---------------------------------------------------------------------------
// Correlation / request ids
// ---------------------------------------------------------------------------

/**
 * Generate a correlation id to stamp on an outbound request when the caller
 * has none to propagate. Prefers `crypto.randomUUID` (Node 20+, modern
 * browsers) and degrades to a random hex string so the module keeps its
 * zero-dependency promise everywhere.
 */
export function newRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')).join('');
}
