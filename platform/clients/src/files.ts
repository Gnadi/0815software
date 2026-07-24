import { BaseClient } from './http.js';
import type { ObjectInfo, PutObjectInput } from './types.js';

/** Client for PS-06 File / Object Storage (default port 4006). */
export class FilesClient extends BaseClient {
  createBucket(name: string): Promise<{ name: string; created_at: string }> {
    return this.apiPost('/api/buckets', { name });
  }

  /** Store an object. `content` is any Buffer/Uint8Array or a base64 string. */
  put(bucket: string, key: string, content: Uint8Array | string, opts?: { content_type?: string; metadata?: Record<string, string> }): Promise<ObjectInfo> {
    const content_base64 = typeof content === 'string' ? content : Buffer.from(content).toString('base64');
    const input: PutObjectInput = { bucket, key, content_base64, ...opts };
    return this.request<ObjectInfo>('PUT', `/api/objects/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`, input);
  }

  /** Fetch object bytes (returned base64-encoded alongside its metadata). */
  get(bucket: string, key: string): Promise<ObjectInfo & { content_base64: string }> {
    return this.request('GET', `/api/objects/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`);
  }

  stat(bucket: string, key: string): Promise<ObjectInfo> {
    return this.request('GET', `/api/objects/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}/meta`);
  }

  /** Mint an HMAC-signed, time-limited download URL. */
  signUrl(bucket: string, key: string, ttlSeconds?: number): Promise<{ url: string; expires_at: string }> {
    return this.apiPost(`/api/objects/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}/sign`, { ttl_seconds: ttlSeconds });
  }

  remove(bucket: string, key: string): Promise<{ deleted: boolean }> {
    return this.apiDelete(`/api/objects/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`);
  }
}
