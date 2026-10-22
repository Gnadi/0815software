import type Database from 'better-sqlite3';
import { computeTotals } from '../shared/money.js';
import type { CreditNote } from '../shared/types.js';
import {
  creditableByRate,
  DomainError,
  getCreditNote,
  getInvoice,
  invoiceLines,
  nowIso,
  todayIso,
  type LineInput,
} from './invoices.js';

/**
 * Teilgutschriften — taking back PART of an issued invoice.
 *
 * Until now the only correction was cancelling the whole invoice and issuing
 * a new one. That is right when the invoice was wrong; it is wrong when one
 * item came back, a price was reduced after a complaint, or a service was
 * delivered only in part — the invoice was correct when issued, and the
 * correction is a document of its own (§ 16 UStG-AT / § 17 UStG-DE:
 * the VAT is corrected in the period of the credit note).
 *
 * - **Its own document, its own number.** "<invoice>-GS<n>", counting per
 *   invoice — gapless and readable as belonging to the invoice, like the
 *   cancellation's "-ST". Issued immediately and never changed: there is no
 *   draft, no update and no delete. A wrong credit note is answered by the
 *   next document, not by an edit.
 * - **Never more than was invoiced, per VAT rate.** Each rate's base and VAT
 *   on all credit notes together stay within the invoice's; a rate the
 *   invoice does not carry cannot be credited at all. That keeps the VAT
 *   correction exact, which is the point of the document.
 * - **Derived effect.** What is still owed is gross − credited − paid on
 *   every read. A credit on an invoice that was already paid leaves the
 *   customer in credit — the ledger shows it; the refund itself is a bank
 *   transfer outside this module.
 * - **Not on top of a cancellation.** A cancelled invoice cannot be credited,
 *   and a credited one cannot be cancelled (`cancelInvoice`): either would
 *   take the same amount back twice.
 */

export interface CreditNoteInput {
  issueDate: string | null;
  reason: string;
  lines: LineInput[];
}

export function issueCreditNote(
  db: Database.Database,
  invoiceId: number,
  input: CreditNoteInput,
  actor: string,
  today = todayIso(),
): CreditNote {
  return db.transaction(() => {
    const invoice = getInvoice(db, invoiceId);
    if (invoice.status === 'draft' || invoice.number === null || invoice.issue_date === null) {
      throw new DomainError(409, 'A draft can still be edited — change it instead of crediting it');
    }
    if (invoice.status === 'cancelled') {
      throw new DomainError(409, `${invoice.number} is cancelled — nothing is left to credit`);
    }
    const issueDate = input.issueDate ?? today;
    const errors: { field: string; message: string }[] = [];
    if (issueDate < invoice.issue_date) {
      errors.push({ field: 'issue_date', message: `A credit note cannot predate the invoice it corrects (${invoice.issue_date})` });
    }
    if (issueDate > today) errors.push({ field: 'issue_date', message: 'A credit note cannot be dated in the future' });

    const remaining = creditableByRate(db, invoiceId);
    const credit = computeTotals(input.lines.map((l) => ({ quantity: l.quantity, unit_price_cents: l.unitPriceCents, vat_rate: l.vatRate })));
    if (credit.gross_cents <= 0) errors.push({ field: 'lines', message: 'A credit note has to credit something' });
    const invoiced = new Set(invoiceLines(db, invoiceId).map((l) => l.vat_rate));
    input.lines.forEach((line, i) => {
      if (!invoiced.has(line.vatRate)) {
        errors.push({ field: `lines[${i}].vat_rate`, message: `${invoice.number} has no ${line.vatRate} % lines to credit` });
      }
    });
    for (const row of credit.by_rate) {
      const left = remaining.find((r) => r.rate === row.rate);
      if (!left || !invoiced.has(row.rate)) continue;
      if (row.base_cents > left.base_cents || row.vat_cents > left.vat_cents) {
        errors.push({
          field: 'lines',
          message: `At ${row.rate} % only ${left.base_cents} cents net (${left.vat_cents} cents VAT) are left to credit, not ${row.base_cents} (${row.vat_cents})`,
        });
      }
    }
    if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);

    const seq =
      (db.prepare('SELECT COALESCE(MAX(seq), 0) AS last FROM credit_notes WHERE invoice_id = ?').get(invoiceId) as { last: number }).last + 1;
    const info = db
      .prepare(
        `INSERT INTO credit_notes (invoice_id, seq, number, issue_date, reason, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(invoiceId, seq, `${invoice.number}-GS${seq}`, issueDate, input.reason, actor, nowIso());
    const creditNoteId = Number(info.lastInsertRowid);
    const insert = db.prepare(
      `INSERT INTO credit_note_lines (credit_note_id, position, description, quantity, unit_price_cents, vat_rate)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    input.lines.forEach((line, i) => {
      insert.run(creditNoteId, i + 1, line.description, line.quantity, line.unitPriceCents, line.vatRate);
    });
    return getCreditNote(db, creditNoteId);
  })();
}
