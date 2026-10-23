import type Database from 'better-sqlite3';
import { computeTotals, LINE_ROUNDING, type LineAmounts, type LineRounding } from '../shared/money.js';
import { BUCHUNGSSTAPEL_COLUMNS } from '../shared/datev-columns.js';
import type { TaxExemptionCategory } from '../shared/types.js';
import { DomainError, nowIso } from './invoices.js';

/**
 * Bookkeeping exports: the issued invoices of a period as a booking batch the
 * tax adviser's software imports — DATEV (Germany) and BMD NTCS (Austria).
 *
 * Both answer the same question — which receivable arose, on which revenue
 * account, at which VAT rate — and both are derived from exactly the figures
 * the invoice, the PDF and the e-invoice state: one booking per invoice and
 * VAT rate, with the amounts from `computeTotals` (per-line rounding, VAT once
 * per rate). A cancelled invoice is booked twice — its issue, and its reversal
 * on the day it was cancelled — because both happened, and the adviser's
 * ledger has to show the number was issued. A partial credit note is booked
 * like a reversal, for its own amounts, on its own date and number.
 *
 * WHAT IS NOT GUESSED. Account numbers and tax codes belong to the adviser's
 * chart of accounts, not to this module. The settings ship with the usual
 * standard accounts (SKR03 / SKR04 automatic revenue accounts for DATEV, the
 * Einheitskontenrahmen for BMD) as SUGGESTIONS, every one of them editable on
 * the export screen, and anything a period needs that is not configured makes
 * the export refuse with the list — a booking on the wrong account is a
 * correction for the adviser to find; a refusal is a field to fill in.
 *
 * Run one export through the adviser's import preview before the first real
 * one — the same advice this module gives for the SEPA file.
 */

/** The revenue groups a booking can fall into: standard rates, and the 0 % categories. */
export const REVENUE_KEYS = ['S19', 'S7', 'S20', 'S13', 'S10', 'E', 'AE', 'K', 'G', 'Z', 'O'] as const;
export type RevenueKey = (typeof REVENUE_KEYS)[number];

export const REVENUE_LABELS: Record<RevenueKey, string> = {
  S19: '19 % USt (DE)',
  S7: '7 % USt (DE)',
  S20: '20 % USt (AT)',
  S13: '13 % USt (AT)',
  S10: '10 % USt (AT)',
  E: 'steuerfrei (E)',
  AE: 'Reverse Charge (AE)',
  K: 'innergemeinschaftliche Lieferung (K)',
  G: 'Ausfuhr (G)',
  Z: 'Nullsatz (Z)',
  O: 'nicht steuerbar (O)',
};

export interface RevenueAccount {
  account: number | null;
  /** DATEV BU-Schlüssel — only for an account WITHOUT automatic VAT. */
  bu_key?: string | null;
  /** BMD Steuercode, from the client's NTCS tax code table. */
  tax_code?: string | null;
}

export interface AccountingSettings {
  datev: {
    consultant_number: number | null;
    client_number: number | null;
    chart: 'SKR03' | 'SKR04';
    /** Sachkontenlänge, 4–8. Personal accounts are one digit longer. */
    account_length: number;
    /** Wirtschaftsjahr-Beginn as "MM-DD". */
    fiscal_year_start: string;
    /** Festschreibung: lock the imported batch. Off by default — the adviser decides. */
    lock: boolean;
    /** First personal (debtor) account; a customer's own number wins. */
    debtor_start: number;
    /** The bank account incoming payments are booked against, when they are exported. */
    bank_account: number | null;
    revenue: Record<RevenueKey, RevenueAccount>;
  };
  bmd: {
    debtor_start: number;
    symbol: string;
    date_format: 'dd.mm.yyyy' | 'yyyymmdd';
    revenue: Record<RevenueKey, RevenueAccount>;
  };
}

const empty = (): Record<RevenueKey, RevenueAccount> =>
  Object.fromEntries(REVENUE_KEYS.map((k) => [k, { account: null, bu_key: null, tax_code: null }])) as Record<
    RevenueKey,
    RevenueAccount
  >;

