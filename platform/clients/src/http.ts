/**
 * Shared HTTP plumbing for every Platform Service client.
 *
 * Design goals mirror the services themselves: zero runtime dependencies
 * (built-in `fetch` only), and a `fetch` seam that tests inject so no client
 * test ever touches the network.
 *
 * On top of raw transport this layer provides the cross-cutting reliability
 * every service-to-service call needs, so no individual client (or module)
 * re-implements it:
 *
 *   - a per-request timeout (a slow peer can never hang the caller);
 *   - retry with exponential backoff + jitter on transient failures;
 *   - a circuit breaker that fails fast while a peer is clearly down;
 *   - correlation-id propagation (`X-Request-Id`) across every hop;
 *   - optional idempotency keys (`Idempotency-Key`) so retried writes dedupe.
 *
 * All of it is backward compatible: the defaults change no existing call's
 * success path, and every knob can be overridden per client or per request.
 */

import {
  backoffDelayMs,
  CircuitBreaker,
  DEFAULT_BREAKER,
  DEFAULT_RETRY,
  isIdempotentMethod,
  isRetriableStatus,
  newRequestId,
  type BreakerPolicy,
  type RetryPolicy,
} from './resilience.js';

/** The subset of the global `fetch` surface the clients rely on. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    /** Abort signal used to enforce per-request timeouts (ignored by test fetches). */
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json?: () => Promise<unknown>;
}>;

export interface ClientOptions {
  /** Base URL of the service, e.g. `http://localhost:4002`. No trailing slash required. */
  baseUrl: string;
  /** Shared machine secret presented as `X-Service-Token`. */
  serviceToken?: string;
  /**
   * A PS-01 session token to forward as `Authorization: Bearer` — the
   * identity-propagation path. Set this to act as an end user; omit it for
   * pure machine-to-machine calls.
   */
  identityToken?: string;
  /** Injectable fetch. Defaults to the global `fetch`. */
  fetch?: FetchLike;

  /**
   * Per-request timeout in milliseconds. A call that has not produced a
   * response by then is aborted and (if the method allows) retried.
   * Defaults to 10 s; set 0 to disable.
   */
  timeoutMs?: number;
  /** Retry policy for transient failures. Pass `false` to disable retrying. */
  retry?: Partial<RetryPolicy> | false;
  /** Circuit-breaker policy. Pass `false` to disable the breaker. */
  breaker?: Partial<BreakerPolicy> | false;
  /**
   * Ambient correlation id (or a factory) propagated as `X-Request-Id` on
   * every call this client makes, tying downstream logs back to the
   * originating request. Defaults to a fresh id per request.
   */
  requestId?: string | (() => string);

  // --- test seams (never needed in production) ---
  /** Injectable clock for the breaker. */
  now?: () => number;
  /** Injectable randomness for jitter. */
  rand?: () => number;
  /** Injectable sleep between retries (defaults to a real timer). */
  sleep?: (ms: number) => Promise<void>;
}

/** Per-call overrides layered on top of the client-wide options. */
export interface RequestOptions {
  /** Dedupe key sent as `Idempotency-Key`; also makes a write retry-safe. */
  idempotencyKey?: string;
  /** Correlation id for this call, overriding the client-wide one. */
  requestId?: string;
  /** Timeout override for this call. */
  timeoutMs?: number;
  /** Extra headers merged onto the request. */
  headers?: Record<string, string>;
}

/** Thrown when a service responds with a non-2xx status. */
export class ServiceError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** Correlation id of the failed request, for cross-service log lookup. */
  readonly requestId?: string;
  constructor(status: number, message: string, body: unknown, requestId?: string) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.body = body;
    this.requestId = requestId;
  }
}

/**
 * Raised when a downstream service is unreachable, times out, or its circuit
 * breaker is open. Distinct from `ServiceError` (which means the service
 * answered) so callers can degrade gracefully — show a "temporarily
 * unavailable" state — instead of treating it like a domain rejection.
 * Carries `status = 503` so HTTP-shaped call sites can pass it straight
 * through.
 */
