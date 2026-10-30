import type { FieldError, ParamValues, ReportParam } from '../shared/types.js';
import { PARAM_TYPES, RELATIVE_DATES } from '../shared/types.js';
import { DomainError } from './errors.js';
import { queryParameters } from './query-policy.js';

/**
 * Report parameters. A report's SQL may name placeholders — `WHERE booked_on
 * BETWEEN :from AND :to` — and the report declares each one: its label, type
 * (text, number, date, or a choice from a fixed list), whether it is required
 * and a default.
 *
 * Values are BOUND by SQLite, never written into the SQL text, so a value
 * cannot change what the query does; the SELECT-only policy and the read-only
 * connection stand as before. Declarations and the SQL must agree — a
 * placeholder nobody declared, or a declaration the SQL never uses, is
 * refused when the report is saved, not discovered when it runs.
 *
 * A date may be given relative — `today`, `today-7`, `month_start`,
 * `prev_month_start`, … — and is resolved when the report runs, in the
 * module's time zone (Settings). That is what lets a monthly export always
 * cover the month before, and an embedded chart show "this month".
 */

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RELATIVE_OFFSET = /^today([+-])(\d{1,4})$/;

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function isRelativeDate(value: string): boolean {
  return (RELATIVE_DATES as readonly string[]).includes(value) || RELATIVE_OFFSET.test(value);
}

/** Today's date where the office is. */
function localToday(now: number, tz: string): { y: number; m: number; d: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

const iso = (y: number, m: number, d: number): string => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

/** A relative date as YYYY-MM-DD, or null when it is not one. */
export function resolveRelativeDate(token: string, now: number, tz: string): string | null {
  const { y, m, d } = localToday(now, tz);
  const offset = RELATIVE_OFFSET.exec(token);
  if (offset) return iso(y, m, d + (offset[1] === '-' ? -1 : 1) * Number(offset[2]));
  switch (token) {
    case 'today':
      return iso(y, m, d);
    case 'yesterday':
      return iso(y, m, d - 1);
    case 'week_start': {
      const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday 0
      return iso(y, m, d - weekday);
    }
    case 'month_start':
      return iso(y, m, 1);
    case 'month_end':
      return iso(y, m + 1, 0);
    case 'prev_month_start':
      return iso(y, m - 1, 1);
    case 'prev_month_end':
      return iso(y, m, 0);
    case 'year_start':
      return iso(y, 1, 1);
    case 'prev_year_start':
      return iso(y - 1, 1, 1);
    case 'prev_year_end':
      return iso(y - 1, 12, 31);
    default:
      return null;
  }
}

/** One value checked against its declaration; returns the problem, or null. */
function problemWith(param: ReportParam, value: string): string | null {
  switch (param.type) {
    case 'number':
      return value.trim() !== '' && Number.isFinite(Number(value)) ? null : 'must be a number';
    case 'date':
      return validDate(value) || isRelativeDate(value) ? null : 'must be a date (YYYY-MM-DD) or a relative date such as today, month_start, prev_month_end, today-7';
    case 'choice':
      return param.choices.includes(value) ? null : `must be one of: ${param.choices.join(', ')}`;
    default:
      return value.length <= 500 ? null : 'at most 500 characters';
  }
}

/**
 * Validate a report's parameter declarations against its SQL. The SQL must
 * name every declared parameter and declare every one it names.
 */
export function validateParamDefs(raw: unknown, sql: string): ReportParam[] {
  const errors: FieldError[] = [];
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    throw new DomainError(422, 'Validation failed', [{ field: 'params', message: 'must be a list of parameters' }]);
  }
  const list = (raw ?? []) as unknown[];
  if (list.length > 20) errors.push({ field: 'params', message: 'at most 20 parameters' });
  const seen = new Set<string>();
  const params = list.map((item, i): ReportParam => {
    const p = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const field = `params.${i}`;
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!NAME.test(name)) errors.push({ field: `${field}.name`, message: 'must be a name for the SQL — letters, digits, _ (e.g. from_date)' });
    else if (seen.has(name)) errors.push({ field: `${field}.name`, message: `:${name} is declared twice` });
    seen.add(name);
    const type = typeof p.type === 'string' && (PARAM_TYPES as readonly string[]).includes(p.type) ? (p.type as ReportParam['type']) : (errors.push({ field: `${field}.type`, message: `must be one of: ${PARAM_TYPES.join(', ')}` }), 'text');
    const label = typeof p.label === 'string' && p.label.trim() !== '' ? p.label.trim().slice(0, 80) : name;
    const choices = Array.isArray(p.choices) ? [...new Set(p.choices.map((c) => String(c).trim()).filter(Boolean))].slice(0, 100) : [];
    if (type === 'choice' && choices.length === 0) errors.push({ field: `${field}.choices`, message: 'a choice needs at least one option' });
    const param: ReportParam = { name, label, type, required: p.required === true, default: null, choices: type === 'choice' ? choices : [] };
    if (p.default !== undefined && p.default !== null && String(p.default).trim() !== '') {
      const value = String(p.default).trim();
      const problem = problemWith(param, value);
      if (problem) errors.push({ field: `${field}.default`, message: problem });
      param.default = value;
    }
    return param;
  });

  const used = queryParameters(sql);
  if (used.positional) errors.push({ field: 'sql', message: 'use named parameters (:name), not ? — values are matched by name' });
  for (const other of used.otherStyle) errors.push({ field: 'sql', message: `write :${other.slice(1)}, not ${other} — parameters are named with a colon` });
  for (const name of used.names) if (!seen.has(name)) errors.push({ field: 'params', message: `the SQL uses :${name} — declare it` });
  for (const p of params) if (p.name && !used.names.includes(p.name)) errors.push({ field: 'params', message: `:${p.name} is declared but the SQL never uses it` });

  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return params;
}

