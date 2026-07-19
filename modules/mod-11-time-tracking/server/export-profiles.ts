/**
 * CSV export profiles — THE one place export formats live.
 *
 * "Export to payroll or billing" is kept honest by making formats data,
 * not code: a profile is a name, a SCOPE (which determines what a row
 * is) and a column list, each column a header label plus a field from
 * that scope's documented set and an optional money/hours/date format.
 * Adding an export format = adding one entry to EXPORT_PROFILES (see the
 * README walkthrough); the render engine in ./csv.ts never changes.
 *
 * Three scopes, three row granularities:
 *   employee  one row per employee, hours aggregated over the range
 *   project   one row per project, billable amount over the range
 *   entry     one row per individual time entry
 *
 * Field sets (the full documented set) per scope:
 *
 *   employee:
 *     employee_name         employee display name
 *     employee_email        employee email ('' when unset)
 *     period_start          range start        (date-formattable)
 *     period_end            range end          (date-formattable)
 *     total_minutes         all logged minutes                (integer)
 *     total_hours           all logged hours   (hours-formattable)
 *     billable_hours        billable hours     (hours-formattable)
 *     nonbillable_hours     non-billable hours (hours-formattable)
 *     entry_count           number of entries                 (integer)
 *
 *   project:
 *     client                client name ('' when unset)
 *     project_name          project display name
 *     period_start          range start        (date-formattable)
 *     period_end            range end          (date-formattable)
 *     total_hours           all logged hours   (hours-formattable)
 *     billable_hours        billable hours     (hours-formattable)
 *     rate_cents            hourly rate        (money-formattable)
 *     billable_cents        billed amount      (money-formattable)
 *     entry_count           number of entries                 (integer)
 *
 *   entry:
 *     entry_date            entry date         (date-formattable)
 *     employee_name         employee display name
 *     client                client name ('' when unset)
 *     project_name          project display name
 *     task_name             task name ('' when unset)
 *     minutes               duration in minutes               (integer)
 *     hours                 duration in hours  (hours-formattable)
 *     billable              "yes" / "no"
 *     rate_cents            hourly rate        (money-formattable)
 *     billable_cents        billed amount      (money-formattable)
 *     note                  free-text note ('' when unset)
 *
 * Money formats ('cents' is the default when omitted):
 *   cents          integer cents            123456
 *   decimal-dot    euros, dot decimals      1234.56
 *   decimal-comma  euros, comma decimals    1234,56
 * Hours formats ('dot' is the default when omitted):
 *   dot            dot decimals             1.75
 *   comma          comma decimals           1,75
 * Date formats ('iso' is the default when omitted):
 *   iso            2026-07-19
 *   dmy-dot        19.07.2026
 *   ymd-compact    20260719
 */

export const EXPORT_SCOPES = ['employee', 'project', 'entry'] as const;
export type ExportScope = (typeof EXPORT_SCOPES)[number];

export const SCOPE_FIELDS: Record<ExportScope, readonly string[]> = {
  employee: [
    'employee_name',
    'employee_email',
    'period_start',
    'period_end',
    'total_minutes',
    'total_hours',
    'billable_hours',
    'nonbillable_hours',
    'entry_count',
  ],
  project: [
    'client',
    'project_name',
    'period_start',
    'period_end',
    'total_hours',
    'billable_hours',
    'rate_cents',
    'billable_cents',
    'entry_count',
  ],
  entry: [
    'entry_date',
    'employee_name',
    'client',
    'project_name',
    'task_name',
    'minutes',
    'hours',
    'billable',
    'rate_cents',
    'billable_cents',
    'note',
  ],
};

export const MONEY_FORMATS = ['cents', 'decimal-dot', 'decimal-comma'] as const;
export type MoneyFormat = (typeof MONEY_FORMATS)[number];

export const HOURS_FORMATS = ['dot', 'comma'] as const;
export type HoursFormat = (typeof HOURS_FORMATS)[number];

