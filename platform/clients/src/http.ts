/**
 * Shared HTTP plumbing for every Platform Service client.
 *
 * Design goals mirror the services themselves: zero runtime dependencies
 * (built-in `fetch` only), and a `fetch` seam that tests inject so no client
 * test ever touches the network.
 */

/** The subset of the global `fetch` surface the clients rely on. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    /** Set from the request timeout. Test doubles may ignore it. */
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json?: () => Promise<unknown>;
  /**
   * Only needed by `requestBinary`. Optional so an existing test double stays
   * valid — a double that wants to serve bytes has to provide it, and one that
   * does not gets a clear error rather than a PDF mangled through `text()`.
   */
  arrayBuffer?: () => Promise<ArrayBuffer>;
}>;

/** Default request timeout: a hung service must not hang the caller's request. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Statuses worth retrying: the service is up but cannot answer right now. */
const RETRYABLE_STATUS = new Set([502, 503, 504]);

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
   * Per-request timeout in milliseconds (default 10 000). Without one a
   * service that accepts the connection and then stalls holds the calling
   * module's request open until something else gives up — the module is
   * usually mid-request for a user who is just watching a spinner.
   */
  timeoutMs?: number;
  /**
   * Extra attempts for a **GET** after a timeout, a transport failure or a
   * 502/504/503 (default 1). Only GETs: the client cannot know whether a
   * write carried an idempotency key, so it never replays one on its own.
   */
  retries?: number;
  /** Backoff before a retry, in ms (default 200). */
  retryDelayMs?: number;
}

/** Thrown when a service responds with a non-2xx status. */
export class ServiceError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Base class shared by every service client: builds headers, issues the
 * request through the injected fetch, and normalizes error handling.
 */
export abstract class BaseClient {
  protected readonly baseUrl: string;
  protected readonly serviceToken?: string;
  protected readonly identityToken?: string;
  private readonly doFetch: FetchLike;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.serviceToken = opts.serviceToken;
    this.identityToken = opts.identityToken;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = Math.max(0, opts.retries ?? 1);
    this.retryDelayMs = Math.max(0, opts.retryDelayMs ?? 200);
    const injected = opts.fetch;
    if (injected) {
      this.doFetch = injected;
    } else if (typeof fetch === 'function') {
      this.doFetch = fetch as unknown as FetchLike;
    } else {
      throw new Error('No fetch implementation available; pass one via ClientOptions.fetch');
    }
  }

  protected headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.serviceToken) h['X-Service-Token'] = this.serviceToken;
    if (this.identityToken) h['Authorization'] = `Bearer ${this.identityToken}`;
    return h;
  }

  /** An AbortSignal that fires after the configured timeout, when available. */
  private timeoutSignal(): AbortSignal | undefined {
    if (this.timeoutMs <= 0) return undefined;
    const timeout = (AbortSignal as { timeout?: (ms: number) => AbortSignal }).timeout;
    return typeof timeout === 'function' ? timeout(this.timeoutMs) : undefined;
  }

  protected async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    // A GET may be replayed; anything that writes may not — see `retries`.
    const attempts = method.toUpperCase() === 'GET' ? this.retries + 1 : 1;
    let res: Awaited<ReturnType<FetchLike>> | undefined;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1 && this.retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * (attempt - 1)));
      }
      try {
        res = await this.doFetch(`${this.baseUrl}${path}`, {
          method,
          headers: this.headers(extraHeaders),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: this.timeoutSignal(),
        });
      } catch (err) {
        // A timeout or a refused connection: retryable for a GET, and on the
        // last attempt it surfaces as the transport error it is.
        lastError = err;
        res = undefined;
        continue;
      }
      if (!RETRYABLE_STATUS.has(res.status) || attempt === attempts) break;
    }

    if (!res) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`${method} ${path} failed: ${String(lastError)}`);
    }

    const raw = await res.text();
    let parsed: unknown = undefined;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }

    if (!res.ok) {
      const message =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `${method} ${path} failed with ${res.status}`;
      throw new ServiceError(res.status, message, parsed);
    }

    return parsed as T;
  }

  /**
   * A request whose RESPONSE is bytes rather than JSON.
   *
   * The request body still goes as JSON, so retries, timeouts and the
   * `ServiceError` mapping behave exactly as everywhere else — only the
   * success path differs. Needed where a service returns a file the caller
   * hands straight to a browser or a mail attachment, and where base64 in a
   * JSON envelope (PS-06's idiom for stored blobs) would be a pointless
   * round trip.
   *
   * An error response is still read as JSON, because a failure carries a
   * message, not a file.
   */
  protected async requestBinary(method: string, path: string, body?: unknown): Promise<Uint8Array> {
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: this.timeoutSignal(),
    });
    if (!res.ok) {
      const raw = await res.text();
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* a non-JSON error body is the message itself */
      }
      const message =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `${method} ${path} failed with ${res.status}`;
      throw new ServiceError(res.status, message, parsed);
    }
    if (typeof res.arrayBuffer !== 'function') {
      throw new Error(
        `${method} ${path} returned bytes, but the injected fetch has no arrayBuffer() — reading them through text() would corrupt them`,
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  protected apiGet<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  protected apiPost<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  protected apiPatch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }
  protected apiPut<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }
  protected apiDelete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}
