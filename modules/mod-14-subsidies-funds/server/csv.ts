import type Database from 'better-sqlite3';
import { fundingCapCents } from '../shared/money.js';
import type { ApplicationStatus } from '../shared/types.js';

/**
 * CSV export of every application from OUR (the applicant's) portfolio,
 * one row per application, including the derived approved/disbursed/
 * remaining columns. RFC-4180-style: CRLF line endings, header row first,
 * quotes doubled where needed. Money is rendered as integer cents so the
 * export round-trips losslessly into a spreadsheet or an accounting import.
 */

interface ExportRow {
  ref: string;
  program_name: string;
  funding_body: string;
  title: string;
  status: ApplicationStatus;
  eligible_costs_cents: number;
  requested_amount_cents: number;
  funding_rate: number;
  funding_cap_cents: number;
  approved_amount_cents: number | null;
  disbursed_cents: number;
  remaining_cents: number | null;
  submission_date: string | null;
  reference: string | null;
  created_at: string;
}

const COLUMNS: { header: string; value: (r: ExportRow) => string }[] = [
  { header: 'ref', value: (r) => r.ref },
  { header: 'program', value: (r) => r.program_name },
  { header: 'funding_body', value: (r) => r.funding_body },
  { header: 'title', value: (r) => r.title },
  { header: 'status', value: (r) => r.status },
  { header: 'eligible_costs_cents', value: (r) => String(r.eligible_costs_cents) },
  { header: 'requested_amount_cents', value: (r) => String(r.requested_amount_cents) },
  { header: 'funding_rate_percent', value: (r) => String(r.funding_rate) },
  { header: 'funding_cap_cents', value: (r) => String(r.funding_cap_cents) },
  { header: 'approved_amount_cents', value: (r) => (r.approved_amount_cents === null ? '' : String(r.approved_amount_cents)) },
  { header: 'disbursed_cents', value: (r) => String(r.disbursed_cents) },
  { header: 'remaining_cents', value: (r) => (r.remaining_cents === null ? '' : String(r.remaining_cents)) },
  { header: 'currency', value: () => 'EUR' },
  { header: 'submission_date', value: (r) => r.submission_date ?? '' },
  { header: 'reference', value: (r) => r.reference ?? '' },
  { header: 'created_at', value: (r) => r.created_at },
];

function escapeCell(value: string): string {
  if (value.includes('"') || value.includes(',') || /[\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function exportApplicationsCsv(db: Database.Database): string {
  const apps = db
    .prepare(
      `SELECT a.ref, a.title, a.status, a.eligible_costs_cents, a.requested_amount_cents,
              a.approved_amount_cents, a.submission_date, a.reference, a.created_at,
              p.name AS program_name, p.funding_body, p.funding_rate
       FROM applications a JOIN programs p ON p.id = a.program_id
       ORDER BY a.ref`,
    )
    .all() as (Omit<ExportRow, 'funding_cap_cents' | 'disbursed_cents' | 'remaining_cents'> & {
    funding_rate: number;
  })[];

  const rows: string[] = [COLUMNS.map((c) => escapeCell(c.header)).join(',')];
  for (const a of apps) {
    const disbursed = (
      db
        .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM disbursements WHERE application_id = (SELECT id FROM applications WHERE ref = ?)')
        .get(a.ref) as { total: number }
    ).total;
    const record: ExportRow = {
      ...a,
      funding_cap_cents: fundingCapCents(a.eligible_costs_cents, a.funding_rate),
      disbursed_cents: disbursed,
      remaining_cents: a.approved_amount_cents === null ? null : a.approved_amount_cents - disbursed,
    };
    rows.push(COLUMNS.map((c) => escapeCell(c.value(record))).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}