export const DATE_FORMATS = ['iso', 'dmy-dot', 'ymd-compact'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export interface ExportColumn {
  header: string;
  field: string;
  money?: MoneyFormat;
  hours?: HoursFormat;
  date?: DateFormat;
}

export interface ExportProfile {
  name: string;
  description: string;
  scope: ExportScope;
  delimiter: ',' | ';';
  columns: ExportColumn[];
}

/** Fields whose value is money (integer cents) — accept a `money` format. */
function isMoneyField(field: string): boolean {
  return field.endsWith('_cents');
}
/** Fields whose value is decimal hours — accept an `hours` format. */
function isHoursField(field: string): boolean {
  return field === 'hours' || field.endsWith('_hours');
}
/** Fields whose value is a date — accept a `date` format. */
function isDateField(field: string): boolean {
  return field === 'entry_date' || field === 'period_start' || field === 'period_end';
}
export { isMoneyField, isHoursField, isDateField };

/**
 * Three profiles ship out of the box: one for payroll, one for billing,
 * and a full per-entry detail dump.
 */
export const EXPORT_PROFILES: ExportProfile[] = [
  {
    name: 'PAYROLL',
    description:
      'Hours per employee for the period, as decimal hours (dot decimals) — the shape a payroll import expects: who worked, how much, how much of it billable.',
    scope: 'employee',
    delimiter: ',',
    columns: [
      { header: 'employee', field: 'employee_name' },
      { header: 'email', field: 'employee_email' },
      { header: 'period_start', field: 'period_start', date: 'iso' },
      { header: 'period_end', field: 'period_end', date: 'iso' },
      { header: 'total_hours', field: 'total_hours', hours: 'dot' },
      { header: 'billable_hours', field: 'billable_hours', hours: 'dot' },
      { header: 'nonbillable_hours', field: 'nonbillable_hours', hours: 'dot' },
    ],
  },
  {
    name: 'BILLING',
    description:
      'Billable amount per project/client for the period, euro amounts with dot decimals — feed it into invoicing (e.g. MOD-04). Only billable time contributes to the amount.',
    scope: 'project',
    delimiter: ',',
    columns: [
      { header: 'client', field: 'client' },
      { header: 'project', field: 'project_name' },
      { header: 'period_start', field: 'period_start', date: 'iso' },
      { header: 'period_end', field: 'period_end', date: 'iso' },
      { header: 'billable_hours', field: 'billable_hours', hours: 'dot' },
      { header: 'rate_eur', field: 'rate_cents', money: 'decimal-dot' },
      { header: 'amount_eur', field: 'billable_cents', money: 'decimal-dot' },
    ],
  },
  {
    name: 'DETAIL',
    description:
      'One row per time entry — the full audit trail for a period: date, employee, project, task, minutes, hours, billable flag and amount. Semicolon-separated for spreadsheet tools.',
    scope: 'entry',
    delimiter: ';',
    columns: [
      { header: 'date', field: 'entry_date', date: 'iso' },
      { header: 'employee', field: 'employee_name' },
      { header: 'client', field: 'client' },
      { header: 'project', field: 'project_name' },
      { header: 'task', field: 'task_name' },
      { header: 'minutes', field: 'minutes' },
      { header: 'hours', field: 'hours', hours: 'dot' },
      { header: 'billable', field: 'billable' },
      { header: 'rate_eur', field: 'rate_cents', money: 'decimal-dot' },
      { header: 'amount_eur', field: 'billable_cents', money: 'decimal-dot' },
      { header: 'note', field: 'note' },
    ],
  },
];

export function getProfile(name: string): ExportProfile | undefined {
  return EXPORT_PROFILES.find((p) => p.name.toLowerCase() === name.toLowerCase());
}

// ── Config self-check (runs once at import) ──────────────────────────
{
  const names = new Set<string>();
  for (const profile of EXPORT_PROFILES) {
    if (names.has(profile.name)) throw new Error(`export-profiles: duplicate profile name ${profile.name}`);
    names.add(profile.name);
    if (profile.columns.length === 0) throw new Error(`export-profiles: ${profile.name} has no columns`);
    const allowed = SCOPE_FIELDS[profile.scope];
    for (const col of profile.columns) {
      if (!allowed.includes(col.field)) {
        throw new Error(
          `export-profiles: ${profile.name}/${col.header} uses field ${col.field} not valid for scope ${profile.scope}`,
        );
      }
      if (col.money && !isMoneyField(col.field)) {
        throw new Error(`export-profiles: ${profile.name}/${col.header} has a money format on a non-money field`);
      }
      if (col.hours && !isHoursField(col.field)) {
        throw new Error(`export-profiles: ${profile.name}/${col.header} has an hours format on a non-hours field`);
      }
      if (col.date && !isDateField(col.field)) {
        throw new Error(`export-profiles: ${profile.name}/${col.header} has a date format on a non-date field`);
      }
    }
  }
}
