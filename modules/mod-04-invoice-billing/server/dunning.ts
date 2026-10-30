import type Database from 'better-sqlite3';
import { fmtEur } from '../shared/money.js';
import type { DunningLevel, DunningNotice, DunningRow, DunningSettings } from '../shared/types.js';
import type { SellerConfig } from './config.js';
import { addDays, DomainError, getCustomer, listInvoices, nowIso, todayIso } from './invoices.js';
import { A4, buildPdf, Page, wrapText } from './pdf.js';

/**
 * Mahnwesen — reminding customers of invoices they have not paid.
 *
 * Two kinds of fact, kept apart on purpose:
 *
 * - **Where an invoice stands is derived, never stored.** How far overdue it
 *   is, which reminder comes next and from when it may go out are computed
 *   from the due date, the payments and the notices already sent, every time
 *   they are read. A payment that arrives takes the invoice off the list with
 *   nothing to reset.
 * - **A notice that went out is a fact, and append-only.** `dunning_notices`
 *   records what was claimed on which day — level, open amount, fee, interest —
 *   and who issued it. It is never edited; the letter can be re-rendered from
 *   it byte for byte.
 *
 * Levels go in order (a first reminder before a first dunning letter), and
 * the next one is due once the invoice is overdue by that level's days AND
 * `min_days_between` have passed since the previous notice — so a run on an
 * invoice 60 days late sends the reminder today and the next level later,
 * never three letters at once.
 *
 * Fees and default interest are stated on the letter, not booked: they are
 * not part of the invoice (and in Austria and Germany not subject to VAT), so
 * the invoice's open amount stays what the customer owes for the supply. The
 * interest rate is a setting, not a constant — the statutory B2B rate follows
 * the central bank's base rate (§ 456 UGB, § 288 BGB) and changes twice a year.
 */

export const MAX_LEVELS = 4;

export function defaultDunningSettings(): DunningSettings {
  return {
    levels: [
      {
        name: 'Zahlungserinnerung',
        days_after_due: 7,
        fee_cents: 0,
        text: 'sicher ist Ihnen im Tagesgeschäft entgangen, dass die folgende Rechnung noch offen ist. Wir bitten Sie, den Betrag in den nächsten Tagen zu überweisen. Sollten Sie bereits bezahlt haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.',
      },
      {
        name: '1. Mahnung',
        days_after_due: 21,
        fee_cents: 0,
        text: 'leider konnten wir zu der folgenden Rechnung trotz unserer Erinnerung noch keinen Zahlungseingang feststellen. Wir ersuchen Sie, den offenen Betrag binnen 10 Tagen zu begleichen.',
      },
      {
        name: '2. Mahnung',
        days_after_due: 35,
        fee_cents: 0,
        text: 'die folgende Rechnung ist trotz zweimaliger Aufforderung weiterhin offen. Bitte überweisen Sie den Betrag umgehend, spätestens binnen 7 Tagen. Andernfalls sehen wir uns gezwungen, weitere Schritte einzuleiten.',
      },
    ],
    min_days_between: 10,
    interest_rate_percent: null,
  };
}

// ── Settings ─────────────────────────────────────────────────────────────

export function readDunningSettings(db: Database.Database): DunningSettings {
  const row = db.prepare('SELECT settings FROM dunning_settings WHERE id = 1').get() as { settings: string } | undefined;
  return row ? (JSON.parse(row.settings) as DunningSettings) : defaultDunningSettings();
}

export function dunningSettingsMeta(db: Database.Database): { updated_at: string | null; updated_by: string | null } {
  const row = db.prepare('SELECT updated_at, updated_by FROM dunning_settings WHERE id = 1').get() as
    | { updated_at: string; updated_by: string | null }
    | undefined;
  return { updated_at: row?.updated_at ?? null, updated_by: row?.updated_by ?? null };
}

type Problem = { field: string; message: string };

