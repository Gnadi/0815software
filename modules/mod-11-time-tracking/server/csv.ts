import type Database from 'better-sqlite3';
import { billableCents } from '../shared/time.js';
import {
  isDateField,
  isHoursField,
  isMoneyField,
  type DateFormat,
  type ExportColumn,
  type ExportProfile,
  type HoursFormat,
  type MoneyFormat,
} from './export-profiles.js';

/**
 * The declarative CSV render engine. It knows the three scopes, the
 * documented field set and the money/hours/date formats — and nothing
 * about any particular payroll or billing system. Every format-specific
 * decision lives in an EXPORT_PROFILES entry (export-profiles.ts); this
 * file never changes to add a profile.
 *
 * A "record" is a flat map of field → raw value. Money fields hold
 * integer CENTS, hours fields hold integer MINUTES (formatted to decimal
 * hours), everything else holds its literal value. Crucially, money is
 * computed from exact minutes, NOT from the rounded decimal hours — so
 * the payroll hours rounding never leaks into the billing amount.
 */

type Cell = string | number | null;
type Record_ = Map<string, Cell>;

function formatMoney(cents: number, format: MoneyFormat | undefined): string {
  switch (format ?? 'cents') {
    case 'cents':
      return String(cents);
    case 'decimal-dot':
      return (cents / 100).toFixed(2);
    case 'decimal-comma':
      return (cents / 100).toFixed(2).replace('.', ',');
  }
}

function formatHours(minutes: number, format: HoursFormat | undefined): string {
  const text = (minutes / 60).toFixed(2);
  return (format ?? 'dot') === 'comma' ? text.replace('.', ',') : text;
}

function formatDate(iso: string, format: DateFormat | undefined): string {
  const date = iso.slice(0, 10);
  const [y, m, d] = date.split('-') as [string, string, string];
  switch (format ?? 'iso') {
    case 'iso':
      return date;
    case 'dmy-dot':
      return `${d}.${m}.${y}`;
    case 'ymd-compact':
      return `${y}${m}${d}`;
  }
}

function cellValue(column: ExportColumn, record: Record_): string {
  const raw = record.get(column.field) ?? null;
  if (raw === null || raw === undefined) return '';
  if (isMoneyField(column.field)) return formatMoney(raw as number, column.money);
  if (isHoursField(column.field)) return formatHours(raw as number, column.hours);
  if (isDateField(column.field)) return formatDate(raw as string, column.date);
  return String(raw);
}

function escapeCell(value: string, delimiter: string): string {
  if (value.includes('"') || value.includes(delimiter) || /[\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

interface RangeEntry {
  employee_id: number;
  employee_name: string;
  employee_email: string | null;
  project_id: number;
  project_name: string;
  client: string | null;
  task_name: string | null;
  entry_date: string;
  minutes: number;
  billable: number;
  rate_cents: number;
  note: string | null;
}

/** All entries in [from, to] joined with their labels, ordered for the DETAIL dump. */
function rangeEntries(db: Database.Database, from: string, to: string): RangeEntry[] {
  return db
    .prepare(
      `SELECT te.employee_id, e.name AS employee_name, e.email AS employee_email,
              te.project_id, p.name AS project_name, p.client AS client, p.rate_cents AS rate_cents,
              t.name AS task_name, te.entry_date, te.minutes, te.billable, te.note
       FROM time_entries te
       JOIN employees e ON e.id = te.employee_id
       JOIN projects p ON p.id = te.project_id
       LEFT JOIN tasks t ON t.id = te.task_id
       WHERE te.entry_date BETWEEN ? AND ?
       ORDER BY te.entry_date, e.name, te.id`,
    )
    .all(from, to) as RangeEntry[];
}

function amountOf(entry: RangeEntry): number {
  return entry.billable === 1 ? billableCents(entry.minutes, entry.rate_cents) : 0;
}

function employeeRecords(entries: RangeEntry[], from: string, to: string): Record_[] {
  const map = new Map<number, Record_>();
  for (const e of entries) {
    let r = map.get(e.employee_id);
    if (!r) {
      r = new Map<string, Cell>([
        ['employee_name', e.employee_name],
        ['employee_email', e.employee_email],
        ['period_start', from],
        ['period_end', to],
        ['total_minutes', 0],
        ['total_hours', 0],
        ['billable_hours', 0],
        ['nonbillable_hours', 0],
        ['entry_count', 0],
      ]);
      map.set(e.employee_id, r);
    }
    r.set('total_minutes', (r.get('total_minutes') as number) + e.minutes);
    r.set('total_hours', (r.get('total_hours') as number) + e.minutes);
    if (e.billable === 1) r.set('billable_hours', (r.get('billable_hours') as number) + e.minutes);
    else r.set('nonbillable_hours', (r.get('nonbillable_hours') as number) + e.minutes);
    r.set('entry_count', (r.get('entry_count') as number) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => String(a[1].get('employee_name')).localeCompare(String(b[1].get('employee_name'))))
    .map(([, r]) => r);
}

function projectRecords(entries: RangeEntry[], from: string, to: string): Record_[] {
  const map = new Map<number, Record_>();
  for (const e of entries) {
    let r = map.get(e.project_id);
    if (!r) {
      r = new Map<string, Cell>([
        ['client', e.client],
        ['project_name', e.project_name],
        ['period_start', from],
        ['period_end', to],
        ['total_hours', 0],
        ['billable_hours', 0],
        ['rate_cents', e.rate_cents],
        ['billable_cents', 0],
        ['entry_count', 0],
      ]);
      map.set(e.project_id, r);
    }
    r.set('total_hours', (r.get('total_hours') as number) + e.minutes);
    if (e.billable === 1) r.set('billable_hours', (r.get('billable_hours') as number) + e.minutes);
    r.set('billable_cents', (r.get('billable_cents') as number) + amountOf(e));
    r.set('entry_count', (r.get('entry_count') as number) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => String(a[1].get('project_name')).localeCompare(String(b[1].get('project_name'))))
    .map(([, r]) => r);
}

function entryRecords(entries: RangeEntry[]): Record_[] {
  return entries.map(
    (e) =>
      new Map<string, Cell>([
        ['entry_date', e.entry_date],
        ['employee_name', e.employee_name],
        ['client', e.client],
        ['project_name', e.project_name],
        ['task_name', e.task_name],
        ['minutes', e.minutes],
        ['hours', e.minutes],
        ['billable', e.billable === 1 ? 'yes' : 'no'],
        ['rate_cents', e.rate_cents],
        ['billable_cents', amountOf(e)],
        ['note', e.note],
      ]),
  );
}

/**
 * Render every entry in the inclusive date range through a profile:
 * RFC-4180-style CSV, CRLF line endings, header row first. The row
 * granularity is the profile's scope (per employee / project / entry).
 */
export function exportRange(
  db: Database.Database,
  profile: ExportProfile,
  from: string,
  to: string,
): string {
  const entries = rangeEntries(db, from, to);
  const records =
    profile.scope === 'employee'
      ? employeeRecords(entries, from, to)
      : profile.scope === 'project'
        ? projectRecords(entries, from, to)
        : entryRecords(entries);

  const rows: string[] = [
    profile.columns.map((c) => escapeCell(c.header, profile.delimiter)).join(profile.delimiter),
  ];
  for (const record of records) {
    rows.push(
      profile.columns
        .map((column) => escapeCell(cellValue(column, record), profile.delimiter))
        .join(profile.delimiter),
    );
  }
  return rows.join('\r\n') + '\r\n';
}
