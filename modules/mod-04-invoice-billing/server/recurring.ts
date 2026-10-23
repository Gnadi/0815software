import type Database from 'better-sqlite3';
import type { RecurringInterval, RecurringTemplate } from '../shared/types.js';
import { addDays, createDraft, DomainError, getCustomer, nowIso, todayIso, type DraftInput } from './invoices.js';

/**
 * Wiederkehrende Rechnungen — the same invoice every month, quarter or year.
 *
 * A template is a draft-to-be: customer, lines, terms, plus a rhythm (start
 * date, interval, optional end). It never issues anything. Generating turns
 * each period that has begun into a DRAFT, which a person checks and sends —
 * numbering stays gapless and nobody is invoiced behind their back.
 *
 * - **At most once per period, by construction.** `recurring_runs` records
 *   which period of which template produced which draft, with
 *   UNIQUE (template, period). Generating twice, or two people clicking at
 *   once, yields the same drafts, not doubles.
 * - **Periods are derived from the start date, never chained.** Period n
 *   starts n intervals after the start date, the day clamped to the month's
 *   length (a template starting 31 January bills 28/29 February, then 31
 *   March again) — so no rounding accumulates over the years.
 * - **Catch-up is bounded.** A template that was paused, or a server that was
 *   off, gets every missed period as its own draft, up to `MAX_CATCH_UP` per
 *   call; the rest follow on the next.
 * - **Editing a template changes the future only.** Drafts already generated
 *   are ordinary drafts; they are edited, sent or deleted like any other.
 */

export const INTERVAL_MONTHS: Record<RecurringInterval, number> = { monthly: 1, quarterly: 3, yearly: 12 };
export const MAX_CATCH_UP = 24;

interface TemplateRow {
  id: number;
  name: string;
  customer_id: number;
  interval: RecurringInterval;
  start_date: string;
  end_date: string | null;
  active: number;
  draft: string;
  created_at: string;
  created_by: string;
}

/** The draft a template produces, minus customer and dates (those come from the template and period). */
export type TemplateDraft = Omit<DraftInput, 'customerId' | 'createdAt' | 'deliveryDate' | 'periodStart' | 'periodEnd'>;

/** "2026-01-31" + 1 month → "2026-02-28": the start day, clamped to the target month. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Period n of a template: [start, end], both inclusive. */
export function periodOf(startDate: string, interval: RecurringInterval, n: number): { start: string; end: string } {
  const step = INTERVAL_MONTHS[interval];
  return { start: addMonths(startDate, n * step), end: addDays(addMonths(startDate, (n + 1) * step), -1) };
}

function generatedPeriods(db: Database.Database, templateId: number): Set<string> {
  const rows = db.prepare('SELECT period_start FROM recurring_runs WHERE template_id = ?').all(templateId) as { period_start: string }[];
  return new Set(rows.map((r) => r.period_start));
}

/** The periods that have begun by `today` and have no draft yet, oldest first. */
function duePeriods(db: Database.Database, row: TemplateRow, today: string): { start: string; end: string }[] {
  if (!row.active) return [];
  const done = generatedPeriods(db, row.id);
  const due: { start: string; end: string }[] = [];
  for (let n = 0; ; n++) {
    const period = periodOf(row.start_date, row.interval, n);
    if (period.start > today) break;
    if (row.end_date !== null && period.start > row.end_date) break;
    if (!done.has(period.start)) due.push(period);
  }
  return due;
}

function nextPeriodStart(db: Database.Database, row: TemplateRow, today: string): string | null {
  if (!row.active) return null;
  const done = generatedPeriods(db, row.id);
  for (let n = 0; ; n++) {
    const { start } = periodOf(row.start_date, row.interval, n);
    if (row.end_date !== null && start > row.end_date) return null;
    if (start > today || !done.has(start)) return start;
  }
}

function toTemplate(db: Database.Database, row: TemplateRow, today: string): RecurringTemplate {
  const draft = JSON.parse(row.draft) as TemplateDraft;
  const runs = db
    .prepare(
      `SELECT r.period_start, r.period_end, r.invoice_id, i.number, i.status
         FROM recurring_runs r LEFT JOIN invoices i ON i.id = r.invoice_id
        WHERE r.template_id = ? ORDER BY r.period_start DESC LIMIT 12`,
    )
    .all(row.id) as RecurringTemplate['recent'];
  return {
    id: row.id,
    name: row.name,
    customer_id: row.customer_id,
    customer_name: getCustomer(db, row.customer_id).name,
    interval: row.interval,
    start_date: row.start_date,
    end_date: row.end_date,
    active: row.active === 1,
    payment_terms_days: draft.paymentTermsDays,
    note: draft.note,
    lines: draft.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit_price_cents: l.unitPriceCents, vat_rate: l.vatRate })),
    buyer_reference: draft.buyerReference ?? null,
    tax_exemption_category: draft.taxExemptionCategory ?? null,
    tax_exemption_reason: draft.taxExemptionReason ?? null,
    due_periods: duePeriods(db, row, today).length,
    next_period_start: nextPeriodStart(db, row, today),
    recent: runs,
    created_by: row.created_by,
  };
}

