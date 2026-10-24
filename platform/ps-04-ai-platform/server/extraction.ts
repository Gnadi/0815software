import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  EInvoiceSyntax,
  ExtractedFields,
  ExtractedLine,
  ExtractInvoiceRequest,
  FieldConfidence,
  InvoiceExtraction,
  ProviderName,
} from '../shared/types.js';
import { nowIso } from './auth.js';
import { resolveChatProvider, type ChatConfig } from './chat.js';
import { decimalCents, readEInvoice, syntaxOf } from './einvoice-read.js';
import { DomainError } from './errors.js';
import { emptyFields, firstDate, ibanValid, readInvoiceText, type OwnIdentity } from './invoice-text.js';
import { embeddedInvoiceXml, isPdf, pdfStreams, pdfText } from './pdf-read.js';
import { defaultFetch, type FetchLike } from './providers/index.js';
import { parseXml, XmlError } from './xml.js';

/**
 * Reading a supplier invoice into fields a person then checks and saves —
 * the incoming side of what MOD-04 writes as e-invoices.
 *
 * In order of trust, and the first that applies wins:
 *
 *   1. A structured e-invoice — XML, or embedded in a PDF (ZUGFeRD /
 *      Factur-X). Read exactly; no model is ever asked what an XML says.
 *   2. Text — a generated PDF's text layer, or pasted text. Read with
 *      labelled patterns by default (deterministic, offline, like every
 *      other PS-04 capability's default), or by a model when the caller asks
 *      for one by name and it is configured.
 *   3. Pixels — a scan or a photo. Only a vision model reads those
 *      (Anthropic, when keyed). Without one the answer is a refusal that
 *      says so: the default never invents an invoice it cannot see.
 *
 * Nothing here saves a bill. The result is a proposal with a confidence per
 * field and warnings; the module shows it, a person corrects and saves, and
 * the write carries that person's name. The log keeps *that* a document was
 * read and how — its hash, the route taken, which fields came out — never
 * what it said: supplier names, amounts and bank accounts stay in the module
 * that owns the bill (docs/PII-MAP.md).
 */

export interface ExtractionConfig {
  chat: ChatConfig;
  fetchImpl?: FetchLike;
}

const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

interface Read {
  source: InvoiceExtraction['source'];
  syntax: EInvoiceSyntax | null;
  embedded: boolean;
  provider: ProviderName;
  model: string | null;
  fields: ExtractedFields;
  confidence: InvoiceExtraction['confidence'];
  lines: ExtractedLine[];
  warnings: string[];
}

