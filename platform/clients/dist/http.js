/**
 * Shared HTTP plumbing for every Platform Service client.
 *
 * Design goals mirror the services themselves: zero runtime dependencies
 * (built-in `fetch` only), and a `fetch` seam that tests inject so no client
 * test ever touches the network.
 */
/** Thrown when a service responds with a non-2xx status. */
export class ServiceError extends Error {
    status;
    body;
    constructor(status, message, body) {
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
export class BaseClient {
    baseUrl;
    serviceToken;
    identityToken;
    doFetch;
    constructor(opts) {
        this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
        this.serviceToken = opts.serviceToken;
        this.identityToken = opts.identityToken;
        const injected = opts.fetch;
        if (injected) {
            this.doFetch = injected;
        }
        else if (typeof fetch === 'function') {
            this.doFetch = fetch;
        }
        else {
            throw new Error('No fetch implementation available; pass one via ClientOptions.fetch');
        }
    }
    headers(extra) {
        const h = { 'Content-Type': 'application/json', ...extra };
        if (this.serviceToken)
            h['X-Service-Token'] = this.serviceToken;
        if (this.identityToken)
            h['Authorization'] = `Bearer ${this.identityToken}`;
        return h;
    }
    async request(method, path, body, extraHeaders) {
        const res = await this.doFetch(`${this.baseUrl}${path}`, {
            method,
            headers: this.headers(extraHeaders),
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const raw = await res.text();
        let parsed = undefined;
        if (raw.length > 0) {
            try {
                parsed = JSON.parse(raw);
            }
            catch {
                parsed = raw;
            }
        }
        if (!res.ok) {
            const message = parsed && typeof parsed === 'object' && 'error' in parsed
                ? String(parsed.error)
                : `${method} ${path} failed with ${res.status}`;
            throw new ServiceError(res.status, message, parsed);
        }
        return parsed;
    }
    apiGet(path) {
        return this.request('GET', path);
    }
    apiPost(path, body) {
        return this.request('POST', path, body);
    }
    apiPatch(path, body) {
        return this.request('PATCH', path, body);
    }
    apiPut(path, body) {
        return this.request('PUT', path, body);
    }
    apiDelete(path) {
        return this.request('DELETE', path);
    }
}
