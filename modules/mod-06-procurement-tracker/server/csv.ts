import type Database from 'better-sqlite3';
import { computeTotalCents, lineNetCents } from '../shared/money.js';
import type { DateFormat, ExportColumn, ExportProfile, MoneyFormat } from './export-profiles.js';

/**
 * The declarative CSV render engine. It knows the documented field set,
 * three money formats and three date formats — and nothing about any
 * particular ERP. Every ERP-specific decision lives in an
 * EXPORT_PROFILES entry (export-profiles.ts); this file never needs to
 * change to add a format.
 */

interface PoExportData {
  number: string;
  supplier_name: string;
  supplier_email: string | null;
  supplier_contact: string | null;
  note: string | null;
  total_cents: number;
  created_at: string;
  ordered_at: string;
}

interface LineExportData {
  position: number;
  description: string;
  quantity: number;
  unit: string;
  unit_price_cents: number;
  net_cents: number;
}

function formatMoney(cents: number, format: MoneyFormat): string {
  switch (format) {
    case 'cents':
      return String(cents);
    case 'decimal-dot':
      return (cents / 100).toFixed(2);
    case 'decimal-comma':
      return (cents / 100).toFixed(2).replace('.', ',');
  }
}

function formatDate(iso: string, format: DateFormat): string {
  const date = iso.slice(0, 10); // YYYY-MM-DD from a date or datetime
  const [y, m, d] = date.split('-') as [string, string, string];
  switch (format) {
    case 'iso':
      return date;
    case 'dmy-dot':
      return `${d}.${m}.${y}`;
    case 'ymd-compact':
      return `${y}${m}${d}`;
  }
}

/** "12", "2.5" — quantities without float noise. */
function formatQty(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function cellValue(column: ExportColumn, po: PoExportData, line: LineExportData): string {
  const [scope, key] = column.field.split('.') as ['po' | 'line', string];
  if (column.field === 'po.currency') return 'EUR';
  if (column.field === 'line.quantity') return formatQty(line.quantity);
  const raw: unknown = scope === 'po' ? po[key as keyof PoExportData] : line[key as keyof LineExportData];
  if (raw === null || raw === undefined) return '';
  if (key.endsWith('_cents')) return formatMoney(raw as number, column.money ?? 'cents');
  if (key.endsWith('_at')) return formatDate(raw as string, column.date ?? 'iso');
  return String(raw);
}

function escapeCell(value: string, delimiter: string): string {
  if (value.includes('"') || value.includes(delimiter) || /[\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

/**
 * Render every ordered PO (stored status `ordered` — approved and sent
 * to the supplier, not yet closed) through a profile: RFC-4180-style
 * CSV, one row per PO line, CRLF line endings, header row first.
 */
export function exportOrderedPos(db: Database.Database, profile: ExportProfile): string {
  const pos = db
    .prepare(
      `SELECT p.id, p.number, p.note, p.created_at, p.ordered_at,
              s.name AS supplier_name, s.email AS supplier_email, s.contact AS supplier_contact
       FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id
       WHERE p.status = 'ordered' ORDER BY p.number`,
    )
    .all() as (Omit<PoExportData, 'total_cents'> & { id: number })[];

  const rows: string[] = [profile.columns.map((c) => escapeCell(c.header, profile.delimiter)).join(profile.delimiter)];
  for (const poRow of pos) {
    const lines = db
      .prepare('SELECT position, description, quantity, unit, unit_price_cents FROM po_lines WHERE po_id = ? ORDER BY position, id')
      .all(poRow.id) as Omit<LineExportData, 'net_cents'>[];
    const po: PoExportData = { ...poRow, total_cents: computeTotalCents(lines) };
    for (const bare of lines) {
      const line: LineExportData = { ...bare, net_cents: lineNetCents(bare) };
      rows.push(
        profile.columns
          .map((column) => escapeCell(cellValue(column, po, line), profile.delimiter))
          .join(profile.delimiter),
      );
    }
  }
  return rows.join('\r\n') + '\r\n';
}
