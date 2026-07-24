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
  }

  protected headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.serviceToken) h['X-Service-Token'] = this.serviceToken;
    if (this.identityToken) h['Authorization'] = `Bearer ${this.identityToken}`;
    return h;
  }

  protected async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(extraHeaders),
      body: body === undefined ? undefined : JSON.stringify(body),
    });

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
