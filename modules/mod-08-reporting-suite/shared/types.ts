/**
 * Domain types shared between the Express API and the React client.
 * The single source of truth for enums lives here so the server and
 * client can never disagree.
 */

// ── Aggregations & schedule enums ─────────────────────────────────────

export const AGGREGATIONS = ['sum', 'count', 'avg', 'min', 'max'] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export const CHART_KINDS = ['bar', 'line', 'area', 'pie'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export const SCHEDULE_INTERVALS = ['hourly', 'daily'] as const;
export type ScheduleInterval = (typeof SCHEDULE_INTERVALS)[number];

export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const RUN_STATUSES = ['ok', 'error'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TRIGGERS = ['manual', 'scheduled'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

// ── Parameters ────────────────────────────────────────────────────────

export const PARAM_TYPES = ['text', 'number', 'date', 'choice'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

/** Dates a parameter may be given relative to the day it runs (plus today±N). */
export const RELATIVE_DATES = [
  'today',
  'yesterday',
  'week_start',
  'month_start',
  'month_end',
  'prev_month_start',
  'prev_month_end',
  'year_start',
  'prev_year_start',
  'prev_year_end',
] as const;

/** A placeholder a report's SQL names (`:name`), declared with the report. */
export interface ReportParam {
  name: string;
  label: string;
  type: ParamType;
  required: boolean;
  /** A value of the type; for a date also a relative date. */
  default: string | null;
  /** The options of a choice; empty otherwise. */
  choices: string[];
}

/** Values given for parameters, by name — relative dates kept relative. */
export type ParamValues = Record<string, string>;

// ── Reports ───────────────────────────────────────────────────────────

export interface Report {
  id: number;
  name: string;
  description: string | null;
  sql: string;
  params: ReportParam[];
  created_at: string;
  updated_at: string;
}

/** A report execution result: column names + row objects. */
export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Rows were capped at the configured limit (there may be more). */
  truncated: boolean;
  /** Milliseconds spent inside better-sqlite3. */
  elapsed_ms: number;
}

// ── Pivot ─────────────────────────────────────────────────────────────

export interface PivotConfig {
  /** Column whose distinct values become the pivot's rows. */
  row: string;
  /** Optional column whose distinct values become the pivot's columns. */
  col: string | null;
  /** Column the measure is computed from ('*' allowed only for count). */
  measure: string;
  aggregation: Aggregation;
}

export interface PivotResult {
  /** Header cells for the value columns (distinct col-dimension values). */
  columns: string[];
  rows: {
    key: string;
    /** One value per `columns` entry; null = empty cell (no matching rows). */
    values: (number | null)[];
    /** Row-wise grand total across the value columns. */
    total: number | null;
  }[];
  /** Column-wise grand totals, aligned with `columns`. */
  columnTotals: (number | null)[];
  /** The single grand total across everything. */
  grandTotal: number | null;
  /** True when there is no column dimension (single value column). */
  flat: boolean;
}

// ── Charts ────────────────────────────────────────────────────────────

export interface ChartConfig {
  kind: ChartKind;
  /** Column used for the category / x axis (rendered as labels); a pie's slices. */
  x: string;
  /** Column used for the numeric y axis; a pie's sizes. */
  y: string;
  /** Optional column whose values split the data into series (one per value). */
  series?: string | null;
  /** Bars and areas of several series stacked rather than side by side. */
  stacked?: boolean;
}

export interface Chart {
  id: number;
  report_id: number;
  name: string;
  kind: ChartKind;
  x_column: string;
  y_column: string;
  series_column: string | null;
  stacked: boolean;
  /** The report's parameters as this chart shows them — an embed cannot change them. */
  param_values: ParamValues;
  created_at: string;
}

export interface ChartRow extends Chart {
  report_name: string;
}

// ── Schedules & run history ───────────────────────────────────────────

export interface Schedule {
  id: number;
  report_id: number;
  interval: ScheduleInterval;
  format: ExportFormat;
  enabled: number; // 0 | 1 (SQLite boolean)
  /** The report's parameters for every scheduled run — relative dates stay relative. */
  param_values: ParamValues;
  last_run_at: string | null;
  created_at: string;
}

export interface ScheduleRow extends Schedule {
  report_name: string;
  next_due_at: string | null;
}

export interface Run {
  id: number;
  report_id: number;
  schedule_id: number | null;
  trigger: RunTrigger;
  status: RunStatus;
  started_at: string;
  finished_at: string;
  row_count: number | null;
  file_path: string | null;
  error: string | null;
  /** The parameter values the run bound (relative dates resolved), or null. */
  params: Record<string, string | number | null> | null;
}

export interface RunRow extends Run {
  report_name: string;
}

// ── Settings ──────────────────────────────────────────────────────────

export interface ReportSettings {
  /** IANA zone relative dates are resolved in. */
  timezone: string;
  updated_by: string | null;
  updated_at: string | null;
}

// ── Validation error shape (shared by every 422 response) ─────────────

export interface FieldError {
  field: string;
  message: string;
}
