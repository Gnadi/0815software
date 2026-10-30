import type Database from 'better-sqlite3';
import type { InvoiceExtraction } from '@0815software/platform-clients';
import type { BillProposal, BillReadingSettings, FieldError } from '../shared/types.js';
import { DomainError } from './invoices.js';

/**
 * Reading a supplier invoice into a bill instead of typing it — this
 * module's side of it. PS-04 reads the document (an e-invoice exactly, a
 * printed PDF from its labels, a scan only with a vision model) and answers
 * with fields and how sure it is of each; this file turns that into a
 * proposal for the bill form:
 *
 *   - the creditor it is from — by IBAN, the one identifier a payment
 *     actually goes to, else by name — or the creditor to create;
 *   - the bill's fields, the amount being what is still to pay;
 *   - whether this document, or this supplier's invoice number, was already
 *     entered: a second upload is the cheapest way to pay twice.
 *
 * Nothing is saved here. The person checks the proposal, saves the bill, and
 * the bill records that it was read (`read_from`) and from which document
 * (`document_sha256`), so a later upload of the same file is recognised.
 */

export const READING_PROVIDERS = ['anthropic', 'openai', 'gemini', 'ollama', 'kimi'] as const;

export const DEFAULT_READING_SETTINGS: BillReadingSettings = { model: null };

export function readReadingSettings(db: Database.Database): BillReadingSettings & { updated_at: string | null; updated_by: string | null } {
  const row = db.prepare('SELECT settings, updated_at, updated_by FROM bill_reading_settings WHERE id = 1').get() as
    | { settings: string; updated_at: string; updated_by: string | null }
    | undefined;
  const settings = row ? { ...DEFAULT_READING_SETTINGS, ...(JSON.parse(row.settings) as Partial<BillReadingSettings>) } : { ...DEFAULT_READING_SETTINGS };
  return { ...settings, updated_at: row?.updated_at ?? null, updated_by: row?.updated_by ?? null };
}

export function validateReadingSettings(input: Record<string, unknown>): BillReadingSettings {
  const model = input.model === undefined || input.model === null || input.model === '' ? null : input.model;
  if (model !== null && !(READING_PROVIDERS as readonly unknown[]).includes(model)) {
    const errors: FieldError[] = [{ field: 'model', message: `model is empty (patterns only) or one of: ${READING_PROVIDERS.join(', ')}` }];
    throw new DomainError(422, 'Validation failed', errors);
  }
  return { model: model as BillReadingSettings['model'] };
}

export function writeReadingSettings(db: Database.Database, settings: BillReadingSettings, actor: string): void {
  db.prepare(
    `INSERT INTO bill_reading_settings (id, settings, updated_at, updated_by) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(JSON.stringify(settings), new Date().toISOString(), actor);
}

/** How a bill was read, as stored on it: "e-invoice:cii", "e-invoice:cii:pdf", "text", "model:anthropic". */
export function readFromLabel(x: Pick<InvoiceExtraction, 'source' | 'syntax' | 'embedded' | 'provider'>): string {
  if (x.source === 'e-invoice') return `e-invoice:${x.syntax}${x.embedded ? ':pdf' : ''}`;
  if (x.source === 'model') return `model:${x.provider}`;
  return 'text';
}

const compact = (s: string) => s.replace(/\s+/g, '').toUpperCase();

export function proposeBill(db: Database.Database, x: InvoiceExtraction): BillProposal {
  const f = x.fields;
  let creditor: BillProposal['creditor'] = null;
  if (f.iban) {
    const byIban = db.prepare('SELECT id, name FROM creditors WHERE iban = ?').get(compact(f.iban)) as { id: number; name: string } | undefined;
    if (byIban) creditor = { id: byIban.id, name: byIban.name, matched_by: 'iban' };
  }
  if (!creditor && f.supplier_name) {
    const byName = db.prepare('SELECT id, name, iban FROM creditors WHERE lower(trim(name)) = lower(trim(?))').all(f.supplier_name) as { id: number; name: string; iban: string }[];
    if (byName.length === 1) creditor = { id: byName[0]!.id, name: byName[0]!.name, matched_by: 'name' };
  }
  const warnings = [...x.warnings];
  if (creditor?.matched_by === 'name' && f.iban) {
    const known = (db.prepare('SELECT iban FROM creditors WHERE id = ?').get(creditor.id) as { iban: string }).iban;
    // Same name, another account: the classic invoice-fraud letter. Never quietly.
    if (known !== compact(f.iban)) warnings.unshift(`The invoice asks for payment to ${f.iban}, but ${creditor.name} is on file with ${known} — confirm the change with the supplier before paying`);
  }

  const bySha = db.prepare('SELECT id FROM bills WHERE document_sha256 = ? ORDER BY id LIMIT 1').get(x.document_sha256) as { id: number } | undefined;
  const byRef =
    creditor && f.invoice_number
      ? (db.prepare('SELECT id FROM bills WHERE creditor_id = ? AND reference = ?').get(creditor.id, f.invoice_number) as { id: number } | undefined)
      : undefined;
  const duplicate = bySha?.id ?? byRef?.id ?? null;
  if (duplicate !== null) warnings.unshift(`Already entered as bill #${duplicate}`);

  return {
    creditor,
    new_creditor: !creditor && f.supplier_name && f.iban ? { name: f.supplier_name, iban: f.iban, bic: f.bic } : null,
    reference: f.invoice_number,
    // What leaves the account is what is still owed, not the gross of a part-paid invoice.
    amount_cents: f.payable_cents ?? f.gross_cents,
    net_cents: f.net_cents,
    issue_date: f.issue_date,
    due_date: f.due_date,
    po_number: f.po_number,
    remittance: f.payment_reference && f.payment_reference !== f.invoice_number ? f.payment_reference.slice(0, 140) : null,
    // A line without its net is not one a bill can keep; neither is a nameless one.
    lines: x.lines
      .filter((l) => l.net_cents !== null && l.description.trim() !== '')
      .slice(0, 500)
      .map((l, i) => ({
        position: i + 1,
        description: l.description.trim().slice(0, 300),
        item_id: l.item_id?.slice(0, 64) ?? null,
        quantity: l.quantity,
        unit_code: l.unit_code?.slice(0, 10) ?? null,
        unit_price_cents: l.unit_price_cents,
        net_cents: l.net_cents!,
        vat_rate: l.vat_rate,
      })),
    duplicate_of: duplicate,
    read_from: readFromLabel(x),
    document_sha256: x.document_sha256,
    warnings,
  };
}
