import { BaseClient } from './http.js';
import type { IntegrationConnection, MailFetchResult, MailboxProbeResult, ProxyInput, SyncJob } from './types.js';

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

  /** The mailbox connections (provider `imap`), redacted — what a module picks its mailbox from. */
  listMailboxes(): Promise<{ connections: IntegrationConnection[] }> {
    return this.apiGet('/api/connections?provider=imap');
  }

  /** Log in to a mailbox connection and count what is unread — the "test connection" button. */
  probeMailbox(connectionId: number): Promise<MailboxProbeResult> {
    return this.apiPost(`/api/connections/${encodeURIComponent(String(connectionId))}/mail/probe`, {});
  }

  /** The oldest unread messages, parsed. Nothing is marked read until `ackMail`. */
  fetchMail(connectionId: number, opts: { limit?: number } = {}): Promise<MailFetchResult> {
    return this.apiPost(`/api/connections/${encodeURIComponent(String(connectionId))}/mail/fetch`, opts);
  }

  /** Mark fetched messages read, once they are stored. 409 when the folder changed since the fetch. */
  ackMail(connectionId: number, uidvalidity: number, uids: number[]): Promise<{ acknowledged: number }> {
    return this.apiPost(`/api/connections/${encodeURIComponent(String(connectionId))}/mail/ack`, { uidvalidity, uids });
  }

  /** Enqueue a sync job; the worker pulls on the hub's tick. */
  sync(connectionId: number, kind: string): Promise<{ sync_job: SyncJob }> {
    return this.apiPost(`/api/connections/${encodeURIComponent(String(connectionId))}/sync`, { kind });
  }
}
