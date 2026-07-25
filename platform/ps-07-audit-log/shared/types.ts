/**
 * PS-07 Audit Log — wire contract shared between server and clients.
 */

export interface FieldError {
  field: string;
  message: string;
}

export interface AuditEventInput {
  actor: string;
  org?: string | null;
  action: string;
  resource: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  /** Optional client-chosen key; replaying the same key returns the original event. */
  idempotency_key?: string | null;
}

export interface AuditEvent {
  id: number;
  actor: string;
  org: string | null;
  action: string;
  resource: string;
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown>;
  hash: string;
  prev_hash: string | null;
  recorded_at: string;
}

export interface ChainVerdict {
  valid: boolean;
  count: number;
  /** The id of the first row whose hash does not match, if any. */
  broken_at?: number;
}
