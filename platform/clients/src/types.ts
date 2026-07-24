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
export interface WorkflowInstance {
  id: string;
  workflow_key: string;
  status: string;
  current_step: string;
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
  top_k?: number;
}

// ── PS-05 Integration Hub ──────────────────────────────────────────────
export interface ProxyInput {
  method?: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
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
}
export interface AuditEvent extends AuditEventInput {
  id: number;
  hash: string;
  prev_hash: string | null;
  recorded_at: string;
}
