import { BaseClient } from './http.js';
import type { ProxyInput } from './types.js';
/** Client for PS-05 Integration Hub (default port 4005). */
export declare class IntegrationClient extends BaseClient {
    listConnections(): Promise<unknown[]>;
    /** Issue a REST call through a stored connection; credentials never leave the hub. */
    proxy(connectionId: number, input: ProxyInput): Promise<{
        status: number;
        body: unknown;
    }>;
    graphql(connectionId: number, query: string, variables?: Record<string, unknown>): Promise<{
        status: number;
        body: unknown;
    }>;
    /** Enqueue a sync job; the worker pulls on the hub's tick. */
    sync(connectionId: number, kind: string): Promise<{
        id: number;
        status: string;
    }>;
}