function sniffType(data: Buffer, declared: string | undefined, filename: string | undefined): string {
  if (isPdf(data)) return 'application/pdf';
  if (data[0] === 0x89 && data.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (data.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  const head = data.subarray(0, 200).toString('utf8').replace(/^﻿/, '').trimStart();
  if (head.startsWith('<')) return 'application/xml';
  if (declared && /^text\//.test(declared)) return 'text/plain';
  if (filename && /\.(txt|text)$/i.test(filename)) return 'text/plain';
  // Valid UTF-8 without control bytes is text; anything else we cannot read.
  const text = data.toString('utf8');
  return !text.includes('�') && !/[\x00-\x08\x0e-\x1f]/.test(text) ? 'text/plain' : 'application/octet-stream';
}

function fromEInvoice(xml: string, embedded: boolean): Read | null {
  let root;
  try {
    root = parseXml(xml);
  } catch (err) {
    if (err instanceof XmlError) throw new DomainError(422, `The XML is not well-formed: ${err.message}`);
    throw err;
  }
  const syntax = syntaxOf(root);
  if (!syntax) return null;
  const { fields, lines } = readEInvoice(root, syntax);
  const confidence: Read['confidence'] = {};
  for (const [key, value] of Object.entries(fields)) if (value !== null) confidence[key as keyof ExtractedFields] = 'exact';
  return { source: 'e-invoice', syntax, embedded, provider: 'mock', model: null, fields, confidence, lines, warnings: [] };
}

// ── A model reading the document ────────────────────────────────────────

const FIELD_PROMPT = `You read one supplier invoice and answer with ONE JSON object, nothing else:
{"document_type":"invoice"|"credit_note","supplier_name":string|null,"supplier_vat_id":string|null,
"iban":string|null,"bic":string|null,"invoice_number":string|null,"issue_date":"YYYY-MM-DD"|null,
"due_date":"YYYY-MM-DD"|null,"currency":"EUR"|...|null,"net":"1234.56"|null,"tax":"1234.56"|null,
"gross":"1234.56"|null,"payable":"1234.56"|null,"po_number":string|null,"payment_reference":string|null}
Rules: copy values exactly as printed; amounts as decimal strings with a dot; null when the invoice
does not show a value — never estimate. The supplier is who issued the invoice, not who receives it.`;

function ownHint(own: OwnIdentity): string {
  const parts = [...(own.names ?? []), ...(own.vat_ids ?? []), ...(own.ibans ?? [])].filter(Boolean);
  return parts.length > 0 ? `\nThe RECIPIENT (not the supplier) is: ${parts.join(', ')}.` : '';
}

/** A model's answer, held to the same shapes as everything else. */
export function fieldsFromModel(answer: string): { fields: ExtractedFields; confidence: Read['confidence'] } {
  const json = /\{[\s\S]*\}/.exec(answer)?.[0];
  let raw: Record<string, unknown> = {};
  try {
    raw = json ? (JSON.parse(json) as Record<string, unknown>) : {};
  } catch {
    raw = {};
  }
  const str = (k: string, max = 200) => (typeof raw[k] === 'string' && (raw[k] as string).trim() !== '' ? (raw[k] as string).trim().slice(0, max) : null);
  const money = (k: string) => (typeof raw[k] === 'number' ? decimalCents(String(raw[k])) : decimalCents(str(k)?.replace(/[^\d.-]/g, '') ?? null));
  const date = (k: string) => {
    const v = str(k);
    return v ? firstDate(v) : null;
  };
  const fields: ExtractedFields = {
    ...emptyFields(),
    document_type: raw.document_type === 'credit_note' ? 'credit_note' : 'invoice',
    supplier_name: str('supplier_name'),
    supplier_vat_id: str('supplier_vat_id', 30)?.replace(/\s+/g, '').toUpperCase() ?? null,
    iban: str('iban', 40)?.replace(/\s+/g, '').toUpperCase() ?? null,
    bic: str('bic', 11)?.replace(/\s+/g, '').toUpperCase() ?? null,
    invoice_number: str('invoice_number', 64),
    issue_date: date('issue_date'),
    due_date: date('due_date'),
    currency: str('currency', 3)?.toUpperCase() ?? null,
    net_cents: money('net'),
    tax_cents: money('tax'),
    gross_cents: money('gross'),
    payable_cents: money('payable'),
    po_number: str('po_number', 40),
    payment_reference: str('payment_reference', 140),
  };
  const confidence: Read['confidence'] = {};
  for (const [key, value] of Object.entries(fields)) if (value !== null && key !== 'document_type') confidence[key as keyof ExtractedFields] = 'model';
  return { fields, confidence };
}

async function anthropicVision(cfg: ExtractionConfig, data: Buffer, mediaType: string, own: OwnIdentity): Promise<{ text: string; model: string }> {
  const key = cfg.chat.anthropicApiKey!;
  const model = cfg.chat.anthropicModel;
  const block =
    mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } };
  const res = await (cfg.fetchImpl ?? defaultFetch)('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: FIELD_PROMPT + ownHint(own),
      messages: [{ role: 'user', content: [block, { type: 'text', text: 'Read this invoice.' }] }],
    }),
  });
  if (!res.ok) throw new DomainError(502, `The vision model answered HTTP ${res.status}`);
  const body = (await res.json()) as { content?: { type: string; text?: string }[] };
  return { text: (body.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''), model };
}

// ── Checks every route gets ─────────────────────────────────────────────

function check(read: Read): string[] {
  const f = read.fields;
  const out = [...read.warnings];
  if (f.document_type === 'credit_note' && !out.some((w) => w.includes('credit note'))) {
    out.push('This is a credit note, not an invoice — it is money owed to you');
  }
  if (f.iban && !ibanValid(f.iban)) out.push(`The IBAN ${f.iban} fails its check digits — do not pay to it before comparing with the document`);
  if (f.net_cents !== null && f.tax_cents !== null && f.gross_cents !== null && f.net_cents + f.tax_cents !== f.gross_cents) {
    out.push(`Net ${eur(f.net_cents)} + tax ${eur(f.tax_cents)} is not the gross ${eur(f.gross_cents)}`);
  }
  if (f.payable_cents !== null && f.gross_cents !== null && f.payable_cents !== f.gross_cents) {
    out.push(`Only ${eur(f.payable_cents)} of ${eur(f.gross_cents)} is still to pay — something was prepaid or deducted`);
  }
  if (f.currency && f.currency !== 'EUR') out.push(`The invoice is in ${f.currency}, not EUR`);
  if (f.issue_date && f.due_date && f.due_date < f.issue_date) out.push('The due date is before the issue date');
  const missing = (['invoice_number', 'gross_cents', 'due_date'] as const).filter((k) => f[k] === null);
  if (missing.length > 0) out.push(`Not on the document or not readable: ${missing.join(', ')}`);
  return out;
}

const eur = (c: number) => (c / 100).toFixed(2);

// ── The entry point ─────────────────────────────────────────────────────

