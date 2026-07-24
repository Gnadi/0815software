import { BaseClient } from './http.js';
/** Client for PS-06 File / Object Storage (default port 4006). */
export class FilesClient extends BaseClient {
    createBucket(name) {
        return this.apiPost('/api/buckets', { name });
    }
    /** Store an object. `content` is any Buffer/Uint8Array or a base64 string. */
    put(bucket, key, content, opts) {
        const content_base64 = typeof content === 'string' ? content : Buffer.from(content).toString('base64');
        const input = { bucket, key, content_base64, ...opts };
        return this.request('PUT', `/api/objects/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`, input);
    }
    /** Fetch object bytes (returned base64-encoded alongside its metadata). */
    get(bucket, key) {
        return this.request('GET', `/api/objects/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`);
    }
    stat(bucket, key) {
        return this.request('GET', `/api/objects/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}/meta`);
    }
    /** Mint an HMAC-signed, time-limited download URL. */
    signUrl(bucket, key, ttlSeconds) {
        return this.apiPost(`/api/objects/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}/sign`, { ttl_seconds: ttlSeconds });
    }
    remove(bucket, key) {
        return this.apiDelete(`/api/objects/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`);
    }
}
