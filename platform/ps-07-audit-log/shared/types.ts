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
  /**
   * How the chain broke, when it did. `link` is a rewritten or removed event
   * caught by a hash mismatch; `truncated` is a chain that is internally
   * consistent but stops short of the recorded head — events were removed from
   * the END of the log, which no per-row hash can reveal.
   */
  broken_kind?: 'link' | 'truncated';
}
