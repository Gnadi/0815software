/**
 * PS-04 AI Platform — wire contract shared between server and client.
 */

export const PROVIDERS = ['mock', 'anthropic', 'openai', 'gemini', 'ollama', 'kimi'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const AI_CAPABILITIES = ['chat', 'embeddings', 'rag', 'agents', 'images', 'speech', 'extraction'] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];

export const CHAT_ROLES = ['system', 'user', 'assistant'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

export function isProvider(v: string): v is ProviderName {
  return (PROVIDERS as readonly string[]).includes(v);
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ChatRequest {
  model?: string;
  provider?: ProviderName;
  messages?: ChatMessage[];
  prompt_key?: string;
  variables?: Record<string, unknown>;
}

export interface ChatResponse {
  id: number;
  provider: ProviderName;
  model: string;
  text: string;
  usage: Usage;
}

export interface EmbeddingResponse {
  model: string;
  dims: number;
  vectors: number[][];
  usage: Usage;
}

export interface Prompt {
  id: number;
  key: string;
  name: string;
  active_version: number;
  versions: number[];
}

export interface PromptVersion {
  version: number;
  template: ChatMessage[];
  notes: string | null;
  created_at: string;
}

export interface RagResult {
  id: number;
  text: string;
  score: number;
}

export interface FieldError {
  field: string;
  message: string;
}

// ── Document extraction ──────────────────────────────────────────────────

/**
 * How sure a field is:
 *   exact    read from a structured e-invoice (XRechnung, ZUGFeRD, UBL, ebInterface)
 *   found    read from the text next to a label that names it
 *   derived  computed from other fields (gross − tax, issue date + payment term)
 *   guess    a pattern without a label (the supplier's name from its legal form)
 *   model    read by a vision/language model — check it against the document
 */
export const FIELD_CONFIDENCES = ['exact', 'found', 'derived', 'guess', 'model'] as const;
export type FieldConfidence = (typeof FIELD_CONFIDENCES)[number];

export const EXTRACTION_SOURCES = ['e-invoice', 'text', 'model'] as const;
export type ExtractionSource = (typeof EXTRACTION_SOURCES)[number];

export type EInvoiceSyntax = 'cii' | 'ubl' | 'ebinterface';

export interface ExtractedFields {
  document_type: 'invoice' | 'credit_note';
  supplier_name: string | null;
  supplier_vat_id: string | null;
  /** Normalized (no spaces, upper case). */
  iban: string | null;
  bic: string | null;
  invoice_number: string | null;
  issue_date: string | null;
  due_date: string | null;
  currency: string | null;
  net_cents: number | null;
  tax_cents: number | null;
  gross_cents: number | null;
  /** What is still to pay — below the gross when something was prepaid. */
  payable_cents: number | null;
  /** The buyer's purchase order (EN 16931 BT-13), not the buyer reference. */
  po_number: string | null;
  payment_reference: string | null;
}

export interface ExtractedLine {
  description: string;
  quantity: number | null;
  unit_code: string | null;
  unit_price_cents: number | null;
  net_cents: number | null;
  vat_rate: number | null;
}

export interface InvoiceExtraction {
  source: ExtractionSource;
  /** The e-invoice syntax, when the source is one. */
  syntax: EInvoiceSyntax | null;
  /** True when the XML came out of a PDF (ZUGFeRD / Factur-X). */
  embedded: boolean;
  provider: ProviderName;
  model: string | null;
  fields: ExtractedFields;
  confidence: Partial<Record<keyof ExtractedFields, FieldConfidence>>;
  lines: ExtractedLine[];
  /** What a person should look at before saving: inconsistent totals, a bad IBAN, a credit note … */
  warnings: string[];
  /** SHA-256 of the document bytes — lets the caller spot the same document twice. */
  document_sha256: string;
}

export interface ExtractInvoiceRequest {
  /** The document, base64 — PDF, XML, plain text, PNG or JPEG. */
  content_base64?: string;
  content_type?: string;
  filename?: string;
  /** Or the invoice's text, pasted. */
  text?: string;
  /** The caller's own identifiers, never taken as the supplier's. */
  own?: { names?: string[]; vat_ids?: string[]; ibans?: string[] };
  /** A model to read what has no structured data: scans, photos, odd layouts. */
  provider?: ProviderName;
}
