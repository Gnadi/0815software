import { BaseClient } from './http.js';
import type { ProxyInput, SyncJob } from './types.js';

/** Client for PS-05 Integration Hub (default port 4005). */
export class IntegrationClient extends BaseClient {
  listConnections(): Promise<{ connections: unknown[] }> {
    return this.apiGet('/api/connections');
  }

  /** Issue a REST call through a stored connection; credentials never leave the hub. */
  proxy(connectionId: number, input: ProxyInput): Promise<{ status: number; body: unknown }> {
    return this.apiPost(`/api/connections/${encodeURIComponent(String(connectionId))}/proxy`, input);
  }

  graphql(connectionId: number, query: string, variables?: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    return this.apiPost(`/api/connections/${encodeURIComponent(String(connectionId))}/graphql`, { query, variables });
  }

  /** Enqueue a sync job; the worker pulls on the hub's tick. */
  sync(connectionId: number, kind: string): Promise<{ sync_job: SyncJob }> {
    return this.apiPost(`/api/connections/${encodeURIComponent(String(connectionId))}/sync`, { kind });
  }
}