/** Validate a settings body. Throws 422 with every problem at once. */
export function validateDunningSettings(raw: unknown): DunningSettings {
  const problems: Problem[] = [];
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const rawLevels = Array.isArray(body.levels) ? body.levels : [];
  if (rawLevels.length < 1 || rawLevels.length > MAX_LEVELS) {
    problems.push({ field: 'levels', message: `between 1 and ${MAX_LEVELS} levels` });
  }
  const levels: DunningLevel[] = rawLevels.slice(0, MAX_LEVELS).map((entry, i) => {
    const l = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const name = typeof l.name === 'string' ? l.name.trim() : '';
    if (name === '' || name.length > 60) problems.push({ field: `levels[${i}].name`, message: 'is required (max 60 characters)' });
    const days = Number(l.days_after_due);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      problems.push({ field: `levels[${i}].days_after_due`, message: 'must be a whole number of days, 1–365' });
    }
    const fee = l.fee_cents === undefined || l.fee_cents === null || l.fee_cents === '' ? 0 : Number(l.fee_cents);
    if (!Number.isInteger(fee) || fee < 0 || fee > 100_000) {
      problems.push({ field: `levels[${i}].fee_cents`, message: 'must be 0 – 1,000.00 € in cents' });
    }
    const text = typeof l.text === 'string' ? l.text.trim() : '';
    if (text === '' || text.length > 2000) problems.push({ field: `levels[${i}].text`, message: 'is required (max 2000 characters)' });
    return { name, days_after_due: days, fee_cents: fee, text };
  });
  for (let i = 1; i < levels.length; i++) {
    if (levels[i]!.days_after_due <= levels[i - 1]!.days_after_due) {
      problems.push({ field: `levels[${i}].days_after_due`, message: 'must be later than the level before it' });
    }
  }
  const gap = Number(body.min_days_between);
  if (!Number.isInteger(gap) || gap < 0 || gap > 90) {
    problems.push({ field: 'min_days_between', message: 'must be a whole number of days, 0–90' });
  }
  let interest: number | null = null;
  if (body.interest_rate_percent !== undefined && body.interest_rate_percent !== null && body.interest_rate_percent !== '') {
    interest = Number(body.interest_rate_percent);
    if (!Number.isFinite(interest) || interest <= 0 || interest > 30 || Math.round(interest * 100) !== interest * 100) {
      problems.push({ field: 'interest_rate_percent', message: 'must be a yearly rate above 0 and at most 30, two decimals at most' });
    }
  }
  if (problems.length > 0) throw new DomainError(422, 'Dunning settings are invalid', problems);
  return { levels, min_days_between: gap, interest_rate_percent: interest };
}

