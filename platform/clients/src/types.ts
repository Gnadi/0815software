/**
 * Request/response shapes for the Platform Service clients.
 *
 * These are copied (not imported) from each service's `shared/types.ts` so
 * that the services stay standalone packages with no dependency on this one.
 * Kept intentionally minimal — the fields modules actually send and read.
 */

// ── PS-01 Identity ─────────────────────────────────────────────────────
export interface SessionClaims {
  userId: string;
  orgId: string;
  tokenVersion: number;
  expiry: number;
}
export interface TokenVerdict {
  valid: boolean;
  claims?: SessionClaims;
  /** Permissions the verified principal holds (sessions and scoped API keys). */
  permissions?: string[];
}
export interface LoginResult {
  token: string;
  user: { id: string; email: string; org_id: string };
}

// ── PS-02 Workflow Engine ──────────────────────────────────────────────
export interface WorkflowEvent {
  type: string;
  payload?: Record<string, unknown>;
  idempotency_key?: string;
}
export interface RunWorkflowInput {
  input?: Record<string, unknown>;
  idempotency_key?: string;
}
/** Fan-out result of ingesting an event (POST /api/events). */
export interface IngestResult {
  matched: number;
  instance_ids: number[];
  enqueued: number;
}
export interface WorkflowInstance {
  id: number;
  workflow_key: string;
  workflow_version: number;
  idempotency_key: string | null;
  created_at: string;
  current_step: string | null;
  status: string;
}
export interface WorkflowInstanceEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}
export interface WorkflowInstanceDetail extends WorkflowInstance {
  input: Record<string, unknown>;
  events: WorkflowInstanceEvent[];
  allowed_transitions: string[];
}

// ── PS-03 Notification Hub ─────────────────────────────────────────────
export interface SendMessageInput {
  channel: string;
  to: string;
  /** Provide either a template + variables, or a raw subject/body. */
  template_key?: string;
  variables?: Record<string, unknown>;
  subject?: string;
  body?: string;
  idempotency_key?: string;
}
export interface Message {
  id: string;
  channel: string;
  status: string;
}

// ── PS-04 AI Platform ──────────────────────────────────────────────────
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export interface ChatInput {
  messages: ChatMessage[];
  provider?: string;
  model?: string;
  idempotency_key?: string;
}
export interface ChatResult {
  id: number;
  text: string;
  provider: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}
export interface RagSearchInput {
  collection: string;
  query: string;
  /** Number of nearest documents to return (service default 3). */
  k?: number;
}
export interface RagResult {
  id: number;
  text: string;
  score: number;
}
export interface EmbedResult {
  model: string;
  dims: number;
  vectors: number[][];
  usage: { prompt_tokens: number; completion_tokens: number };
}

// ── PS-05 Integration Hub ──────────────────────────────────────────────
export interface ProxyInput {
  method?: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}
export interface SyncJob {
  id: number;
  connection_id: number;
  kind: string;
  status: string;
  records: number;
  created_at: string;
  updated_at: string;
}

// ── PS-06 Files ────────────────────────────────────────────────────────
export interface PutObjectInput {
  bucket: string;
  key: string;
  /** Base64-encoded content. */
  content_base64: string;
  content_type?: string;
  metadata?: Record<string, string>;
}
export interface ObjectInfo {
  bucket: string;
  key: string;
  size: number;
  content_type: string;
  sha256: string;
  metadata: Record<string, string>;
  created_at: string;
}

// ── PS-08 Payments ─────────────────────────────────────────────────────
export interface CreateIntentInput {
  reference: string;
  amount_minor: number;
  currency?: string;
  provider?: 'mock' | string;
  confirm?: boolean;
  idempotency_key?: string;
}
export interface LedgerEntry {
  id: number;
  intent_id: number;
  direction: 'credit' | 'debit';
  amount_minor: number;
  reason: string;
  created_at: string;
}
export interface PaymentIntent {
  id: number;
  public_id: string;
  reference: string;
  provider: string;
  amount_minor: number;
  currency: string;
  status: string;
  amount_refunded_minor: number;
  created_at: string;
  events?: { id: number; type: string; amount_minor: number | null; created_at: string }[];
  ledger?: LedgerEntry[];
}

// ── PS-07 Audit Log ────────────────────────────────────────────────────
export interface AuditEventInput {
  actor: string;
  org?: string;
  action: string;
  resource: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  /** Optional client-chosen key; replaying the same key returns the original event. */
  idempotency_key?: string;
}
export interface AuditEvent extends AuditEventInput {
  id: number;
  hash: string;
  prev_hash: string | null;
  recorded_at: string;
}
