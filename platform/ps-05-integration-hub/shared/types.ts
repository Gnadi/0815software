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

// ── Mailbox connections (provider `imap`) ──────────────────────────────

export interface MailAddress {
  name: string | null;
  address: string;
}

export interface MailAttachment {
  filename: string;
  content_type: string;
  size: number;
  /** Shown inside the message (an embedded image) rather than attached to it. */
  inline: boolean;
  content_id: string | null;
  content_base64: string;
}

/** One unread message, parsed. Fetching does not mark it read — acknowledge it. */
export interface MailMessage {
  uid: number;
  size: number;
  /** Larger than the per-message limit: headers only, no text, no attachments. */
  body_omitted: boolean;
  /** Without angle brackets — the key a consumer deduplicates on. */
  message_id: string | null;
  from: MailAddress | null;
  reply_to: MailAddress | null;
  to: MailAddress[];
  subject: string;
  date: string | null;
  in_reply_to: string | null;
  references: string[];
  text: string;
  /** Why the message looks machine-sent (auto-reply, bounce, list), or null for a person. */
  automated: string | null;
  attachments: MailAttachment[];
}

export interface MailFetchResult {
  mailbox: string;
  /** UIDs are only valid within this value; pass it back when acknowledging. */
  uidvalidity: number;
  messages: MailMessage[];
  /** Unread messages left for the next fetch. */
  remaining: number;
}

export interface MailboxProbeResult {
  mailbox: string;
  uidvalidity: number;
  exists: number;
  unseen: number;
}