export function writeDunningSettings(db: Database.Database, settings: DunningSettings, actor: string): void {
  db.prepare(
    `INSERT INTO dunning_settings (id, settings, updated_at, updated_by) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(JSON.stringify(settings), nowIso(), actor);
}

// ── Where each invoice stands (derived) ──────────────────────────────────

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function noticesOf(db: Database.Database, invoiceId: number): DunningNotice[] {
  return db.prepare('SELECT * FROM dunning_notices WHERE invoice_id = ? ORDER BY level').all(invoiceId) as DunningNotice[];
}

/** Default interest over `days`, simple and per day, on the open amount. */
export function interestCents(openCents: number, ratePercent: number | null, days: number): number {
  if (ratePercent === null || days <= 0) return 0;
  return Math.round((openCents * ratePercent * days) / (100 * 365));
}

/**
 * Every overdue, open invoice with where it stands. Sorted with the ones due
 * for a notice first, then by how long they are overdue.
 */
export function dunningOverview(db: Database.Database, today = todayIso()): DunningRow[] {
  const settings = readDunningSettings(db);
  const rows: DunningRow[] = [];
  for (const invoice of listInvoices(db, { overdueOnly: true }, today)) {
    const open = invoice.open_cents;
    if (open <= 0 || invoice.due_date === null || invoice.number === null) continue;
    const notices = noticesOf(db, invoice.id);
    const last = notices.at(-1) ?? null;
    const nextLevel = (last?.level ?? 0) + 1;
    const level = settings.levels[nextLevel - 1] ?? null;
    let nextOn: string | null = null;
    if (level) {
      const byOverdue = addDays(invoice.due_date, level.days_after_due);
      const byGap = last ? addDays(last.issued_on, settings.min_days_between) : byOverdue;
      nextOn = byOverdue > byGap ? byOverdue : byGap;
    }
    rows.push({
      invoice_id: invoice.id,
      number: invoice.number,
      customer_id: invoice.customer_id,
      customer_name: invoice.customer_name,
      due_date: invoice.due_date,
      days_overdue: daysBetween(invoice.due_date, today),
      open_cents: open,
      notices,
      next_level: level ? nextLevel : null,
      next_level_name: level?.name ?? null,
      next_on: nextOn,
      due_now: nextOn !== null && nextOn <= today,
    });
  }
  return rows.sort((a, b) => Number(b.due_now) - Number(a.due_now) || b.days_overdue - a.days_overdue);
}

// ── Issuing a notice (the fact) ──────────────────────────────────────────

/**
 * Issue the next notice for one invoice, if it is due. 409 when it is not:
 * paid, cancelled or not yet overdue enough, already at the last level, or
 * too soon after the previous notice.
 */
export function issueDunningNotice(db: Database.Database, invoiceId: number, actor: string, today = todayIso()): DunningNotice {
  const row = dunningOverview(db, today).find((r) => r.invoice_id === invoiceId);
  if (!row) throw new DomainError(409, 'This invoice is not overdue with an open amount — nothing to remind of');
  if (row.next_level === null) throw new DomainError(409, `${row.number} has had every dunning level already`);
  if (!row.due_now) throw new DomainError(409, `The next notice for ${row.number} is due on ${row.next_on}`);
  const settings = readDunningSettings(db);
  const level = settings.levels[row.next_level - 1]!;
  const interest = interestCents(row.open_cents, settings.interest_rate_percent, row.days_overdue);
  const info = db
    .prepare(
      `INSERT INTO dunning_notices (invoice_id, level, level_name, issued_on, days_overdue, open_cents, fee_cents,
                                    interest_rate_percent, interest_cents, text, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      invoiceId, row.next_level, level.name, today, row.days_overdue, row.open_cents, level.fee_cents,
      settings.interest_rate_percent, interest, level.text, actor, nowIso(),
    );
  return getDunningNotice(db, Number(info.lastInsertRowid));
}

export function getDunningNotice(db: Database.Database, id: number): DunningNotice {
  const notice = db.prepare('SELECT * FROM dunning_notices WHERE id = ?').get(id) as DunningNotice | undefined;
  if (!notice) throw new DomainError(404, 'Dunning notice not found');
  return notice;
}

/** What a notice claims in total: the open amount, the fee and the interest. */
export function claimedCents(notice: DunningNotice): number {
  return notice.open_cents + notice.fee_cents + notice.interest_cents;
}

// ── The letter ───────────────────────────────────────────────────────────

const M = 56;
const R = A4.width - 56;

/** Break text into lines of at most `width` characters, on spaces. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (current !== '' && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else current = current === '' ? word : `${current} ${word}`;
  }
  if (current !== '') lines.push(current);
  return lines;
}

function deDate(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

/**
 * The letter for a notice, rendered from the stored notice alone (plus the
 * parties) — re-downloading it next year gives the same document.
 */
export function renderDunningLetter(
  db: Database.Database,
  notice: DunningNotice,
  seller: SellerConfig,
): Buffer {
  const invoice = db.prepare('SELECT number, issue_date, due_date, customer_id FROM invoices WHERE id = ?').get(notice.invoice_id) as {
    number: string;
    issue_date: string;
    due_date: string;
    customer_id: number;
  };
  const customer = getCustomer(db, invoice.customer_id);
  const page = new Page();

  page.text('F2', 26, M, 78, '0815');
  page.text('F3', 6.5, M, 92, `${seller.name.toUpperCase()} · STANDARD BUSINESS SOFTWARE`, 0.45);
  page.textRight('F4', 13, R, 78, notice.level_name.toUpperCase());
  page.line(M, 106, R, 0.8, 0.2);
  page.text('F1', 7, M, 122, [seller.name, ...seller.addressLines].join(' · '), 0.45);

  let y = 150;
  page.text('F2', 10, M, y, customer.name);
  y += 14;
  for (const line of customer.address?.split('\n') ?? []) {
    page.text('F1', 9, M, y, line, 0.25);
    y += 13;
  }
  page.text('F4', 7, 356, 150, 'DATUM', 0.45);
  page.textRight('F3', 9, R, 150, deDate(notice.issued_on));
  page.text('F4', 7, 356, 166, 'RECHNUNG', 0.45);
  page.textRight('F3', 9, R, 166, invoice.number);

  y = Math.max(y, 190) + 30;
  page.text('F2', 12, M, y, `${notice.level_name} zu Rechnung ${invoice.number}`);
  y += 26;
  page.text('F1', 9.5, M, y, 'Sehr geehrte Damen und Herren,');
  y += 18;
  for (const line of wrap(notice.text, 95)) {
    page.text('F1', 9.5, M, y, line);
    y += 14;
  }

  y += 16;
  const row = (label: string, value: string, bold = false): void => {
    page.text(bold ? 'F2' : 'F1', 9.5, M, y, label);
    page.textRight(bold ? 'F4' : 'F3', 9.5, R, y, value);
    y += 16;
  };
  row(`Rechnung ${invoice.number} vom ${deDate(invoice.issue_date)}, fällig am ${deDate(invoice.due_date)}`, fmtEur(notice.open_cents));
  if (notice.fee_cents > 0) row('Mahnspesen', fmtEur(notice.fee_cents));
  if (notice.interest_cents > 0 && notice.interest_rate_percent !== null) {
    row(`Verzugszinsen ${String(notice.interest_rate_percent).replace('.', ',')} % p.a. für ${notice.days_overdue} Tage`, fmtEur(notice.interest_cents));
  }
  page.line(M, y - 6, R, 0.8, 0.2);
  y += 4;
  row('Offener Gesamtbetrag', fmtEur(claimedCents(notice)), true);

  y += 18;
  page.text('F1', 9, M, y, `Bitte überweisen Sie auf ${seller.iban}${seller.bic ? ` (BIC ${seller.bic})` : ''} mit Verwendungszweck ${invoice.number}.`, 0.25);
  y += 30;
  page.text('F1', 9.5, M, y, 'Mit freundlichen Grüßen');
  y += 14;
  page.text('F1', 9.5, M, y, seller.name);

  // A dunning letter is a business letter too: it names the company as the
  // invoice footer does — its Geschäftsbriefangaben (§ 35a GmbHG and its kin)
  // and register number.
  const legal = seller.legalInformation?.trim() ? wrapText('F3', 7, seller.legalInformation.trim(), R - M) : [];
  const footer = [seller.name, ...legal, seller.registration?.trim() ?? ''].filter((line) => line !== '');
  const fy = A4.height - 42 - (footer.length - 1) * 11;
  page.line(M, fy - 14, R, 0.5, 0.6);
  footer.forEach((line, i) => page.text('F3', 7, M, fy + i * 11, line, 0.45));

  return buildPdf([page]);
}
