import { BaseClient } from './http.js';
import type { ObjectInfo } from './types.js';
/** Client for PS-06 File / Object Storage (default port 4006). */
export declare class FilesClient extends BaseClient {
    createBucket(name: string): Promise<{
        name: string;
        created_at: string;
    }>;
    /** Store an object. `content` is any Buffer/Uint8Array or a base64 string. */
    put(bucket: string, key: string, content: Uint8Array | string, opts?: {
        content_type?: string;
        metadata?: Record<string, string>;
    }): Promise<ObjectInfo>;
    /** Fetch object bytes (returned base64-encoded alongside its metadata). */
    get(bucket: string, key: string): Promise<ObjectInfo & {
        content_base64: string;
    }>;
    stat(bucket: string, key: string): Promise<ObjectInfo>;
    /** Mint an HMAC-signed, time-limited download URL. */
    signUrl(bucket: string, key: string, ttlSeconds?: number): Promise<{
        url: string;
        expires_at: string;
    }>;
    remove(bucket: string, key: string): Promise<{
        deleted: boolean;
    }>;
}