export async function extractInvoice(db: Database.Database, cfg: ExtractionConfig, req: ExtractInvoiceRequest, now: number): Promise<InvoiceExtraction> {
  const own: OwnIdentity = req.own ?? {};
  let data: Buffer;
  if (typeof req.content_base64 === 'string' && req.content_base64 !== '') {
    if (!/^[A-Za-z0-9+/=\s]+$/.test(req.content_base64)) throw new DomainError(422, 'Validation failed', [{ field: 'content_base64', message: 'is not base64' }]);
    data = Buffer.from(req.content_base64, 'base64');
  } else if (typeof req.text === 'string' && req.text.trim() !== '') {
    data = Buffer.from(req.text, 'utf8');
  } else {
    throw new DomainError(422, 'Validation failed', [{ field: 'content_base64', message: 'Send the document (content_base64) or its text (text)' }]);
  }
  if (data.length === 0) throw new DomainError(422, 'The document is empty');
  if (data.length > MAX_BYTES) throw new DomainError(413, `The document is larger than ${MAX_BYTES / 1024 / 1024} MB`);

  const type = typeof req.text === 'string' && !req.content_base64 ? 'text/plain' : sniffType(data, req.content_type, req.filename);
  const wanted = req.provider && req.provider !== 'mock' ? req.provider : null;
  const chosen = wanted ? resolveChatProvider(wanted, cfg.chat) : null;
  // An unconfigured vendor falls back to the mock in chat; here that would
  // silently swap a model for patterns, so it is said out loud instead.
  if (wanted && chosen?.provider.name !== wanted) throw new DomainError(422, `The provider ${wanted} is not configured on this AI platform`);

  let read: Read | null = null;
  let text = '';
  if (type === 'application/xml') {
    read = fromEInvoice(data.toString('utf8'), false);
    if (!read) throw new DomainError(422, 'This XML is not an e-invoice (CII, UBL or ebInterface)');
  } else if (type === 'application/pdf') {
    const streams = pdfStreams(data);
    const xml = embeddedInvoiceXml(streams);
    read = xml ? fromEInvoice(xml, true) : null;
    if (!read) text = pdfText(streams);
  } else if (type === 'text/plain') {
    text = data.toString('utf8');
  } else if (!IMAGE_TYPES.has(type)) {
    throw new DomainError(415, 'Send a PDF, an e-invoice XML, text, or a PNG/JPEG image');
  }

  if (!read && text.trim() !== '') {
    if (chosen) {
      const answer = await chosen.provider.chat(
        [
          { role: 'system', content: FIELD_PROMPT + ownHint(own) },
          { role: 'user', content: text.slice(0, 40_000) },
        ],
        chosen.model,
      );
      const { fields, confidence } = fieldsFromModel(answer.text);
      read = { source: 'model', syntax: null, embedded: false, provider: chosen.provider.name, model: chosen.model, fields, confidence, lines: [], warnings: [] };
    } else {
      const found = readInvoiceText(text, own);
      read = { source: 'text', syntax: null, embedded: false, provider: 'mock', model: null, ...found, lines: [] };
    }
  }

  if (!read) {
    // Pixels: a scan, a photo, or a PDF whose text we cannot read.
    const media = type === 'application/pdf' || IMAGE_TYPES.has(type) ? type : null;
    if (!media || chosen?.provider.name !== 'anthropic') {
      throw new DomainError(
        422,
        type === 'application/pdf'
          ? 'This PDF has no readable text layer (a scan?) — reading it takes a vision model: send provider "anthropic" with ANTHROPIC_API_KEY configured'
          : 'Reading an image takes a vision model: send provider "anthropic" with ANTHROPIC_API_KEY configured',
      );
    }
    const answer = await anthropicVision(cfg, data, media, own);
    const { fields, confidence } = fieldsFromModel(answer.text);
    read = { source: 'model', syntax: null, embedded: false, provider: 'anthropic', model: answer.model, fields, confidence, lines: [], warnings: [] };
  }

  const sha = createHash('sha256').update(data).digest('hex');
  const warnings = check(read);
  const found = Object.entries(read.fields)
    .filter(([k, v]) => v !== null && k !== 'document_type')
    .map(([k]) => k);
  db.prepare(
    'INSERT INTO extractions (document_sha256, source, syntax, embedded, provider, model, fields_found, warning_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(sha, read.source, read.syntax, read.embedded ? 1 : 0, read.provider, read.model, found.join(','), warnings.length, nowIso(now));

  return {
    source: read.source,
    syntax: read.syntax,
    embedded: read.embedded,
    provider: read.provider,
    model: read.model,
    fields: read.fields,
    confidence: read.confidence as Partial<Record<keyof ExtractedFields, FieldConfidence>>,
    lines: read.lines,
    warnings,
    document_sha256: sha,
  };
}
