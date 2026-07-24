/**
 * Shared HTTP plumbing for every Platform Service client.
 *
 * Design goals mirror the services themselves: zero runtime dependencies
 * (built-in `fetch` only), and a `fetch` seam that tests inject so no client
 * test ever touches the network.
 */
/** The subset of the global `fetch` surface the clients rely on. */
export type FetchLike = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}) => Promise<{
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
export declare class ServiceError extends Error {
    readonly status: number;
    readonly body: unknown;
    constructor(status: number, message: string, body: unknown);
}
/**
 * Base class shared by every service client: builds headers, issues the
 * request through the injected fetch, and normalizes error handling.
 */
export declare abstract class BaseClient {
    protected readonly baseUrl: string;
    protected readonly serviceToken?: string;
    protected readonly identityToken?: string;
    private readonly doFetch;
    constructor(opts: ClientOptions);
    protected headers(extra?: Record<string, string>): Record<string, string>;
    protected request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T>;
    protected apiGet<T>(path: string): Promise<T>;
    protected apiPost<T>(path: string, body?: unknown): Promise<T>;
    protected apiPatch<T>(path: string, body?: unknown): Promise<T>;
    protected apiPut<T>(path: string, body?: unknown): Promise<T>;
    protected apiDelete<T>(path: string): Promise<T>;
}