/**
 * Check values given for a report's parameters — to store on a schedule or a
 * chart, relative dates kept relative. A value left out takes the default
 * when the report runs.
 */
export function validateParamValues(defs: readonly ReportParam[], raw: unknown, field = 'params'): ParamValues {
  const given = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const errors: FieldError[] = [];
  const out: ParamValues = {};
  for (const key of Object.keys(given)) if (!defs.some((d) => d.name === key)) errors.push({ field: `${field}.${key}`, message: 'this report has no such parameter' });
  for (const def of defs) {
    const v = given[def.name];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    const value = String(v).trim();
    const problem = problemWith(def, value);
    if (problem) errors.push({ field: `${field}.${def.name}`, message: `${def.label} ${problem}` });
    else out[def.name] = value;
  }
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return out;
}

/**
 * The values to bind for one run: given values over defaults, relative dates
 * resolved, numbers as numbers. A required parameter with no value is a 422
 * naming it. An optional one with none binds NULL — write the SQL for it
 * (`:region IS NULL OR region = :region`).
 */
export function resolveParams(defs: readonly ReportParam[], raw: unknown, now: number, tz: string, field = 'params'): Record<string, string | number | null> {
  const given = validateParamValues(defs, raw, field);
  const errors: FieldError[] = [];
  const bound: Record<string, string | number | null> = {};
  for (const def of defs) {
    const value = given[def.name] ?? def.default;
    if (value === null || value === undefined) {
      if (def.required) errors.push({ field: `${field}.${def.name}`, message: `${def.label} is required` });
      bound[def.name] = null;
      continue;
    }
    if (def.type === 'number') bound[def.name] = Number(value);
    else if (def.type === 'date') bound[def.name] = isRelativeDate(value) ? resolveRelativeDate(value, now, tz) : value;
    else bound[def.name] = value;
  }
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return bound;
}

export function parseParamDefs(json: string | null | undefined): ReportParam[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as ReportParam[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseParamValues(json: string | null | undefined): ParamValues {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as ParamValues;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