export class ServiceUnavailableError extends ServiceError {
  constructor(message: string, requestId?: string, readonly cause?: unknown) {
    super(503, message, undefined, requestId);
    this.name = 'ServiceUnavailableError';
  }
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function resolveRetry(opt: ClientOptions['retry']): RetryPolicy {
  if (opt === false) return { ...DEFAULT_RETRY, retries: 0 };
  return { ...DEFAULT_RETRY, ...(opt ?? {}) };
}

/**
 * Base class shared by every service client: builds headers, issues the
 * request through the injected fetch, and applies timeout, retry, circuit
 * breaking and correlation-id propagation uniformly.
 */
export abstract class BaseClient {
  protected readonly baseUrl: string;
  protected readonly serviceToken?: string;
  protected readonly identityToken?: string;
  private readonly doFetch: FetchLike;

  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly breaker: CircuitBreaker | null;
  private readonly ambientRequestId: (() => string) | undefined;
  private readonly rand: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.serviceToken = opts.serviceToken;
    this.identityToken = opts.identityToken;
    const injected = opts.fetch;
    if (injected) {
      this.doFetch = injected;
    } else if (typeof fetch === 'function') {
      this.doFetch = fetch as unknown as FetchLike;
    } else {
      throw new Error('No fetch implementation available; pass one via ClientOptions.fetch');
    }

    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retry = resolveRetry(opts.retry);
    this.breaker =
      opts.breaker === false
        ? null
        : new CircuitBreaker({ ...DEFAULT_BREAKER, ...(opts.breaker ?? {}) }, opts.now);
    this.ambientRequestId =
      typeof opts.requestId === 'function'
        ? opts.requestId
        : opts.requestId !== undefined
          ? () => opts.requestId as string
          : undefined;
    this.rand = opts.rand ?? Math.random;
    this.sleep = opts.sleep ?? realSleep;
  }

  protected headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.serviceToken) h['X-Service-Token'] = this.serviceToken;
    if (this.identityToken) h['Authorization'] = `Bearer ${this.identityToken}`;
    return h;
  }

  /** Run one fetch, enforcing the timeout with an abort + a racing rejection. */
  private async fetchOnce(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    timeoutMs: number,
  ): Promise<Awaited<ReturnType<FetchLike>>> {
    if (!timeoutMs || timeoutMs <= 0) return this.doFetch(url, init);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await Promise.race([
        this.doFetch(url, { ...init, signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () =>
            reject(new Error(`request timed out after ${timeoutMs}ms`)),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  protected async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    options?: RequestOptions,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const requestId = options?.requestId ?? this.ambientRequestId?.() ?? newRequestId();
    const idempotencyKey = options?.idempotencyKey;
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;

    const headers = this.headers({
      'X-Request-Id': requestId,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...extraHeaders,
      ...options?.headers,
    });
    const init = {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    };

    // A write is only safe to replay when the server can dedupe it.
    const canRetry = isIdempotentMethod(method) || idempotencyKey !== undefined;
    const maxAttempts = 1 + (canRetry ? this.retry.retries : 0);

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.breaker && !this.breaker.canRequest()) {
        throw new ServiceUnavailableError(
          `${method} ${path}: ${this.baseUrl} circuit is open`,
          requestId,
        );
      }

      let res: Awaited<ReturnType<FetchLike>> | undefined;
      try {
        res = await this.fetchOnce(url, init, timeoutMs);
      } catch (err) {
        // Transport error or timeout: the peer never answered.
        this.breaker?.onFailure();
        lastError = err;
        if (attempt < maxAttempts) {
          await this.sleep(backoffDelayMs(attempt, this.retry, this.rand));
          continue;
        }
        throw new ServiceUnavailableError(
          `${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
          requestId,
          err,
        );
      }

      if (res.ok) {
        this.breaker?.onSuccess();
        return this.parseBody<T>(res);
      }

      // The service answered with an error. 5xx counts against the breaker;
      // 4xx means the peer is healthy and simply rejected this request.
      if (res.status >= 500) this.breaker?.onFailure();
      else this.breaker?.onSuccess();

      if (isRetriableStatus(res.status) && attempt < maxAttempts) {
        await this.sleep(backoffDelayMs(attempt, this.retry, this.rand));
        continue;
      }

      throw await this.toServiceError(res, method, path, requestId);
    }

    // Unreachable: the loop either returns or throws. Guards the type checker.
    throw new ServiceUnavailableError(`${method} ${path} exhausted retries`, requestId, lastError);
  }

  private async parseBody<T>(res: Awaited<ReturnType<FetchLike>>): Promise<T> {
    const raw = await res.text();
    if (raw.length === 0) return undefined as T;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }

  private async toServiceError(
    res: Awaited<ReturnType<FetchLike>>,
    method: string,
    path: string,
    requestId: string,
  ): Promise<ServiceError> {
    const raw = await res.text();
    let parsed: unknown = undefined;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }
    const message =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `${method} ${path} failed with ${res.status}`;
    return new ServiceError(res.status, message, parsed, requestId);
  }

  protected apiGet<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, undefined, options);
  }
  protected apiPost<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, undefined, options);
  }
  protected apiPatch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, body, undefined, options);
  }
  protected apiPut<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, body, undefined, options);
  }
  protected apiDelete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, undefined, undefined, options);
  }
}