/** The automatic revenue accounts of SKR03 and SKR04 (DATEV Kontenrahmen) — suggestions. */
export const DATEV_SUGGESTED: Record<'SKR03' | 'SKR04', Partial<Record<RevenueKey, number>>> = {
  SKR03: { S19: 8400, S7: 8300, E: 8100, AE: 8336, K: 8125, G: 8120 },
  SKR04: { S19: 4400, S7: 4300, E: 4100, AE: 4336, K: 4125, G: 4120 },
};

export function defaultSettings(): AccountingSettings {
  const datevRevenue = empty();
  for (const [key, account] of Object.entries(DATEV_SUGGESTED.SKR03)) datevRevenue[key as RevenueKey].account = account;
  const bmdRevenue = empty();
  bmdRevenue.S20 = { account: 4000, tax_code: '1' };
  bmdRevenue.S10 = { account: 4010, tax_code: '1' };
  bmdRevenue.S13 = { account: 4013, tax_code: '1' };
  return {
    datev: {
      consultant_number: null,
      client_number: null,
      chart: 'SKR03',
      account_length: 4,
      fiscal_year_start: '01-01',
      lock: false,
      debtor_start: 10000,
      bank_account: null,
      revenue: datevRevenue,
    },
    bmd: { debtor_start: 200000, symbol: 'AR', date_format: 'dd.mm.yyyy', revenue: bmdRevenue },
  };
}

export function readSettings(db: Database.Database): AccountingSettings {
  const row = db.prepare('SELECT settings FROM accounting_settings WHERE id = 1').get() as { settings: string } | undefined;
  const defaults = defaultSettings();
  if (!row) return defaults;
  const stored = JSON.parse(row.settings) as Partial<AccountingSettings>;
  // Merge field by field, so a setting added later has its default on an old row.
  return {
    datev: { ...defaults.datev, ...stored.datev, revenue: { ...defaults.datev.revenue, ...stored.datev?.revenue } },
    bmd: { ...defaults.bmd, ...stored.bmd, revenue: { ...defaults.bmd.revenue, ...stored.bmd?.revenue } },
  };
}

type Problem = { field: string; message: string };

function int(raw: unknown, field: string, min: number, max: number, problems: Problem[], nullable = true): number | null {
  if (raw === null || raw === undefined || raw === '') {
    if (!nullable) problems.push({ field, message: 'is required' });
    return null;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push({ field, message: `must be a whole number between ${min} and ${max}` });
    return null;
  }
  return n;
}

function revenueMap(raw: unknown, prefix: string, problems: Problem[]): Record<RevenueKey, RevenueAccount> {
  const out = empty();
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, Record<string, unknown>>;
  for (const key of REVENUE_KEYS) {
    const entry = input[key] ?? {};
    out[key] = {
      account: int(entry.account, `${prefix}.${key}.account`, 1, 999_999_999, problems),
      bu_key: typeof entry.bu_key === 'string' && entry.bu_key.trim() !== '' ? entry.bu_key.trim() : null,
      tax_code: typeof entry.tax_code === 'string' && entry.tax_code.trim() !== '' ? entry.tax_code.trim() : null,
    };
    if (out[key].bu_key && !/^\d{1,4}$/.test(out[key].bu_key!)) {
      problems.push({ field: `${prefix}.${key}.bu_key`, message: 'BU-Schlüssel are 1–4 digits' });
    }
    if (out[key].tax_code && !/^\d{1,3}$/.test(out[key].tax_code!)) {
      problems.push({ field: `${prefix}.${key}.tax_code`, message: 'BMD tax codes are 1–3 digits' });
    }
  }
  return out;
}

/** When the settings were last saved, and by whom — shown on the Settings screen. */
export function settingsStamp(db: Database.Database): { updated_at: string | null; updated_by: string | null } {
  const row = db.prepare('SELECT updated_at, updated_by FROM accounting_settings WHERE id = 1').get() as
    | { updated_at: string; updated_by: string | null }
    | undefined;
  return { updated_at: row?.updated_at ?? null, updated_by: row?.updated_by ?? null };
}