function templateRow(db: Database.Database, id: number): TemplateRow {
  const row = db.prepare('SELECT * FROM recurring_invoices WHERE id = ?').get(id) as TemplateRow | undefined;
  if (!row) throw new DomainError(404, 'Recurring invoice not found');
  return row;
}

export function listTemplates(db: Database.Database, today = todayIso()): RecurringTemplate[] {
  const rows = db.prepare('SELECT * FROM recurring_invoices ORDER BY active DESC, name').all() as TemplateRow[];
  return rows.map((r) => toTemplate(db, r, today));
}

export function getTemplate(db: Database.Database, id: number, today = todayIso()): RecurringTemplate {
  return toTemplate(db, templateRow(db, id), today);
}

export interface TemplateInput {
  name: string;
  customerId: number;
  interval: RecurringInterval;
  startDate: string;
  endDate: string | null;
  active: boolean;
  draft: TemplateDraft;
}

export function createTemplate(db: Database.Database, input: TemplateInput, actor: string): number {
  getCustomer(db, input.customerId);
  const info = db
    .prepare(
      `INSERT INTO recurring_invoices (name, customer_id, interval, start_date, end_date, active, draft, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.name, input.customerId, input.interval, input.startDate, input.endDate, input.active ? 1 : 0, JSON.stringify(input.draft), nowIso(), actor);
  return Number(info.lastInsertRowid);
}

/**
 * Change a template. The start date is fixed once a period has been generated:
 * moving it would re-cut every period, and the history would no longer line up
 * with the drafts it produced.
 */
export function updateTemplate(db: Database.Database, id: number, input: TemplateInput): void {
  const row = templateRow(db, id);
  getCustomer(db, input.customerId);
  if (input.startDate !== row.start_date && generatedPeriods(db, id).size > 0) {
    throw new DomainError(409, 'The start date cannot move once periods have been invoiced — end this one and start a new template');
  }
  db.prepare(
    `UPDATE recurring_invoices SET name = ?, customer_id = ?, interval = ?, start_date = ?, end_date = ?, active = ?, draft = ? WHERE id = ?`,
  ).run(input.name, input.customerId, input.interval, input.startDate, input.endDate, input.active ? 1 : 0, JSON.stringify(input.draft), id);
}

/** Delete a template that never produced anything; one with history is ended or paused instead. */
export function deleteTemplate(db: Database.Database, id: number): void {
  templateRow(db, id);
  if (generatedPeriods(db, id).size > 0) {
    throw new DomainError(409, 'This template has invoiced periods — pause it or give it an end date instead of deleting it');
  }
  db.prepare('DELETE FROM recurring_invoices WHERE id = ?').run(id);
}

export interface GeneratedDraft {
  template_id: number;
  period_start: string;
  period_end: string;
  invoice_id: number;
}

/**
 * Turn every period of a template that has begun into a draft, at most once
 * each and at most `MAX_CATCH_UP` per call. Returns what was created now.
 */
export function generateDrafts(db: Database.Database, id: number, actor: string, today = todayIso()): GeneratedDraft[] {
  const row = templateRow(db, id);
  const draft = JSON.parse(row.draft) as TemplateDraft;
  const created: GeneratedDraft[] = [];
  for (const period of duePeriods(db, row, today).slice(0, MAX_CATCH_UP)) {
    db.transaction(() => {
      // Claim the period first: if someone else already has, the UNIQUE
      // constraint stops us before a second draft exists.
      const claim = db
        .prepare(
          `INSERT OR IGNORE INTO recurring_runs (template_id, period_start, period_end, invoice_id, created_at, actor)
           VALUES (?, ?, ?, NULL, ?, ?)`,
        )
        .run(id, period.start, period.end, nowIso(), actor);
      if (claim.changes === 0) return;
      // The period this run bills is the service period (BG-14). It used to
      // go in as a delivery date on its first day plus a line of free text,
      // which no recipient's software could read as a period.
      const invoiceId = createDraft(db, {
        ...draft,
        customerId: row.customer_id,
        periodStart: period.start,
        periodEnd: period.end,
      });
      db.prepare('UPDATE recurring_runs SET invoice_id = ? WHERE template_id = ? AND period_start = ?').run(invoiceId, id, period.start);
      created.push({ template_id: id, period_start: period.start, period_end: period.end, invoice_id: invoiceId });
    })();
  }
  return created;
}

/** Every active template's due periods, as drafts. */
export function generateAll(db: Database.Database, actor: string, today = todayIso()): GeneratedDraft[] {
  const ids = (db.prepare('SELECT id FROM recurring_invoices WHERE active = 1 ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  return ids.flatMap((id) => generateDrafts(db, id, actor, today));
}
