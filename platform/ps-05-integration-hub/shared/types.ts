/**
 * PS-05 Integration Hub — wire contract. Note that a Connection NEVER
 * carries credential material: the stored ciphertext is redacted on every
 * read.
 */

export const CONNECTION_STATUSES = ['connected', 'disconnected', 'error'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const SYNC_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export function isConnectionStatus(v: string): v is ConnectionStatus {
  return (CONNECTION_STATUSES as readonly string[]).includes(v);
}

export interface ProviderInfo {
  key: string;
  name: string;
  auth_type: string;
}

/** A connection as returned over the API — credentials are always omitted. */
export interface Connection {
  id: number;
  provider: string;
  name: string;
  status: ConnectionStatus;
  scopes: string;
  external_account: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookEvent {
  id: number;
  provider: string;
  connection_id: number | null;
  event_type: string | null;
  signature_valid: boolean;
  status: string;
  received_at: string;
  processed_at: string | null;
}

export interface SyncJob {
  id: number;
  connection_id: number;
  kind: string;
  status: SyncStatus;
  cursor: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProxyRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface FieldError {
  field: string;
  message: string;
}