/** The dotted names of every setting that differs between two versions. */
function changedPaths(before: unknown, after: unknown, prefix = ''): string[] {
  if (typeof before === 'object' && before !== null && typeof after === 'object' && after !== null) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((k) =>
      changedPaths((before as Record<string, unknown>)[k], (after as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k),
    );
  }
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null) ? [] : [prefix];
}

/**
 * A fiscal-year start that exists in every year: the regex alone let 02-30 or
 * 04-31 through, which DATEV rejects in the header and `new Date` silently
 * rolls into the next month — moving the one-fiscal-year boundary with it.
 * 02-29 is refused too: it does not exist three years in four.
 */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export function validFiscalStart(value: string): boolean {
  const match = /^(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[1]);
  const day = Number(match[2]);
  return month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1]!;
}

/**
 * Validate and store the settings as the Settings screen sends them. Returns
 * the stored settings and which of them changed, for the audit trail.
 */
export function writeSettings(
  db: Database.Database,
  raw: unknown,
  actor: string | null = null,
): { settings: AccountingSettings; changed: string[] } {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, Record<string, unknown>>;
  const d = input.datev ?? {};
  const b = input.bmd ?? {};
  const problems: Problem[] = [];
  const chart = d.chart === 'SKR04' ? 'SKR04' : 'SKR03';
  const fiscal = typeof d.fiscal_year_start === 'string' ? d.fiscal_year_start : '01-01';
  if (!validFiscalStart(fiscal)) {
    problems.push({ field: 'datev.fiscal_year_start', message: 'must be a real MM-DD date, e.g. 01-01 (not 02-29 or later in February)' });
  }
  const settings: AccountingSettings = {
    datev: {
      consultant_number: int(d.consultant_number, 'datev.consultant_number', 1001, 9_999_999, problems),
      client_number: int(d.client_number, 'datev.client_number', 1, 99_999, problems),
      chart,
      account_length: int(d.account_length, 'datev.account_length', 4, 8, problems) ?? 4,
      fiscal_year_start: fiscal,
      lock: d.lock === true,
      debtor_start: int(d.debtor_start, 'datev.debtor_start', 1, 999_999_999, problems) ?? 10000,
      bank_account: int(d.bank_account, 'datev.bank_account', 1, 99_999_999, problems),
      revenue: revenueMap(d.revenue, 'datev.revenue', problems),
    },
    bmd: {
      debtor_start: int(b.debtor_start, 'bmd.debtor_start', 1, 999_999_999, problems) ?? 200000,
      symbol: typeof b.symbol === 'string' && /^[A-Z0-9]{1,4}$/.test(b.symbol.trim()) ? b.symbol.trim() : 'AR',
      date_format: b.date_format === 'yyyymmdd' ? 'yyyymmdd' : 'dd.mm.yyyy',
      revenue: revenueMap(b.revenue, 'bmd.revenue', problems),
    },
  };
  if (problems.length > 0) throw new DomainError(422, 'Validation failed', problems);
  const changed = changedPaths(readSettings(db), settings);
  db.prepare(
    `INSERT INTO accounting_settings (id, settings, updated_at, updated_by) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run(JSON.stringify(settings), nowIso(), actor);
  return { settings, changed };
}

// ── The bookings, independent of either format ─────────────────────────

/** One booking: a receivable (or its reversal, or a payment) on one revenue group. */
export interface Booking {
  kind: 'invoice' | 'cancellation' | 'credit_note' | 'payment';
  date: string;
  /** The invoice number; the cancellation's carries -ST, a credit note's is its own (-GS<n>). */
  document: string;
  invoice_number: string;
  customer_id: number;
  customer_name: string;
  customer_vat_id: string | null;
  customer_account: number | null;
  revenue_key: RevenueKey | null;
  rate: number;
  gross_cents: number;
  vat_cents: number;
  delivery_date: string | null;
  payment_terms_days: number;
}

function revenueKeyOf(rate: number, category: TaxExemptionCategory | null): RevenueKey | null {
  if (rate > 0) return `S${rate}` as RevenueKey;
  return category;
}

interface InvoiceRow {
  id: number;
  number: string;
  status: string;
  issue_date: string;
  cancelled_at: string | null;
  delivery_date: string | null;
  payment_terms_days: number;
  tax_exemption_category: TaxExemptionCategory | null;
  customer_id: number;
  customer_name: string;
  customer_vat_id: string | null;
  debtor_account: number | null;
  buyer_snapshot: string | null;
  /** NULL only on rows written without finalize; see `roundingOf` in server/invoices.ts. */
  line_rounding: LineRounding | null;
}

/**
 * Every booking whose date lies in [from, to]: issues by issue date,
 * reversals by cancellation date, payments (when asked for) by payment date.
 */
export function bookingsFor(
  db: Database.Database,
  range: { from: string; to: string },
  options: { payments?: boolean } = {},
): Booking[] {
  const invoices = db
    .prepare(
      `SELECT i.id, i.number, i.status, i.issue_date, i.cancelled_at, i.delivery_date, i.payment_terms_days,
              i.tax_exemption_category, i.customer_id, i.buyer_snapshot, i.line_rounding,
              c.name AS customer_name, c.vat_id AS customer_vat_id, c.debtor_account
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE i.status <> 'draft'
         AND ((i.issue_date BETWEEN @from AND @to)
              OR (i.status = 'cancelled' AND substr(i.cancelled_at, 1, 10) BETWEEN @from AND @to))
       ORDER BY i.issue_date, i.number`,
    )
    .all(range) as InvoiceRow[];

  // Every line of the period in ONE query, not one per invoice: a full-year
  // export reads thousands of invoices. json_each keeps the id list a single
  // bound parameter, so no SQLite variable limit applies.
  const linesByInvoice = new Map<number, LineAmounts[]>();
  const lines = db
    .prepare(
      `SELECT invoice_id, quantity, unit_price_cents, vat_rate FROM invoice_lines
       WHERE invoice_id IN (SELECT value FROM json_each(?)) ORDER BY invoice_id, position, id`,
    )
    .all(JSON.stringify(invoices.map((i) => i.id))) as (LineAmounts & { invoice_id: number })[];
  for (const line of lines) {
    const list = linesByInvoice.get(line.invoice_id) ?? [];
    list.push(line);
    linesByInvoice.set(line.invoice_id, list);
  }

  const out: Booking[] = [];
  for (const invoice of invoices) {
    // The name as it was invoiced, where the invoice froze it.
    const buyer = invoice.buyer_snapshot ? (JSON.parse(invoice.buyer_snapshot) as { name: string; vat_id: string | null }) : null;
    const base = {
      invoice_number: invoice.number,
      customer_id: invoice.customer_id,
      customer_name: buyer?.name ?? invoice.customer_name,
      customer_vat_id: buyer ? buyer.vat_id : invoice.customer_vat_id,
      customer_account: invoice.debtor_account,
      delivery_date: invoice.delivery_date,
      payment_terms_days: invoice.payment_terms_days,
    };
    // Booked as the invoice was issued: its own rounding, not today's.
    const totals = computeTotals(linesByInvoice.get(invoice.id) ?? [], invoice.line_rounding ?? LINE_ROUNDING);
    const rows = totals.by_rate.map((r) => ({
      revenue_key: revenueKeyOf(r.rate, invoice.tax_exemption_category),
      rate: r.rate,
      gross_cents: r.base_cents + r.vat_cents,
      vat_cents: r.vat_cents,
    }));
    if (invoice.issue_date >= range.from && invoice.issue_date <= range.to) {
      for (const r of rows) out.push({ ...base, ...r, kind: 'invoice', date: invoice.issue_date, document: invoice.number });
    }
    const cancelledOn = invoice.cancelled_at?.slice(0, 10);
    if (invoice.status === 'cancelled' && cancelledOn && cancelledOn >= range.from && cancelledOn <= range.to) {
      for (const r of rows) {
        out.push({ ...base, ...r, kind: 'cancellation', date: cancelledOn, document: `${invoice.number}-ST` });
      }
    }
  }

  // Credit notes of the period, by their own date — the invoice they correct
  // may lie in an earlier period, which is exactly when the VAT is corrected.
  const credits = db
    .prepare(
      `SELECT cn.id AS credit_note_id, cn.number AS credit_number, cn.issue_date AS credit_date,
              i.number, i.delivery_date, i.payment_terms_days, i.tax_exemption_category, i.customer_id, i.buyer_snapshot,
              i.line_rounding, c.name AS customer_name, c.vat_id AS customer_vat_id, c.debtor_account
       FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id JOIN customers c ON c.id = i.customer_id
       WHERE cn.issue_date BETWEEN @from AND @to ORDER BY cn.issue_date, cn.number`,
    )
    .all(range) as (Omit<InvoiceRow, 'id' | 'status' | 'issue_date' | 'cancelled_at'> & {
    credit_note_id: number;
    credit_number: string;
    credit_date: string;
  })[];
  const creditLines = db.prepare('SELECT quantity, unit_price_cents, vat_rate FROM credit_note_lines WHERE credit_note_id = ? ORDER BY position, id');
  for (const cn of credits) {
    const buyer = cn.buyer_snapshot ? (JSON.parse(cn.buyer_snapshot) as { name: string; vat_id: string | null }) : null;
    for (const r of computeTotals(creditLines.all(cn.credit_note_id) as LineAmounts[], cn.line_rounding ?? LINE_ROUNDING).by_rate) {
      out.push({
        kind: 'credit_note',
        date: cn.credit_date,
        document: cn.credit_number,
        invoice_number: cn.number,
        customer_id: cn.customer_id,
        customer_name: buyer?.name ?? cn.customer_name,
        customer_vat_id: buyer ? buyer.vat_id : cn.customer_vat_id,
        customer_account: cn.debtor_account,
        revenue_key: revenueKeyOf(r.rate, cn.tax_exemption_category),
        rate: r.rate,
        gross_cents: r.base_cents + r.vat_cents,
        vat_cents: r.vat_cents,
        delivery_date: cn.delivery_date,
        payment_terms_days: cn.payment_terms_days,
      });
    }
  }

  if (options.payments) {
    const payments = db
      .prepare(
        `SELECT p.date, p.amount_cents, i.number, i.customer_id, i.payment_terms_days, i.delivery_date, i.buyer_snapshot,
                c.name AS customer_name, c.vat_id AS customer_vat_id, c.debtor_account
         FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN customers c ON c.id = i.customer_id
         WHERE p.date BETWEEN @from AND @to ORDER BY p.date, p.id`,
      )
      .all(range) as (Omit<InvoiceRow, 'id' | 'status' | 'issue_date' | 'cancelled_at' | 'tax_exemption_category'> & {
      date: string;
      amount_cents: number;
    })[];
    for (const p of payments) {
      const buyer = p.buyer_snapshot ? (JSON.parse(p.buyer_snapshot) as { name: string }) : null;
      out.push({
        kind: 'payment',
        date: p.date,
        document: p.number,
        invoice_number: p.number,
        customer_id: p.customer_id,
        customer_name: buyer?.name ?? p.customer_name,
        customer_vat_id: p.customer_vat_id,
        customer_account: p.debtor_account,
        revenue_key: null,
        rate: 0,
        gross_cents: p.amount_cents,
        vat_cents: 0,
        delivery_date: null,
        payment_terms_days: p.payment_terms_days,
      });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ── Shared text plumbing ───────────────────────────────────────────────

/** The booking text both formats carry: who, and for a reversal which document. */
function bookingText(b: Booking): string {
  if (b.kind === 'cancellation') return `Storno ${b.invoice_number} ${b.customer_name}`;
  if (b.kind === 'credit_note') return `Gutschrift ${b.document} zu ${b.invoice_number} ${b.customer_name}`;
  return b.customer_name;
}

/** Characters Windows-1252 places at 0x80–0x9F. */
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Encode as Windows-1252 — what DATEV and BMD read. Unmappable → "?". */
export function cp1252(text: string): Buffer {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
    else bytes.push(CP1252_HIGH[code] ?? 0x3f);
  }
  return Buffer.from(bytes);
}

/** "1234,56" — comma decimals, no thousands separator, no sign. */
export function decimalComma(cents: number): string {
  const abs = Math.abs(cents);
  return `${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/**
 * A quoted text field. Tabs and line breaks become spaces (a line break would
 * end the record); a leading = + - @ is defused so a spreadsheet opening the
 * file never evaluates a customer name as a formula.
 */
function quoted(text: string, max: number): string {
  let clean = text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
  if (/^[=+\-@]/.test(clean)) clean = `'${clean}`.slice(0, max);
  return `"${clean.replace(/"/g, '""')}"`;
}

function ymd(iso: string): string {
  return iso.replace(/-/g, '');
}

/**
 * `once` collapses a problem that every booking of a group would raise — one
 * missing revenue account — into a single line naming the first invoice that
 * needs it. Everything else is reported once per distinct message.
 */
type ExportProblem = { field: string; message: string; once?: boolean };

function refuse(problems: ExportProblem[]): never {
  // Deduplicate: one missing account is one problem, however many bookings
  // need it — but two customers with a bad debtor account are two problems,
  // so the key is the whole problem, not only its field.
  const seen = new Set<string>();
  const unique = problems
    .filter((p) => {
      const key = p.once ? p.field : `${p.field}\u0000${p.message}`;
      return seen.has(key) ? false : (seen.add(key), true);
    })
    .map(({ field, message }) => ({ field, message }));
  throw new DomainError(422, 'The export settings are incomplete for this period', unique);
}

// ── DATEV ──────────────────────────────────────────────────────────────

/** The fiscal year containing `date`, given a start "MM-DD". */
export function fiscalYear(date: string, start: string): { from: string; to: string } {
  const year = Number(date.slice(0, 4));
  const startYear = date.slice(5) >= start ? year : year - 1;
  const from = `${startYear}-${start}`;
  const next = new Date(`${startYear + 1}-${start}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() - 1);
  return { from, to: next.toISOString().slice(0, 10) };
}

/** Belegfeld 1 accepts letters, digits and $ & % * + - / only, at most 36. */
function belegfeld(text: string): string {
  return text.replace(/[^A-Za-z0-9$&%*+\-/]/g, '').slice(0, 36);
}

/**
 * The DATEV-Format "Buchungsstapel" (EXTF, header version 700, format
 * version 13, 125 columns), as DATEV Unternehmen online and Kanzlei-Rechnungswesen
 * import it: semicolon-separated, Windows-1252, CRLF.
 *
 * Each invoice books its debtor in Soll against the revenue account of each
 * VAT rate, for the GROSS amount: the suggested accounts are DATEV
 * "Automatikkonten", which take the VAT out themselves — so no BU-Schlüssel is
 * written unless one is configured for a non-automatic account.
 */
export function datevExport(
  db: Database.Database,
  range: { from: string; to: string },
  options: { payments?: boolean; now?: Date; exportedBy?: string } = {},
): { filename: string; content: Buffer; bookings: number } {
  const settings = readSettings(db).datev;
  const problems: ExportProblem[] = [];
  if (settings.consultant_number === null) problems.push({ field: 'datev.consultant_number', message: 'DATEV Beraternummer is required' });
  if (settings.client_number === null) problems.push({ field: 'datev.client_number', message: 'DATEV Mandantennummer is required' });

  // DATEV takes the year from the header: a batch lies inside one fiscal year.
  const fy = fiscalYear(range.from, settings.fiscal_year_start);
  if (range.to > fy.to) {
    problems.push({ field: 'to', message: `A DATEV batch lies inside one fiscal year — end it on ${fy.to} at the latest` });
  }
  if (range.to < range.from) problems.push({ field: 'to', message: 'The period ends before it starts' });
  if (problems.length > 0) refuse(problems);

  const bookings = bookingsFor(db, range, { payments: options.payments === true });
  const personalLength = settings.account_length + 1;
  const rows: string[][] = [];
  for (const b of bookings) {
    const debtor = b.customer_account ?? settings.debtor_start + b.customer_id;
    if (String(debtor).length !== personalLength) {
      problems.push({
        field: 'datev.debtor_start',
        message: `Debtor account ${debtor} (${b.customer_name}) must have ${personalLength} digits for account length ${settings.account_length}`,
      });
    }
    let account: number;
    let contra: number;
    let side: 'S' | 'H';
    let buKey = '';
    let text: string;
    if (b.kind === 'payment') {
      if (settings.bank_account === null) {
        problems.push({ field: 'datev.bank_account', message: 'Exporting payments needs the bank account (e.g. 1200 in SKR03, 1800 in SKR04)' });
        continue;
      }
      account = settings.bank_account;
      contra = debtor;
      side = 'S';
      text = `Zahlung ${b.customer_name}`;
    } else {
      const revenue = b.revenue_key ? settings.revenue[b.revenue_key] : undefined;
      if (!b.revenue_key || !revenue || revenue.account === null) {
        const what = b.revenue_key ? REVENUE_LABELS[b.revenue_key] : '0 % without a VAT category';
        problems.push({
          field: `datev.revenue.${b.revenue_key ?? 'missing_category'}`,
          message: b.revenue_key
            ? `No revenue account configured for ${what} (first needed by ${b.invoice_number})`
            : `${b.invoice_number} has 0 % lines without a VAT category — set it on the invoice`,
          once: b.revenue_key !== null,
        });
        continue;
      }
      account = debtor;
      contra = revenue.account;
      side = b.kind === 'invoice' ? 'S' : 'H';
      buKey = revenue.bu_key ?? '';
      text = bookingText(b);
    }
    const row = new Array<string>(BUCHUNGSSTAPEL_COLUMNS.length).fill('');
    row[0] = decimalComma(b.gross_cents); // Umsatz (ohne Soll/Haben-Kz)
    row[1] = `"${side}"`; // Soll/Haben-Kennzeichen
    row[2] = '"EUR"'; // WKZ Umsatz
    row[6] = String(account); // Konto
    row[7] = String(contra); // Gegenkonto (ohne BU-Schlüssel)
    row[8] = buKey ? `"${buKey}"` : ''; // BU-Schlüssel
    row[9] = `${b.date.slice(8, 10)}${b.date.slice(5, 7)}`; // Belegdatum, TTMM
    row[10] = `"${belegfeld(b.document)}"`; // Belegfeld 1 — the OPOS key
    row[13] = quoted(text, 60); // Buchungstext
    if (b.kind !== 'payment' && (b.revenue_key === 'AE' || b.revenue_key === 'K') && b.customer_vat_id) {
      row[39] = quoted(b.customer_vat_id.replace(/\s/g, '').toUpperCase(), 15); // EU-Land u. UStID (Bestimmung)
    }
    // Leistungsdatum (115) stays empty on purpose: DATEV requires "Datum Zuord.
    // Steuerperiode" (116) beside it, and that one decides which VAT return
    // the booking lands in — the adviser's call, not this module's. The date
    // of supply is on the invoice and in its e-invoice.
    row[113] = settings.lock ? '1' : '0'; // Festschreibung
    rows.push(row);
  }
  if (problems.length > 0) refuse(problems);
  if (rows.length > 99_999) refuse([{ field: 'to', message: 'DATEV accepts at most 99,999 bookings per batch — export a shorter period' }]);

  const now = options.now ?? new Date();
  const created = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 17); // YYYYMMDDHHMMSSFFF
  const header = [
    '"EXTF"', '700', '21', '"Buchungsstapel"', '13', created, '', '"RE"',
    quoted(options.exportedBy ?? '0815software', 25), '""',
    String(settings.consultant_number), String(settings.client_number),
    ymd(fy.from), String(settings.account_length), ymd(range.from), ymd(range.to),
    quoted(`Ausgangsrechnungen ${range.from.slice(0, 7)}`, 30), '""',
    '1', '0', settings.lock ? '1' : '0', '"EUR"', '', '""', '', '',
    `"${settings.chart.slice(3)}"`, '', '', '""', '""',
  ];
  const lines = [header.join(';'), BUCHUNGSSTAPEL_COLUMNS.join(';'), ...rows.map((r) => r.join(';'))];
  return {
    filename: `EXTF_Buchungsstapel_${ymd(range.from)}_${ymd(range.to)}.csv`,
    content: cp1252(`${lines.join('\r\n')}\r\n`),
    bookings: rows.length,
  };
}

// ── BMD ────────────────────────────────────────────────────────────────

/** The column names of the BMD NTCS booking import ("Buchungsimport"). */
export const BMD_COLUMNS = [
  'satzart', 'konto', 'gkonto', 'belegnr', 'belegdat', 'buchsymbol', 'buchcode',
  'prozent', 'steuercode', 'betrag', 'steuer', 'text', 'extbelegnr', 'zziel',
] as const;

/** BMD's Belegnummer is numeric: the digits of the invoice number ("INV-2026-0001" → 20260001). */
export function bmdDocumentNumber(invoiceNumber: string): string {
  const digits = invoiceNumber.replace(/\D/g, '');
  return digits.slice(-9);
}

/**
 * The BMD NTCS booking import: one row per invoice and VAT rate, the debtor
 * as the leading account with the GROSS amount and the VAT beside it with the
 * opposite sign — BMD splits a document whose consecutive rows share account,
 * number and date. A cancellation is the same rows with inverted amounts,
 * which is how BMD books an outgoing credit note. Semicolons, comma decimals,
 * Windows-1252, a header row naming the columns.
 */
export function bmdExport(
  db: Database.Database,
  range: { from: string; to: string },
): { filename: string; content: Buffer; bookings: number } {
  const settings = readSettings(db).bmd;
  if (range.to < range.from) refuse([{ field: 'to', message: 'The period ends before it starts' }]);
  const problems: ExportProblem[] = [];
  const date = (iso: string): string =>
    settings.date_format === 'yyyymmdd' ? ymd(iso) : `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

  const rows: string[] = [];
  for (const b of bookingsFor(db, range)) {
    const revenue = b.revenue_key ? settings.revenue[b.revenue_key] : undefined;
    if (!b.revenue_key || !revenue || revenue.account === null || !revenue.tax_code) {
      problems.push({
        field: `bmd.revenue.${b.revenue_key ?? 'missing_category'}`,
        message: b.revenue_key
          ? `No revenue account and tax code configured for ${REVENUE_LABELS[b.revenue_key]} (first needed by ${b.invoice_number})`
          : `${b.invoice_number} has 0 % lines without a VAT category — set it on the invoice`,
        once: b.revenue_key !== null,
      });
      continue;
    }
    const sign = b.kind === 'invoice' ? '' : '-';
    const vatSign = b.kind === 'invoice' ? '-' : '';
    const debtor = b.customer_account ?? settings.debtor_start + b.customer_id;
    const fields = [
      '0', // satzart: Buchungszeile
      String(debtor),
      String(revenue.account),
      bmdDocumentNumber(b.invoice_number),
      date(b.date),
      settings.symbol,
      '1', // buchcode: Soll (Ausgangsrechnung); the sign carries the direction
      String(b.rate),
      revenue.tax_code,
      `${sign}${decimalComma(b.gross_cents)}`,
      b.vat_cents === 0 ? '0,00' : `${vatSign}${decimalComma(b.vat_cents)}`,
      quoted(bookingText(b), 60),
      quoted(b.document, 30),
      String(b.payment_terms_days),
    ];
    rows.push(fields.join(';'));
  }
  if (problems.length > 0) refuse(problems);
  const lines = [BMD_COLUMNS.join(';'), ...rows];
  return {
    filename: `BMD_Buchungen_${ymd(range.from)}_${ymd(range.to)}.csv`,
    content: cp1252(`${lines.join('\r\n')}\r\n`),
    bookings: rows.length,
  };
}
