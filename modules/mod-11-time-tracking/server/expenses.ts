import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import {
  COUNTRY_RATE_KINDS,
  EXPENSE_CATEGORIES,
  PER_DIEM_MODES,
  RATE_KINDS,
  RATE_LABELS,
  VEHICLES,
  localDateOf,
  mileageCents,
  mileageKind,
  nightsSpanned,
  perDiemLines,
  tripPeriods,
  twelfths,
  type ExpenseCategory,
  type PerDiemMode,
  type RateKind,
  type Vehicle,
} from '../shared/expenses.js';
import { parseRksv, rksvVatLines, RksvError } from '../shared/rksv.js';
import { ibanProblem, isValidBic, maskIban, normalizeIban } from '../shared/iban.js';
import type {
  BankAccount,
  ClaimDetail,
  ClaimStatus,
  ClaimTotals,
  ExpenseClaim,
  ExpenseItemType,
  ExpenseMileage,
  ExpenseRate,
  ExpenseReceipt,
  ExpenseSettings,
  ExpenseTrip,
  ItemClaim,
  PayoutMode,
  VatLine,
} from '../shared/expense-types.js';
import type { FieldError } from '../shared/types.js';
import type { ExpenseClaimTransfer, ExpenseTransferLine } from '../shared/expense-transfer.js';
import { EXPENSE_TRANSFER_VERSION } from '../shared/expense-transfer.js';
import { escapeCell } from './csv.js';
import { mayActFor, mayDecide, type Viewer } from './leave.js';
import { employeeOf } from './ownership.js';
import { readTimerSettings, validTimezone } from './timer.js';
import { DomainError, nowIso } from './tracking.js';

/**
 * Expenses — business trips, mileage and receipts, claimed and decided.
 *
 * Next to the time recorded here because it is the same trip: the people,
 * the projects, the office that approves the week and decides leave. Austrian
 * law for now (shared/expenses.ts has the arithmetic and its sources).
 *
 * - **Derived, never stored.** A trip's per diem comes from its times, its
 *   meals and the rate in force on its first day; mileage from kilometres
 *   and vehicle; a claim's total from its items. Rates are versioned rows
 *   (append-only; the newest row for a date wins). A claim fixes how it is
 *   priced when it is submitted — the rates known then (`rates_known`, the
 *   highest rate id), the per diem mode and the time zone — so a correction
 *   to a rate never re-prices what was asked for, decided or paid.
 * - **Claimed items are locked.** An item in a claim that is submitted,
 *   approved or paid cannot change or go. A rejected or withdrawn claim
 *   releases its items for correcting and claiming again; the claim keeps
 *   the list, and its events keep the totals.
 * - **Who may do what** is one named function each: `maySeeExpensesOf` (own,
 *   or `manage` — where someone travelled and what they ate is theirs and the
 *   office's), `mayActFor` and `mayDecide` from leave.ts — nobody approves
 *   their own claim, whatever their level.
 * - **One receipt, one claim.** The Austrian till code names its till and its
 *   receipt number; that pair is unique across everyone, so the same receipt
 *   is not claimed twice, by one person or by two.
 */

// ── Settings ────────────────────────────────────────────────────────────

export const DEFAULT_EXPENSE_SETTINGS: ExpenseSettings = {
  payout_mode: 'payroll',
  per_diem_mode: '24h',
  file_required_from_cents: 0,
  notify_employee: true,
  notify_on_submit: [],
  channel: 'transactional-email',
};

export function readExpenseSettings(db: Database.Database): ExpenseSettings {
  const row = db.prepare('SELECT settings FROM expense_settings WHERE id = 1').get() as { settings: string } | undefined;
  return row ? { ...DEFAULT_EXPENSE_SETTINGS, ...(JSON.parse(row.settings) as Partial<ExpenseSettings>) } : { ...DEFAULT_EXPENSE_SETTINGS };
}

export function expenseSettingsStamp(db: Database.Database): { updated_at: string | null; updated_by: string | null } {
  const row = db.prepare('SELECT updated_at, updated_by FROM expense_settings WHERE id = 1').get() as
    | { updated_at: string; updated_by: string }
    | undefined;
  return { updated_at: row?.updated_at ?? null, updated_by: row?.updated_by ?? null };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateExpenseSettings(input: Record<string, unknown>): ExpenseSettings {
  const d = DEFAULT_EXPENSE_SETTINGS;
  const errors: FieldError[] = [];
  const payout = input.payout_mode ?? d.payout_mode;
  if (payout !== 'payroll' && payout !== 'invoicing') errors.push({ field: 'payout_mode', message: 'payout_mode is payroll or invoicing' });
  const mode = input.per_diem_mode ?? d.per_diem_mode;
  if (!(PER_DIEM_MODES as readonly unknown[]).includes(mode)) errors.push({ field: 'per_diem_mode', message: 'per_diem_mode is 24h or calendar' });
  const threshold = 'file_required_from_cents' in input ? input.file_required_from_cents : d.file_required_from_cents;
  if (threshold !== null && (!Number.isInteger(threshold) || (threshold as number) < 0 || (threshold as number) > 10_000_000)) {
    errors.push({ field: 'file_required_from_cents', message: 'file_required_from_cents is an amount in cents, or null for never' });
  }
  const notify = input.notify_employee ?? d.notify_employee;
  if (typeof notify !== 'boolean') errors.push({ field: 'notify_employee', message: 'notify_employee is true or false' });
  const rawList = input.notify_on_submit ?? d.notify_on_submit;
  const list: string[] = [];
  if (!Array.isArray(rawList) || rawList.length > 10) errors.push({ field: 'notify_on_submit', message: 'notify_on_submit is a list of up to 10 email addresses' });
  else {
    rawList.forEach((e: unknown, i) => {
      const v = typeof e === 'string' ? e.trim() : '';
      if (!EMAIL_RE.test(v) || v.length > 200) errors.push({ field: `notify_on_submit[${i}]`, message: 'an email address' });
      else if (!list.includes(v.toLowerCase())) list.push(v.toLowerCase());
    });
  }
  const channel = typeof input.channel === 'string' ? input.channel.trim() : d.channel;
  if (channel === '' || channel.length > 80) errors.push({ field: 'channel', message: 'channel is the PS-03 channel name (max 80 characters)' });
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return {
    payout_mode: payout as PayoutMode,
    per_diem_mode: mode as PerDiemMode,
    file_required_from_cents: threshold as number | null,
    notify_employee: notify as boolean,
    notify_on_submit: list,
    channel,
  };
}

export function writeExpenseSettings(db: Database.Database, settings: ExpenseSettings, actor: string): void {
  db.prepare(
    `INSERT INTO expense_settings (id, settings, updated_at, updated_by) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(JSON.stringify(settings), nowIso(), actor);
}

// ── Who may see whose ───────────────────────────────────────────────────

/**
 * May `actor` see `employeeId`'s expenses? Their own, and `manage`. Where a
 * person travelled, what they ate and which account they are paid to is not
 * for colleagues with `view`.
 */
export function maySeeExpensesOf(db: Database.Database, actor: string, access: AccessLevel, employeeId: number): boolean {
  return access === 'manage' || employeeOf(db, actor) === employeeId;
}

function assertMayActFor(db: Database.Database, viewer: Viewer, employeeId: number): void {
  if (mayActFor(db, viewer.actor, viewer.access, employeeId)) return;
  throw new DomainError(
    403,
    employeeOf(db, viewer.actor) === null ? `No employee record carries ${viewer.actor} — ask a manager to add your email to it` : 'You can only record your own expenses',
  );
}

/** The employee a request is about: given, or the signed-in person's own record. */
export function subjectOf(db: Database.Database, viewer: Viewer, raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') {
    const own = employeeOf(db, viewer.actor);
    if (own === null) throw new DomainError(403, `No employee record carries ${viewer.actor} — ask a manager to add your email to it`);
    return own;
  }
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new DomainError(422, 'Validation failed', [{ field: 'employee_id', message: 'employee_id must be a positive integer id' }]);
  return id;
}

function employeeRow(db: Database.Database, id: number): { id: number; name: string; email: string | null } {
  const row = db.prepare('SELECT id, name, email FROM employees WHERE id = ?').get(id) as { id: number; name: string; email: string | null } | undefined;
  if (!row) throw new DomainError(404, 'Employee not found');
  return row;
}

// ── Rates ───────────────────────────────────────────────────────────────

/** How an item is priced: live, or as the claim holding it fixed it. */
export interface Pricing {
  /** Only rate rows up to this id count; null: every row. */
  known: number | null;
  mode: PerDiemMode;
  tz: string;
}

export function livePricing(db: Database.Database): Pricing {
  return { known: null, mode: readExpenseSettings(db).per_diem_mode, tz: readTimerSettings(db).timezone };
}

/** The rate in force on `date`: the latest valid_from on or before it, the newest row among equals. */
export function rateOn(db: Database.Database, kind: RateKind, country: string | null, date: string, known: number | null): number | null {
  const row = db
    .prepare(
      `SELECT amount_cents FROM expense_rates WHERE kind = ? AND country IS ? AND valid_from <= ? AND (? IS NULL OR id <= ?)
       ORDER BY valid_from DESC, id DESC LIMIT 1`,
    )
    .get(kind, country, date, known, known) as { amount_cents: number } | undefined;
  return row?.amount_cents ?? null;
}

interface RateStored {
  id: number;
  kind: RateKind;
  country: string | null;
  valid_from: string;
  amount_cents: number;
  basis: string | null;
  preset: string | null;
  actor: string;
  created_at: string;
}

const toRate = (r: RateStored): ExpenseRate => ({ ...r, preset: r.preset !== null });

/** Every rate row, newest first per kind — the history, nothing dropped. */
export function listRates(db: Database.Database, filter: { kind?: string; country?: string } = {}): ExpenseRate[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.kind) {
    clauses.push('kind = ?');
    params.push(filter.kind);
  }
  if (filter.country) {
    clauses.push('country = ?');
    params.push(filter.country);
  }
  return (
    db
      .prepare(`SELECT * FROM expense_rates ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY kind, country, valid_from DESC, id DESC`)
      .all(...params) as RateStored[]
  ).map(toRate);
}

/** The domestic rates in force on a day, and every country's day and night rate. */
export function ratesInForce(db: Database.Database, date: string): {
  date: string;
  domestic: { kind: RateKind; label: string; amount_cents: number | null }[];
  countries: { country: string; day_cents: number | null; night_cents: number | null }[];
} {
  const domestic = RATE_KINDS.filter((k) => !COUNTRY_RATE_KINDS.includes(k)).map((kind) => ({ kind, label: RATE_LABELS[kind], amount_cents: rateOn(db, kind, null, date, null) }));
  const names = (db.prepare('SELECT DISTINCT country FROM expense_rates WHERE country IS NOT NULL ORDER BY country').all() as { country: string }[]).map((r) => r.country);
  return {
    date,
    domestic,
    countries: names.map((country) => ({
      country,
      day_cents: rateOn(db, 'per_diem_abroad', country, date, null),
      night_cents: rateOn(db, 'night_abroad', country, date, null),
    })),
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

export function addRate(db: Database.Database, input: Record<string, unknown>, actor: string): ExpenseRate {
  const errors: FieldError[] = [];
  const kind = input.kind as RateKind;
  if (!(RATE_KINDS as readonly unknown[]).includes(kind)) errors.push({ field: 'kind', message: `kind is one of: ${RATE_KINDS.join(', ')}` });
  const perCountry = COUNTRY_RATE_KINDS.includes(kind);
  const country = typeof input.country === 'string' ? input.country.trim() : '';
  if (perCountry && (country === '' || country.length > 80)) errors.push({ field: 'country', message: 'A foreign rate names its country (max 80 characters)' });
  if (!perCountry && country !== '') errors.push({ field: 'country', message: 'Only a foreign rate names a country' });
  if (!validDate(input.valid_from)) errors.push({ field: 'valid_from', message: 'valid_from must be a date in YYYY-MM-DD format' });
  const amount = input.amount_cents;
  if (!Number.isInteger(amount) || (amount as number) < 0 || (amount as number) > 100_000) {
    errors.push({ field: 'amount_cents', message: 'amount_cents is a whole number of cents from 0 to 100000' });
  }
  const basis = typeof input.basis === 'string' && input.basis.trim() !== '' ? input.basis.trim() : null;
  if (basis !== null && basis.length > 200) errors.push({ field: 'basis', message: 'basis is at most 200 characters' });
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  const info = db
    .prepare('INSERT INTO expense_rates (kind, country, valid_from, amount_cents, basis, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(kind, perCountry ? country : null, input.valid_from, amount, basis, actor, nowIso());
  return toRate(db.prepare('SELECT * FROM expense_rates WHERE id = ?').get(info.lastInsertRowid) as RateStored);
}

function knownCountry(db: Database.Database, country: string): boolean {
  return db.prepare("SELECT 1 FROM expense_rates WHERE kind = 'per_diem_abroad' AND country = ? LIMIT 1").get(country) !== undefined;
}

// ── Which claim holds an item ───────────────────────────────────────────

interface ClaimStored {
  id: number;
  number: string;
  employee_id: number;
  client_id: string | null;
  title: string;
  status: ClaimStatus;
  submitted_by: string;
  submitted_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  rates_known: number;
  per_diem_mode: PerDiemMode;
  timezone: string;
  payout_mode: PayoutMode | null;
  handed_over_ref: string | null;
  paid_at: string | null;
  paid_ref: string | null;
}

const HOLDING = "('submitted', 'approved', 'paid')";

function holdingClaim(db: Database.Database, type: ExpenseItemType, id: number): ClaimStored | null {
  return (
    (db
      .prepare(
        `SELECT c.* FROM expense_claim_items i JOIN expense_claims c ON c.id = i.claim_id
         WHERE i.item_type = ? AND i.item_id = ? AND c.status IN ${HOLDING} LIMIT 1`,
      )
      .get(type, id) as ClaimStored | undefined) ?? null
  );
}

const pricingOf = (claim: ClaimStored): Pricing => ({ known: claim.rates_known, mode: claim.per_diem_mode, tz: claim.timezone });

function itemClaim(db: Database.Database, type: ExpenseItemType, id: number): ItemClaim & { pricing: Pricing | null } {
  const claim = holdingClaim(db, type, id);
  return { locked: claim !== null, claim_number: claim?.number ?? null, pricing: claim ? pricingOf(claim) : null };
}

function assertUnlocked(db: Database.Database, type: ExpenseItemType, id: number): void {
  const claim = holdingClaim(db, type, id);
  if (claim) throw new DomainError(409, `This is part of claim ${claim.number} (${claim.status}) and cannot change`);
}

function assertNeverClaimed(db: Database.Database, type: ExpenseItemType, id: number): void {
  assertUnlocked(db, type, id);
  const row = db
    .prepare('SELECT c.number FROM expense_claim_items i JOIN expense_claims c ON c.id = i.claim_id WHERE i.item_type = ? AND i.item_id = ? LIMIT 1')
    .get(type, id) as { number: string } | undefined;
  if (row) throw new DomainError(409, `This was part of claim ${row.number} and stays on record — correct it instead`);
}

// ── Shared field checks ─────────────────────────────────────────────────

const LOCAL_RE = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d$/;
const validLocal = (v: unknown): v is string => typeof v === 'string' && LOCAL_RE.test(v) && validDate(v.slice(0, 10));

function text(input: Record<string, unknown>, field: string, errors: FieldError[], max: number, required: boolean): string | null {
  const raw = input[field];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (required) errors.push({ field, message: `${field} is required` });
    return null;
  }
  if (typeof raw !== 'string') {
    errors.push({ field, message: `${field} must be text` });
    return null;
  }
  const v = raw.trim();
  if (v.length > max) errors.push({ field, message: `${field} must be at most ${max} characters` });
  return v;
}

function clientId(input: Record<string, unknown>, errors: FieldError[]): string | null {
  const raw = input.client_id;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(raw)) {
    errors.push({ field: 'client_id', message: 'client_id is 8 to 64 letters, digits or dashes (the app mints a UUID)' });
    return null;
  }
  return raw;
}

function optId(input: Record<string, unknown>, field: string, errors: FieldError[]): number | null {
  const raw = input[field];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    errors.push({ field, message: `${field} must be a positive integer id` });
    return null;
  }
  return n;
}

function checkProject(db: Database.Database, projectId: number | null, errors: FieldError[]): void {
  if (projectId !== null && db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId) === undefined) {
    errors.push({ field: 'project_id', message: 'No such project' });
  }
}

function checkTrip(db: Database.Database, tripId: number | null, employeeId: number, errors: FieldError[]): void {
  if (tripId === null) return;
  const row = db.prepare('SELECT employee_id FROM expense_trips WHERE id = ?').get(tripId) as { employee_id: number } | undefined;
  if (!row || row.employee_id !== employeeId) errors.push({ field: 'trip_id', message: 'No such trip of this person' });
}

/** The local date where the office is — receipts from the future are typos. */
function localToday(db: Database.Database, now: number): string {
  return localDateOf(now, readTimerSettings(db).timezone);
}

const rateProblem = (kind: RateKind, country: string | null, date: string): string =>
  `No ${country ? `${RATE_LABELS[kind].toLowerCase()} for ${country}` : RATE_LABELS[kind].toLowerCase()} is in force on ${date} — the office enters it under Settings → Rates`;

// ── Trips ───────────────────────────────────────────────────────────────

interface TripStored {
  id: number;
  employee_id: number;
  client_id: string | null;
  purpose: string;
  destination: string;
  country: string | null;
  start_local: string;
  end_local: string;
  border_out: string | null;
  border_in: string | null;
  meals: string;
  nights_flat: number;
  project_id: number | null;
  note: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Priced as the claim holding it fixed, or live. */
function toTrip(db: Database.Database, row: TripStored, fixed?: Pricing): ExpenseTrip {
  const hold = itemClaim(db, 'trip', row.id);
  const pricing = fixed ?? hold.pricing ?? livePricing(db);
  const date = row.start_local.slice(0, 10);
  const problems: string[] = [];
  const need = (kind: RateKind, country: string | null): number => {
    const rate = rateOn(db, kind, country, date, pricing.known);
    if (rate === null) problems.push(rateProblem(kind, country, date));
    return rate ?? 0;
  };
  const meals = JSON.parse(row.meals) as number[];
  const periods = tripPeriods(
    { start: row.start_local, end: row.end_local, border_out: row.border_out, border_in: row.border_in, abroad: row.country !== null },
    pricing.mode,
    pricing.tz,
  );
  const earnsDomestic = periods.some((p) => !p.abroad && twelfths(p.minutes) > 0);
  const earnsAbroad = periods.some((p) => p.abroad && twelfths(p.minutes) > 0);
  const lines = perDiemLines(
    periods,
    {
      domestic_day_cents: earnsDomestic ? need('per_diem_domestic', null) : 0,
      meal_reduction_cents: earnsDomestic && meals.some((m, i) => m > 0 && periods[i] && !periods[i]!.abroad) ? need('meal_reduction_domestic', null) : 0,
      foreign_day_cents: earnsAbroad ? need('per_diem_abroad', row.country) : null,
    },
    meals,
  );
  const nightKind: RateKind = row.country ? 'night_abroad' : 'night_domestic';
  const nightRate = row.nights_flat > 0 ? need(nightKind, row.country) : (rateOn(db, nightKind, row.country, date, pricing.known) ?? 0);
  const perDiem = lines.reduce((a, l) => a + l.amount_cents, 0);
  const nights = row.nights_flat * nightRate;
  return {
    id: row.id,
    employee_id: row.employee_id,
    employee_name: employeeRow(db, row.employee_id).name,
    client_id: row.client_id,
    purpose: row.purpose,
    destination: row.destination,
    country: row.country,
    start_local: row.start_local,
    end_local: row.end_local,
    border_out: row.border_out,
    border_in: row.border_in,
    meals,
    nights_flat: row.nights_flat,
    nights_max: nightsSpanned(row.start_local, row.end_local),
    project_id: row.project_id,
    note: row.note,
    periods: lines,
    per_diem_cents: perDiem,
    night_rate_cents: nightRate,
    nights_cents: nights,
    total_cents: perDiem + nights,
    rate_problem: problems[0] ?? null,
    locked: hold.locked,
    claim_number: hold.claim_number,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function tripRow(db: Database.Database, id: number): TripStored {
  const row = db.prepare('SELECT * FROM expense_trips WHERE id = ?').get(id) as TripStored | undefined;
  if (!row) throw new DomainError(404, 'Trip not found');
  return row;
}

/** A trip may run for up to this long: a posting is not a business trip. */
const MAX_TRIP_DAYS = 90;

interface TripFields {
  purpose: string;
  destination: string;
  country: string | null;
  start_local: string;
  end_local: string;
  border_out: string | null;
  border_in: string | null;
  meals: number[];
  nights_flat: number;
  project_id: number | null;
  note: string | null;
}

function validateTrip(db: Database.Database, input: Record<string, unknown>, pricing: Pricing): TripFields {
  const errors: FieldError[] = [];
  const purpose = text(input, 'purpose', errors, 200, true);
  const destination = text(input, 'destination', errors, 160, true);
  const country = text(input, 'country', errors, 80, false);
  if (country !== null && !knownCountry(db, country)) errors.push({ field: 'country', message: `No foreign rate is kept for "${country}" — pick a country from the list, or the office adds it` });
  const start = input.start_local;
  const end = input.end_local;
  if (!validLocal(start)) errors.push({ field: 'start_local', message: 'start_local is a local date and time, YYYY-MM-DDTHH:MM' });
  if (!validLocal(end)) errors.push({ field: 'end_local', message: 'end_local is a local date and time, YYYY-MM-DDTHH:MM' });
  const borderOut = input.border_out === undefined || input.border_out === null || input.border_out === '' ? null : input.border_out;
  const borderIn = input.border_in === undefined || input.border_in === null || input.border_in === '' ? null : input.border_in;
  if (borderOut !== null && !validLocal(borderOut)) errors.push({ field: 'border_out', message: 'border_out is a local date and time, YYYY-MM-DDTHH:MM' });
  if (borderIn !== null && !validLocal(borderIn)) errors.push({ field: 'border_in', message: 'border_in is a local date and time, YYYY-MM-DDTHH:MM' });
  if (validLocal(start) && validLocal(end)) {
    if (end <= start) errors.push({ field: 'end_local', message: 'The trip ends before it starts' });
    else if (nightsSpanned(start, end) > MAX_TRIP_DAYS) errors.push({ field: 'end_local', message: `A trip runs for at most ${MAX_TRIP_DAYS} days` });
    if (country === null && (borderOut !== null || borderIn !== null)) errors.push({ field: 'border_out', message: 'Border crossings belong to a trip abroad' });
    if ((borderOut === null) !== (borderIn === null)) errors.push({ field: borderOut === null ? 'border_out' : 'border_in', message: 'Give both border crossings, or neither' });
    if (validLocal(borderOut) && validLocal(borderIn)) {
      if (!(start <= borderOut && borderOut < borderIn && borderIn <= end)) {
        errors.push({ field: 'border_in', message: 'The border crossings lie within the trip: out after leaving, back before returning' });
      }
    }
  }
  const rawMeals = input.meals ?? [];
  const meals: number[] = [];
  if (!Array.isArray(rawMeals) || rawMeals.length > 400 || rawMeals.some((m) => !Number.isInteger(m) || m < 0 || m > 2)) {
    errors.push({ field: 'meals', message: 'meals is a list of 0, 1 or 2 per period: the paid lunches and dinners' });
  } else meals.push(...(rawMeals as number[]));
  const nightsFlat = input.nights_flat ?? 0;
  if (!Number.isInteger(nightsFlat) || (nightsFlat as number) < 0) errors.push({ field: 'nights_flat', message: 'nights_flat is a whole number of nights' });
  const projectId = optId(input, 'project_id', errors);
  checkProject(db, projectId, errors);
  const note = text(input, 'note', errors, 500, false);
  if (errors.length === 0) {
    const periods = tripPeriods(
      { start: start as string, end: end as string, border_out: borderOut as string | null, border_in: borderIn as string | null, abroad: country !== null },
      pricing.mode,
      pricing.tz,
    );
    while (meals.length > 0 && meals[meals.length - 1] === 0) meals.pop();
    if (meals.length > periods.length) errors.push({ field: 'meals', message: `The trip has ${periods.length} period(s); meals were given for ${meals.length}` });
    const max = nightsSpanned(start as string, end as string);
    if ((nightsFlat as number) > max) errors.push({ field: 'nights_flat', message: `The trip spans ${max} night(s)` });
  }
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return {
    purpose: purpose!,
    destination: destination!,
    country,
    start_local: start as string,
    end_local: end as string,
    border_out: borderOut as string | null,
    border_in: borderIn as string | null,
    meals,
    nights_flat: nightsFlat as number,
    project_id: projectId,
    note,
  };
}

export interface ItemFilter {
  employeeId?: number;
  /** Only items free to be claimed. */
  open?: boolean;
}

function visibleEmployees(db: Database.Database, viewer: Viewer, filter: ItemFilter): number[] | null {
  if (viewer.access === 'manage') return filter.employeeId !== undefined ? [filter.employeeId] : null;
  const own = employeeOf(db, viewer.actor);
  if (own === null) return [];
  if (filter.employeeId !== undefined && filter.employeeId !== own) throw new DomainError(403, 'You can only see your own expenses');
  return [own];
}

function listRows<T extends { id: number; employee_id: number }>(db: Database.Database, table: string, order: string, viewer: Viewer, filter: ItemFilter): T[] {
  const ids = visibleEmployees(db, viewer, filter);
  if (ids !== null && ids.length === 0) return [];
  return db
    .prepare(`SELECT * FROM ${table} ${ids ? `WHERE employee_id IN (${ids.map(() => '?').join(',')})` : ''} ORDER BY ${order}`)
    .all(...(ids ?? [])) as T[];
}

export function listTrips(db: Database.Database, viewer: Viewer, filter: ItemFilter = {}): ExpenseTrip[] {
  const out = listRows<TripStored>(db, 'expense_trips', 'start_local DESC, id DESC', viewer, filter).map((r) => toTrip(db, r));
  return filter.open ? out.filter((t) => !t.locked) : out;
}

function assertMaySee(db: Database.Database, viewer: Viewer, employeeId: number, what: string): void {
  // Someone else's item answers like no item at all.
  if (!maySeeExpensesOf(db, viewer.actor, viewer.access, employeeId)) throw new DomainError(404, `${what} not found`);
}

export function getTrip(db: Database.Database, id: number, viewer: Viewer): ExpenseTrip {
  const row = tripRow(db, id);
  assertMaySee(db, viewer, row.employee_id, 'Trip');
  return toTrip(db, row);
}

export function createTrip(db: Database.Database, input: Record<string, unknown>, viewer: Viewer): { trip: ExpenseTrip; created: boolean } {
  return db.transaction(() => {
    const employeeId = subjectOf(db, viewer, input.employee_id);
    employeeRow(db, employeeId);
    assertMayActFor(db, viewer, employeeId);
    const errors: FieldError[] = [];
    const cid = clientId(input, errors);
    if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
    if (cid !== null) {
      const existing = db.prepare('SELECT * FROM expense_trips WHERE employee_id = ? AND client_id = ?').get(employeeId, cid) as TripStored | undefined;
      if (existing) return { trip: toTrip(db, existing), created: false };
    }
    const f = validateTrip(db, input, livePricing(db));
    const at = nowIso();
    const info = db
      .prepare(
        `INSERT INTO expense_trips (employee_id, client_id, purpose, destination, country, start_local, end_local, border_out, border_in, meals, nights_flat, project_id, note, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(employeeId, cid, f.purpose, f.destination, f.country, f.start_local, f.end_local, f.border_out, f.border_in, JSON.stringify(f.meals), f.nights_flat, f.project_id, f.note, viewer.actor, at, at);
    return { trip: toTrip(db, tripRow(db, Number(info.lastInsertRowid))), created: true };
  })();
}

export function updateTrip(db: Database.Database, id: number, input: Record<string, unknown>, viewer: Viewer): ExpenseTrip {
  return db.transaction(() => {
    const row = tripRow(db, id);
    assertMaySee(db, viewer, row.employee_id, 'Trip');
    assertMayActFor(db, viewer, row.employee_id);
    assertUnlocked(db, 'trip', id);
    const f = validateTrip(db, { ...row, meals: JSON.parse(row.meals), ...input }, livePricing(db));
    db.prepare(
      `UPDATE expense_trips SET purpose = ?, destination = ?, country = ?, start_local = ?, end_local = ?, border_out = ?, border_in = ?, meals = ?, nights_flat = ?, project_id = ?, note = ?, updated_at = ? WHERE id = ?`,
    ).run(f.purpose, f.destination, f.country, f.start_local, f.end_local, f.border_out, f.border_in, JSON.stringify(f.meals), f.nights_flat, f.project_id, f.note, nowIso(), id);
    return toTrip(db, tripRow(db, id));
  })();
}

export function deleteTrip(db: Database.Database, id: number, viewer: Viewer): void {
  db.transaction(() => {
    const row = tripRow(db, id);
    assertMaySee(db, viewer, row.employee_id, 'Trip');
    assertMayActFor(db, viewer, row.employee_id);
    assertNeverClaimed(db, 'trip', id);
    // Receipts and drives that pointed at it stay; they just no longer say which trip.
    db.prepare('UPDATE expense_receipts SET trip_id = NULL WHERE trip_id = ?').run(id);
    db.prepare('UPDATE expense_mileage SET trip_id = NULL WHERE trip_id = ?').run(id);
    db.prepare('DELETE FROM expense_trips WHERE id = ?').run(id);
  })();
}

// ── Mileage ─────────────────────────────────────────────────────────────

interface MileageStored {
  id: number;
  employee_id: number;
  client_id: string | null;
  trip_id: number | null;
  travel_date: string;
  from_place: string;
  to_place: string;
  purpose: string;
  km_tenths: number;
  vehicle: Vehicle;
  passengers: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function toMileage(db: Database.Database, row: MileageStored, fixed?: Pricing): ExpenseMileage {
  const hold = itemClaim(db, 'mileage', row.id);
  const pricing = fixed ?? hold.pricing ?? livePricing(db);
  const kind = mileageKind(row.vehicle);
  const rate = rateOn(db, kind, null, row.travel_date, pricing.known);
  const passengerRate = row.vehicle === 'car' && row.passengers > 0 ? rateOn(db, 'mileage_passenger', null, row.travel_date, pricing.known) : 0;
  const problem = rate === null ? rateProblem(kind, null, row.travel_date) : passengerRate === null ? rateProblem('mileage_passenger', null, row.travel_date) : null;
  return {
    ...row,
    employee_name: employeeRow(db, row.employee_id).name,
    rate_cents: rate ?? 0,
    passenger_rate_cents: passengerRate ?? 0,
    amount_cents: mileageCents(row.km_tenths, row.vehicle, row.passengers, { vehicle_cents: rate ?? 0, passenger_cents: passengerRate ?? 0 }),
    rate_problem: problem,
    locked: hold.locked,
    claim_number: hold.claim_number,
  };
}

function mileageRow(db: Database.Database, id: number): MileageStored {
  const row = db.prepare('SELECT * FROM expense_mileage WHERE id = ?').get(id) as MileageStored | undefined;
  if (!row) throw new DomainError(404, 'Drive not found');
  return row;
}

function validateMileage(db: Database.Database, input: Record<string, unknown>, employeeId: number, today: string) {
  const errors: FieldError[] = [];
  if (!validDate(input.travel_date)) errors.push({ field: 'travel_date', message: 'travel_date must be a date in YYYY-MM-DD format' });
  else if ((input.travel_date as string) > today) errors.push({ field: 'travel_date', message: 'A drive is recorded once it has happened' });
  const from = text(input, 'from_place', errors, 160, true);
  const to = text(input, 'to_place', errors, 160, true);
  const purpose = text(input, 'purpose', errors, 200, true);
  const km = input.km_tenths;
  if (!Number.isInteger(km) || (km as number) <= 0 || (km as number) > 50_000) errors.push({ field: 'km_tenths', message: 'km_tenths is the distance in tenths of a kilometre, up to 5000 km' });
  const vehicle = input.vehicle ?? 'car';
  if (!(VEHICLES as readonly unknown[]).includes(vehicle)) errors.push({ field: 'vehicle', message: 'vehicle is car, motorbike or bicycle' });
  const passengers = input.passengers ?? 0;
  if (!Number.isInteger(passengers) || (passengers as number) < 0 || (passengers as number) > 8) errors.push({ field: 'passengers', message: 'passengers is 0 to 8' });
  else if (vehicle !== 'car' && (passengers as number) > 0) errors.push({ field: 'passengers', message: 'Only a car carries passengers for the supplement' });
  const tripId = optId(input, 'trip_id', errors);
  checkTrip(db, tripId, employeeId, errors);
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return { travel_date: input.travel_date as string, from_place: from!, to_place: to!, purpose: purpose!, km_tenths: km as number, vehicle: vehicle as Vehicle, passengers: passengers as number, trip_id: tripId };
}

export function listMileage(db: Database.Database, viewer: Viewer, filter: ItemFilter = {}): ExpenseMileage[] {
  const out = listRows<MileageStored>(db, 'expense_mileage', 'travel_date DESC, id DESC', viewer, filter).map((r) => toMileage(db, r));
  return filter.open ? out.filter((m) => !m.locked) : out;
}

export function getMileage(db: Database.Database, id: number, viewer: Viewer): ExpenseMileage {
  const row = mileageRow(db, id);
  assertMaySee(db, viewer, row.employee_id, 'Drive');
  return toMileage(db, row);
}

export function createMileage(db: Database.Database, input: Record<string, unknown>, viewer: Viewer, now = Date.now()): { mileage: ExpenseMileage; created: boolean } {
  return db.transaction(() => {
    const employeeId = subjectOf(db, viewer, input.employee_id);
    employeeRow(db, employeeId);
    assertMayActFor(db, viewer, employeeId);
    const errors: FieldError[] = [];
    const cid = clientId(input, errors);
    if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
    if (cid !== null) {
      const existing = db.prepare('SELECT * FROM expense_mileage WHERE employee_id = ? AND client_id = ?').get(employeeId, cid) as MileageStored | undefined;
      if (existing) return { mileage: toMileage(db, existing), created: false };
    }
    const f = validateMileage(db, input, employeeId, localToday(db, now));
    const at = nowIso();
    const info = db
      .prepare(
        `INSERT INTO expense_mileage (employee_id, client_id, trip_id, travel_date, from_place, to_place, purpose, km_tenths, vehicle, passengers, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(employeeId, cid, f.trip_id, f.travel_date, f.from_place, f.to_place, f.purpose, f.km_tenths, f.vehicle, f.passengers, viewer.actor, at, at);
    return { mileage: toMileage(db, mileageRow(db, Number(info.lastInsertRowid))), created: true };
  })();
}

export function updateMileage(db: Database.Database, id: number, input: Record<string, unknown>, viewer: Viewer, now = Date.now()): ExpenseMileage {
  return db.transaction(() => {
    const row = mileageRow(db, id);
    assertMaySee(db, viewer, row.employee_id, 'Drive');
    assertMayActFor(db, viewer, row.employee_id);
    assertUnlocked(db, 'mileage', id);
    const f = validateMileage(db, { ...row, ...input }, row.employee_id, localToday(db, now));
    db.prepare(
      'UPDATE expense_mileage SET trip_id = ?, travel_date = ?, from_place = ?, to_place = ?, purpose = ?, km_tenths = ?, vehicle = ?, passengers = ?, updated_at = ? WHERE id = ?',
    ).run(f.trip_id, f.travel_date, f.from_place, f.to_place, f.purpose, f.km_tenths, f.vehicle, f.passengers, nowIso(), id);
    return toMileage(db, mileageRow(db, id));
  })();
}

export function deleteMileage(db: Database.Database, id: number, viewer: Viewer): void {
  db.transaction(() => {
    const row = mileageRow(db, id);
    assertMaySee(db, viewer, row.employee_id, 'Drive');
    assertMayActFor(db, viewer, row.employee_id);
    assertNeverClaimed(db, 'mileage', id);
    db.prepare('DELETE FROM expense_mileage WHERE id = ?').run(id);
  })();
}

// ── Receipts ────────────────────────────────────────────────────────────

interface ReceiptStored {
  id: number;
  employee_id: number;
  client_id: string | null;
  trip_id: number | null;
  receipt_date: string;
  merchant: string;
  category: ExpenseCategory;
  description: string | null;
  gross_cents: number;
  vat_lines: string;
  paid_by: 'private' | 'company';
  source: 'manual' | 'rksv';
  rksv_code: string | null;
  rksv_key: string | null;
  project_id: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** net = gross × 10000 ÷ (10000 + rate), per line, rounded — the VAT is what is left. */
export function vatOf(lines: readonly VatLine[]): { net_cents: number; vat_cents: number } {
  let net = 0;
  let gross = 0;
  for (const l of lines) {
    net += Math.round((l.gross_cents * 10_000) / (10_000 + l.rate_bp));
    gross += l.gross_cents;
  }
  return { net_cents: net, vat_cents: gross - net };
}

function toReceipt(db: Database.Database, row: ReceiptStored): ExpenseReceipt {
  const hold = itemClaim(db, 'receipt', row.id);
  const file = db.prepare('SELECT content_type, size_bytes, sha256 FROM expense_files WHERE receipt_id = ?').get(row.id) as
    | { content_type: string; size_bytes: number; sha256: string }
    | undefined;
  const lines = JSON.parse(row.vat_lines) as VatLine[];
  const vat = lines.length > 0 ? vatOf(lines) : null;
  const rksv = row.rksv_code ? parseRksv(row.rksv_code) : null;
  const threshold = readExpenseSettings(db).file_required_from_cents;
  return {
    id: row.id,
    employee_id: row.employee_id,
    employee_name: employeeRow(db, row.employee_id).name,
    client_id: row.client_id,
    trip_id: row.trip_id,
    receipt_date: row.receipt_date,
    merchant: row.merchant,
    category: row.category,
    description: row.description,
    gross_cents: row.gross_cents,
    vat_lines: lines,
    vat_cents: vat?.vat_cents ?? null,
    net_cents: vat?.net_cents ?? null,
    paid_by: row.paid_by,
    reimbursable_cents: row.paid_by === 'private' ? row.gross_cents : 0,
    source: row.source,
    rksv: rksv ? { cashbox_id: rksv.cashbox_id, receipt_id: rksv.receipt_id, issued_at: rksv.issued_at, signature_failed: rksv.signature_failed } : null,
    file: file ?? null,
    file_missing: !file && row.paid_by === 'private' && threshold !== null && row.gross_cents >= threshold,
    project_id: row.project_id,
    locked: hold.locked,
    claim_number: hold.claim_number,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function receiptRow(db: Database.Database, id: number): ReceiptStored {
  const row = db.prepare('SELECT * FROM expense_receipts WHERE id = ?').get(id) as ReceiptStored | undefined;
  if (!row) throw new DomainError(404, 'Receipt not found');
  return row;
}

interface ReceiptFields {
  trip_id: number | null;
  receipt_date: string;
  merchant: string;
  category: ExpenseCategory;
  description: string | null;
  gross_cents: number;
  vat_lines: VatLine[];
  paid_by: 'private' | 'company';
  source: 'manual' | 'rksv';
  rksv_code: string | null;
  rksv_key: string | null;
  project_id: number | null;
}

function validateReceipt(db: Database.Database, input: Record<string, unknown>, employeeId: number, today: string): ReceiptFields {
  const errors: FieldError[] = [];
  const merchant = text(input, 'merchant', errors, 160, true);
  const category = input.category ?? 'other';
  if (!(EXPENSE_CATEGORIES as readonly unknown[]).includes(category)) errors.push({ field: 'category', message: `category is one of: ${EXPENSE_CATEGORIES.join(', ')}` });
  const description = text(input, 'description', errors, 300, false);
  const paidBy = input.paid_by ?? 'private';
  if (paidBy !== 'private' && paidBy !== 'company') errors.push({ field: 'paid_by', message: 'paid_by is private or company (a company card: documented, not refunded)' });
  const tripId = optId(input, 'trip_id', errors);
  checkTrip(db, tripId, employeeId, errors);
  const projectId = optId(input, 'project_id', errors);
  checkProject(db, projectId, errors);

  let receiptDate = input.receipt_date as string;
  let gross = input.gross_cents as number;
  let vatLines: VatLine[] = [];
  let source: ReceiptFields['source'] = 'manual';
  let code: string | null = null;
  let key: string | null = null;

  const rawCode = typeof input.rksv_code === 'string' ? input.rksv_code.trim() : '';
  if (rawCode !== '') {
    // The till code is the receipt's own statement of what was paid: the
    // server reads it again rather than trusting what the app made of it.
    if (rawCode.length > 1000) errors.push({ field: 'rksv_code', message: 'This is too long to be a receipt code' });
    else {
      try {
        const parsed = parseRksv(rawCode);
        if (parsed.kind !== 'sale') errors.push({ field: 'rksv_code', message: parsed.kind === 'training' ? 'A training receipt is not a purchase' : 'A cancellation receipt is not a purchase' });
        else if (parsed.total_cents <= 0) errors.push({ field: 'rksv_code', message: 'This receipt pays nothing out — a refund is not an expense' });
        let special: 1900 | 490 | undefined;
        if (parsed.special_rate_ambiguous) {
          if (input.special_rate_bp !== 1900 && input.special_rate_bp !== 490) {
            errors.push({ field: 'special_rate_bp', message: 'From July 2026 the receipt\'s special-rate amount is 4,9 % or 19 % — say which (490 or 1900)' });
          } else special = input.special_rate_bp;
        }
        receiptDate = parsed.issued_at.slice(0, 10);
        gross = parsed.total_cents;
        vatLines = rksvVatLines(parsed, special ?? 1900);
        source = 'rksv';
        code = rawCode;
        key = `${parsed.suite}_${parsed.cashbox_id}_${parsed.receipt_id}`;
      } catch (err) {
        if (!(err instanceof RksvError)) throw err;
        errors.push({ field: 'rksv_code', message: err.message });
      }
    }
  } else {
    const rawLines = input.vat_lines ?? [];
    if (!Array.isArray(rawLines) || rawLines.length > 6) errors.push({ field: 'vat_lines', message: 'vat_lines is a list of up to 6 rates with their gross amounts' });
    else {
      rawLines.forEach((l: { rate_bp?: unknown; gross_cents?: unknown }, i) => {
        if (!Number.isInteger(l?.rate_bp) || (l.rate_bp as number) < 0 || (l.rate_bp as number) > 3000) errors.push({ field: `vat_lines[${i}].rate_bp`, message: 'rate_bp is the rate in basis points (2000 = 20 %)' });
        else if (!Number.isInteger(l?.gross_cents) || Math.abs(l.gross_cents as number) > 10_000_000) errors.push({ field: `vat_lines[${i}].gross_cents`, message: 'gross_cents is a whole number of cents' });
        else vatLines.push({ rate_bp: l.rate_bp as number, gross_cents: l.gross_cents as number });
      });
    }
  }
  if (!validDate(receiptDate)) errors.push({ field: 'receipt_date', message: 'receipt_date must be a date in YYYY-MM-DD format' });
  else if (receiptDate > today) errors.push({ field: 'receipt_date', message: 'A receipt is dated on or before today' });
  if (!Number.isInteger(gross) || gross <= 0 || gross > 10_000_000) errors.push({ field: 'gross_cents', message: 'gross_cents is the amount paid, in cents (up to 100.000 €)' });
  else if (vatLines.length > 0 && vatLines.reduce((a, l) => a + l.gross_cents, 0) !== gross) {
    errors.push({ field: 'vat_lines', message: 'The VAT lines add up to a different amount than the receipt' });
  }
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return {
    trip_id: tripId,
    receipt_date: receiptDate,
    merchant: merchant!,
    category: category as ExpenseCategory,
    description,
    gross_cents: gross,
    vat_lines: vatLines,
    paid_by: paidBy as 'private' | 'company',
    source,
    rksv_code: code,
    rksv_key: key,
    project_id: projectId,
  };
}

function assertNewTillReceipt(db: Database.Database, key: string | null, except: number | null): void {
  if (key === null) return;
  const row = db.prepare('SELECT id FROM expense_receipts WHERE rksv_key = ? AND id IS NOT ?').get(key, except) as { id: number } | undefined;
  // Not who has it: a colleague's receipt is not this person's business.
  if (row) throw new DomainError(409, 'This till receipt is already recorded — the same receipt cannot be claimed twice');
}

export function listReceipts(db: Database.Database, viewer: Viewer, filter: ItemFilter = {}): ExpenseReceipt[] {
  const out = listRows<ReceiptStored>(db, 'expense_receipts', 'receipt_date DESC, id DESC', viewer, filter).map((r) => toReceipt(db, r));
  return filter.open ? out.filter((r) => !r.locked) : out;
}

export function getReceipt(db: Database.Database, id: number, viewer: Viewer): ExpenseReceipt {
  const row = receiptRow(db, id);
  assertMaySee(db, viewer, row.employee_id, 'Receipt');
  return toReceipt(db, row);
}

export function createReceipt(db: Database.Database, input: Record<string, unknown>, viewer: Viewer, now = Date.now()): { receipt: ExpenseReceipt; created: boolean } {
  return db.transaction(() => {
    const employeeId = subjectOf(db, viewer, input.employee_id);
    employeeRow(db, employeeId);
    assertMayActFor(db, viewer, employeeId);
    const errors: FieldError[] = [];
    const cid = clientId(input, errors);
    if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
    if (cid !== null) {
      const existing = db.prepare('SELECT * FROM expense_receipts WHERE employee_id = ? AND client_id = ?').get(employeeId, cid) as ReceiptStored | undefined;
      if (existing) return { receipt: toReceipt(db, existing), created: false };
    }
    const f = validateReceipt(db, input, employeeId, localToday(db, now));
    assertNewTillReceipt(db, f.rksv_key, null);
    const at = nowIso();
    const info = db
      .prepare(
        `INSERT INTO expense_receipts (employee_id, client_id, trip_id, receipt_date, merchant, category, description, gross_cents, vat_lines, paid_by, source, rksv_code, rksv_key, project_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(employeeId, cid, f.trip_id, f.receipt_date, f.merchant, f.category, f.description, f.gross_cents, JSON.stringify(f.vat_lines), f.paid_by, f.source, f.rksv_code, f.rksv_key, f.project_id, viewer.actor, at, at);
    return { receipt: toReceipt(db, receiptRow(db, Number(info.lastInsertRowid))), created: true };
  })();
}

export function updateReceipt(db: Database.Database, id: number, input: Record<string, unknown>, viewer: Viewer, now = Date.now()): ExpenseReceipt {
  return db.transaction(() => {
    const row = receiptRow(db, id);
    assertMaySee(db, viewer, row.employee_id, 'Receipt');
    assertMayActFor(db, viewer, row.employee_id);
    assertUnlocked(db, 'receipt', id);
    const merged: Record<string, unknown> = { ...row, vat_lines: JSON.parse(row.vat_lines), ...input };
    // A receipt read from its till code keeps the code's amounts unless the code itself is replaced or removed.
    const f = validateReceipt(db, merged, row.employee_id, localToday(db, now));
    assertNewTillReceipt(db, f.rksv_key, id);
    db.prepare(
      `UPDATE expense_receipts SET trip_id = ?, receipt_date = ?, merchant = ?, category = ?, description = ?, gross_cents = ?, vat_lines = ?, paid_by = ?, source = ?, rksv_code = ?, rksv_key = ?, project_id = ?, updated_at = ? WHERE id = ?`,
    ).run(f.trip_id, f.receipt_date, f.merchant, f.category, f.description, f.gross_cents, JSON.stringify(f.vat_lines), f.paid_by, f.source, f.rksv_code, f.rksv_key, f.project_id, nowIso(), id);
    return toReceipt(db, receiptRow(db, id));
  })();
}

export function deleteReceipt(db: Database.Database, id: number, viewer: Viewer): void {
  db.transaction(() => {
    const row = receiptRow(db, id);
    assertMaySee(db, viewer, row.employee_id, 'Receipt');
    assertMayActFor(db, viewer, row.employee_id);
    assertNeverClaimed(db, 'receipt', id);
    db.prepare('DELETE FROM expense_receipts WHERE id = ?').run(id);
  })();
}

// ── Receipt pictures ────────────────────────────────────────────────────

export const MAX_RECEIPT_FILE_BYTES = 8 * 1024 * 1024;

/** What the bytes are, by their first bytes — the header the client sent is not evidence. */
export function sniffReceiptFile(data: Buffer): string | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (data.length >= 5 && data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

export function putReceiptFile(db: Database.Database, id: number, data: Buffer, viewer: Viewer): ExpenseReceipt {
  return db.transaction(() => {
    const row = receiptRow(db, id);
    assertMaySee(db, viewer, row.employee_id, 'Receipt');
    assertMayActFor(db, viewer, row.employee_id);
    assertUnlocked(db, 'receipt', id);
    if (data.length === 0) throw new DomainError(422, 'Validation failed', [{ field: 'file', message: 'The file is empty' }]);
    if (data.length > MAX_RECEIPT_FILE_BYTES) throw new DomainError(413, `A receipt picture is at most ${MAX_RECEIPT_FILE_BYTES / 1024 / 1024} MB`);
    const type = sniffReceiptFile(data);
    if (!type) throw new DomainError(415, 'A receipt is a JPEG, PNG or WebP picture, or a PDF');
    const sha = createHash('sha256').update(data).digest('hex');
    db.prepare('DELETE FROM expense_files WHERE receipt_id = ?').run(id);
    db.prepare('INSERT INTO expense_files (receipt_id, content_type, size_bytes, sha256, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      type,
      data.length,
      sha,
      data,
      viewer.actor,
      nowIso(),
    );
    db.prepare('UPDATE expense_receipts SET updated_at = ? WHERE id = ?').run(nowIso(), id);
    return toReceipt(db, receiptRow(db, id));
  })();
}

export function getReceiptFile(db: Database.Database, id: number, viewer: Viewer): { content_type: string; data: Buffer; sha256: string } {
  const row = receiptRow(db, id);
  assertMaySee(db, viewer, row.employee_id, 'Receipt');
  const file = db.prepare('SELECT content_type, data, sha256 FROM expense_files WHERE receipt_id = ?').get(id) as
    | { content_type: string; data: Buffer; sha256: string }
    | undefined;
  if (!file) throw new DomainError(404, 'This receipt has no picture');
  return file;
}

export function deleteReceiptFile(db: Database.Database, id: number, viewer: Viewer): ExpenseReceipt {
  return db.transaction(() => {
    const row = receiptRow(db, id);
    assertMaySee(db, viewer, row.employee_id, 'Receipt');
    assertMayActFor(db, viewer, row.employee_id);
    assertUnlocked(db, 'receipt', id);
    db.prepare('DELETE FROM expense_files WHERE receipt_id = ?').run(id);
    return toReceipt(db, receiptRow(db, id));
  })();
}

// ── Bank account ────────────────────────────────────────────────────────

export function currentBankAccount(db: Database.Database, employeeId: number): BankAccount | null {
  return (
    (db
      .prepare('SELECT holder, iban, bic, actor, created_at FROM expense_bank_accounts WHERE employee_id = ? ORDER BY id DESC LIMIT 1')
      .get(employeeId) as BankAccount | undefined) ?? null
  );
}

export function bankAccountHistory(db: Database.Database, employeeId: number): BankAccount[] {
  return db.prepare('SELECT holder, iban, bic, actor, created_at FROM expense_bank_accounts WHERE employee_id = ? ORDER BY id DESC').all(employeeId) as BankAccount[];
}

export function getBankAccount(db: Database.Database, employeeId: number, viewer: Viewer): { account: BankAccount | null; history: BankAccount[] } {
  employeeRow(db, employeeId);
  if (!maySeeExpensesOf(db, viewer.actor, viewer.access, employeeId)) throw new DomainError(404, 'Employee not found');
  return { account: currentBankAccount(db, employeeId), history: bankAccountHistory(db, employeeId) };
}

/** A new account from now on; the old one stays in the history, with who replaced it. */
export function setBankAccount(db: Database.Database, employeeId: number, input: Record<string, unknown>, viewer: Viewer): BankAccount {
  employeeRow(db, employeeId);
  if (!maySeeExpensesOf(db, viewer.actor, viewer.access, employeeId)) throw new DomainError(404, 'Employee not found');
  assertMayActFor(db, viewer, employeeId);
  const errors: FieldError[] = [];
  const holder = text(input, 'holder', errors, 70, true);
  const raw = typeof input.iban === 'string' ? input.iban : '';
  const problem = ibanProblem(raw);
  if (problem) errors.push({ field: 'iban', message: problem });
  const bicRaw = typeof input.bic === 'string' ? input.bic.replace(/\s+/g, '').toUpperCase() : '';
  if (bicRaw !== '' && !isValidBic(bicRaw)) errors.push({ field: 'bic', message: 'A BIC has 8 or 11 characters' });
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  db.prepare('INSERT INTO expense_bank_accounts (employee_id, holder, iban, bic, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    employeeId,
    holder,
    normalizeIban(raw),
    bicRaw === '' ? null : bicRaw,
    viewer.actor,
    nowIso(),
  );
  return currentBankAccount(db, employeeId)!;
}

// ── Claims ──────────────────────────────────────────────────────────────

function claimRow(db: Database.Database, id: number): ClaimStored {
  const row = db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(id) as ClaimStored | undefined;
  if (!row) throw new DomainError(404, 'Claim not found');
  return row;
}

export function claimByNumber(db: Database.Database, number: string): ClaimStored | null {
  return (db.prepare('SELECT * FROM expense_claims WHERE number = ?').get(number) as ClaimStored | undefined) ?? null;
}

function claimItemIds(db: Database.Database, claimId: number, type: ExpenseItemType): number[] {
  return (db.prepare('SELECT item_id FROM expense_claim_items WHERE claim_id = ? AND item_type = ? ORDER BY item_id').all(claimId, type) as { item_id: number }[]).map(
    (r) => r.item_id,
  );
}

interface ClaimItems {
  trips: ExpenseTrip[];
  mileage: ExpenseMileage[];
  receipts: ExpenseReceipt[];
}

function itemsOf(db: Database.Database, claim: ClaimStored): ClaimItems {
  const pricing = pricingOf(claim);
  return {
    trips: claimItemIds(db, claim.id, 'trip').map((id) => toTrip(db, tripRow(db, id), pricing)),
    mileage: claimItemIds(db, claim.id, 'mileage').map((id) => toMileage(db, mileageRow(db, id), pricing)),
    receipts: claimItemIds(db, claim.id, 'receipt').map((id) => toReceipt(db, receiptRow(db, id))),
  };
}

function totalsOf(items: ClaimItems): ClaimTotals {
  const perDiem = items.trips.reduce((a, t) => a + t.per_diem_cents, 0);
  const nights = items.trips.reduce((a, t) => a + t.nights_cents, 0);
  const mileage = items.mileage.reduce((a, m) => a + m.amount_cents, 0);
  const receipts = items.receipts.reduce((a, r) => a + r.reimbursable_cents, 0);
  return { per_diem_cents: perDiem, nights_cents: nights, mileage_cents: mileage, receipts_cents: receipts, total_cents: perDiem + nights + mileage + receipts };
}

function toClaim(db: Database.Database, row: ClaimStored, viewer: Viewer, items = itemsOf(db, row)): ExpenseClaim {
  return {
    id: row.id,
    number: row.number,
    employee_id: row.employee_id,
    employee_name: employeeRow(db, row.employee_id).name,
    title: row.title,
    status: row.status,
    submitted_by: row.submitted_by,
    submitted_at: row.submitted_at,
    decided_by: row.decided_by,
    decided_at: row.decided_at,
    decision_note: row.decision_note,
    per_diem_mode: row.per_diem_mode,
    payout_mode: row.payout_mode,
    handed_over_ref: row.handed_over_ref,
    paid_at: row.paid_at,
    paid_ref: row.paid_ref,
    totals: totalsOf(items),
    counts: { trips: items.trips.length, mileage: items.mileage.length, receipts: items.receipts.length },
    can_decide: row.status === 'submitted' && mayDecide(db, viewer.actor, viewer.access, row.employee_id),
    can_withdraw: row.status === 'submitted' && mayActFor(db, viewer.actor, viewer.access, row.employee_id),
    can_mark_paid: row.status === 'approved' && viewer.access === 'manage' && row.handed_over_ref === null,
  };
}

function event(db: Database.Database, claimId: number, type: string, actor: string, note: string | null, totalCents: number): void {
  db.prepare('INSERT INTO expense_claim_events (claim_id, type, actor, note, total_cents, at) VALUES (?, ?, ?, ?, ?, ?)').run(claimId, type, actor, note, totalCents, nowIso());
}

export interface ClaimFilter {
  employeeId?: number;
  status?: ClaimStatus;
  /** Only claims the viewer may decide on. */
  toDecide?: boolean;
}

export function listClaims(db: Database.Database, viewer: Viewer, filter: ClaimFilter = {}): ExpenseClaim[] {
  const ids = visibleEmployees(db, viewer, { employeeId: filter.employeeId });
  if (ids !== null && ids.length === 0) return [];
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (ids) {
    clauses.push(`employee_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  const rows = db.prepare(`SELECT * FROM expense_claims ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY submitted_at DESC, id DESC`).all(...params) as ClaimStored[];
  const out = rows.map((r) => toClaim(db, r, viewer));
  return filter.toDecide ? out.filter((c) => c.can_decide) : out;
}

export function claimDetail(db: Database.Database, id: number, viewer: Viewer): ClaimDetail {
  const row = claimRow(db, id);
  assertMaySee(db, viewer, row.employee_id, 'Claim');
  const items = itemsOf(db, row);
  const account = currentBankAccount(db, row.employee_id);
  return {
    claim: toClaim(db, row, viewer, items),
    ...items,
    events: db.prepare('SELECT type, actor, note, total_cents, at FROM expense_claim_events WHERE claim_id = ? ORDER BY id').all(id) as ClaimDetail['events'],
    bank_account: account ? { holder: account.holder, iban_masked: maskIban(account.iban) } : null,
  };
}

function nextNumber(db: Database.Database, year: string): string {
  const row = db
    .prepare('SELECT number FROM expense_claims WHERE number LIKE ? ORDER BY length(number) DESC, number DESC LIMIT 1')
    .get(`SP-${year}-%`) as { number: string } | undefined;
  const n = row ? Number(row.number.slice(8)) + 1 : 1;
  return `SP-${year}-${String(n).padStart(4, '0')}`;
}

function idList(input: Record<string, unknown>, field: string, errors: FieldError[]): number[] {
  const raw = input[field] ?? [];
  if (!Array.isArray(raw) || raw.length > 200 || raw.some((v) => !Number.isInteger(v) || (v as number) <= 0)) {
    errors.push({ field, message: `${field} is a list of item ids` });
    return [];
  }
  return [...new Set(raw as number[])];
}

/**
 * Submit items as one claim. Idempotent on `client_id`, so the app can send
 * it again after a dropped connection. Every item must be the person's, free,
 * priced, and — for a privately paid receipt above the threshold — pictured.
 */
export function submitClaim(db: Database.Database, input: Record<string, unknown>, viewer: Viewer, now = Date.now()): { claim: ClaimDetail; created: boolean } {
  return db.transaction(() => {
    const employeeId = subjectOf(db, viewer, input.employee_id);
    employeeRow(db, employeeId);
    assertMayActFor(db, viewer, employeeId);
    const errors: FieldError[] = [];
    const cid = clientId(input, errors);
    const tripIds = idList(input, 'trip_ids', errors);
    const mileageIds = idList(input, 'mileage_ids', errors);
    const receiptIds = idList(input, 'receipt_ids', errors);
    let title = text(input, 'title', errors, 120, false);
    if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
    if (cid !== null) {
      const existing = db.prepare('SELECT id FROM expense_claims WHERE employee_id = ? AND client_id = ?').get(employeeId, cid) as { id: number } | undefined;
      if (existing) return { claim: claimDetail(db, existing.id, viewer), created: false };
    }
    if (tripIds.length + mileageIds.length + receiptIds.length === 0) throw new DomainError(422, 'Validation failed', [{ field: 'items', message: 'A claim holds at least one item' }]);

    const owned = (type: ExpenseItemType, ids: number[], table: string, field: string) => {
      ids.forEach((id, i) => {
        const row = db.prepare(`SELECT employee_id FROM ${table} WHERE id = ?`).get(id) as { employee_id: number } | undefined;
        if (!row || row.employee_id !== employeeId) errors.push({ field: `${field}[${i}]`, message: 'No such item of this person' });
        else {
          const hold = holdingClaim(db, type, id);
          if (hold) errors.push({ field: `${field}[${i}]`, message: `Already in claim ${hold.number}` });
        }
      });
    };
    owned('trip', tripIds, 'expense_trips', 'trip_ids');
    owned('mileage', mileageIds, 'expense_mileage', 'mileage_ids');
    owned('receipt', receiptIds, 'expense_receipts', 'receipt_ids');
    if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);

    const settings = readExpenseSettings(db);
    const tz = readTimerSettings(db).timezone;
    const known = (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM expense_rates').get() as { id: number }).id;
    const pricing: Pricing = { known, mode: settings.per_diem_mode, tz };
    const items: ClaimItems = {
      trips: tripIds.map((id) => toTrip(db, tripRow(db, id), pricing)),
      mileage: mileageIds.map((id) => toMileage(db, mileageRow(db, id), pricing)),
      receipts: receiptIds.map((id) => toReceipt(db, receiptRow(db, id))),
    };
    items.trips.forEach((t, i) => t.rate_problem && errors.push({ field: `trip_ids[${i}]`, message: t.rate_problem }));
    items.mileage.forEach((m, i) => m.rate_problem && errors.push({ field: `mileage_ids[${i}]`, message: m.rate_problem }));
    items.receipts.forEach((r, i) => r.file_missing && errors.push({ field: `receipt_ids[${i}]`, message: `The receipt from ${r.merchant} needs its picture` }));
    if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);

    if (!title) {
      const dates = [...items.trips.map((t) => t.start_local.slice(0, 10)), ...items.mileage.map((m) => m.travel_date), ...items.receipts.map((r) => r.receipt_date)].sort();
      title = dates[0] === dates.at(-1) ? `Expenses ${dates[0]}` : `Expenses ${dates[0]} – ${dates.at(-1)}`;
    }
    const number = nextNumber(db, localDateOf(now, tz).slice(0, 4));
    const at = nowIso();
    const info = db
      .prepare(
        `INSERT INTO expense_claims (number, employee_id, client_id, title, status, submitted_by, submitted_at, rates_known, per_diem_mode, timezone)
         VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?)`,
      )
      .run(number, employeeId, cid, title, viewer.actor, at, known, settings.per_diem_mode, validTimezone(tz) ? tz : 'Europe/Vienna');
    const claimId = Number(info.lastInsertRowid);
    const link = db.prepare('INSERT INTO expense_claim_items (claim_id, item_type, item_id) VALUES (?, ?, ?)');
    for (const id of tripIds) link.run(claimId, 'trip', id);
    for (const id of mileageIds) link.run(claimId, 'mileage', id);
    for (const id of receiptIds) link.run(claimId, 'receipt', id);
    event(db, claimId, 'submitted', viewer.actor, null, totalsOf(items).total_cents);
    return { claim: claimDetail(db, claimId, viewer), created: true };
  })();
}

export function decideClaim(db: Database.Database, id: number, decision: 'approved' | 'rejected', note: string | null, viewer: Viewer): ClaimDetail {
  return db.transaction(() => {
    const row = claimRow(db, id);
    assertMaySee(db, viewer, row.employee_id, 'Claim');
    if (employeeOf(db, viewer.actor) === row.employee_id) throw new DomainError(403, 'Nobody decides their own claim');
    if (!mayDecide(db, viewer.actor, viewer.access, row.employee_id)) throw new DomainError(403, 'Claims are decided by someone with manage access');
    if (row.status !== 'submitted') throw new DomainError(409, `This claim is already ${row.status}`);
    const payout = decision === 'approved' ? readExpenseSettings(db).payout_mode : null;
    db.prepare('UPDATE expense_claims SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, payout_mode = ? WHERE id = ?').run(
      decision,
      viewer.actor,
      nowIso(),
      note,
      payout,
      id,
    );
    event(db, id, decision, viewer.actor, note, totalsOf(itemsOf(db, row)).total_cents);
    return claimDetail(db, id, viewer);
  })();
}

export function withdrawClaim(db: Database.Database, id: number, viewer: Viewer): ClaimDetail {
  return db.transaction(() => {
    const row = claimRow(db, id);
    assertMaySee(db, viewer, row.employee_id, 'Claim');
    if (!mayActFor(db, viewer.actor, viewer.access, row.employee_id)) throw new DomainError(403, 'You can only withdraw your own claims');
    if (row.status !== 'submitted') throw new DomainError(409, `This claim is already ${row.status}`);
    db.prepare("UPDATE expense_claims SET status = 'withdrawn' WHERE id = ?").run(id);
    event(db, id, 'withdrawn', viewer.actor, null, totalsOf(itemsOf(db, row)).total_cents);
    return claimDetail(db, id, viewer);
  })();
}

/** Paid with the salary: the office says so once payroll has run. */
export function markClaimPaid(db: Database.Database, id: number, reference: string | null, viewer: Viewer): ClaimDetail {
  return db.transaction(() => {
    const row = claimRow(db, id);
    if (row.status !== 'approved') throw new DomainError(409, row.status === 'paid' ? 'This claim is already paid' : `Only an approved claim is paid — this one is ${row.status}`);
    // Once the invoicing module holds it as a bill, that bill's payment is the
    // only one: a second way to "paid" is how a claim gets paid twice.
    if (row.handed_over_ref) throw new DomainError(409, `This claim was handed to invoicing as ${row.handed_over_ref} and is marked paid when that bill is`);
    db.prepare("UPDATE expense_claims SET status = 'paid', paid_at = ?, paid_ref = ? WHERE id = ?").run(nowIso(), reference, id);
    event(db, id, 'paid', viewer.actor, reference, totalsOf(itemsOf(db, row)).total_cents);
    return claimDetail(db, id, viewer);
  })();
}

/** The person a claim is for, to tell them of a decision. */
export function claimRecipient(db: Database.Database, id: number): { name: string; email: string | null; number: string; title: string; status: ClaimStatus; total_cents: number; note: string | null } {
  const row = claimRow(db, id);
  const person = employeeRow(db, row.employee_id);
  return { name: person.name, email: person.email, number: row.number, title: row.title, status: row.status, total_cents: totalsOf(itemsOf(db, row)).total_cents, note: row.decision_note };
}

// ── Payout by invoicing: the transfer and what comes back ───────────────

const TRANSFER_SOURCE = 'mod-11-time-tracking';

/** An approved claim as the invoicing module takes it over (shared/expense-transfer.ts). */
export function claimTransfer(db: Database.Database, number: string): ExpenseClaimTransfer {
  const row = claimByNumber(db, number);
  if (!row) throw new DomainError(404, 'Claim not found');
  if (row.status !== 'approved') throw new DomainError(409, row.status === 'paid' ? `Claim ${number} is already paid` : `Claim ${number} is ${row.status}, not approved`);
  if (row.payout_mode !== 'invoicing') throw new DomainError(409, `Claim ${number} is paid with the salary, not by bank transfer`);
  const account = currentBankAccount(db, row.employee_id);
  const person = employeeRow(db, row.employee_id);
  if (!account) throw new DomainError(409, `${person.name} has no bank account on file — they add it under Expenses → Bank account`);
  const items = itemsOf(db, row);
  const lines: ExpenseTransferLine[] = [];
  for (const t of items.trips) {
    const span = `${t.start_local.replace('T', ' ')} – ${t.end_local.replace('T', ' ')}`;
    if (t.per_diem_cents > 0) lines.push({ kind: 'per_diem', date: t.start_local.slice(0, 10), description: `Tagesgeld ${t.destination} (${span})`, amount_cents: t.per_diem_cents, vat_lines: [] });
    if (t.nights_cents > 0) lines.push({ kind: 'nights', date: t.start_local.slice(0, 10), description: `Nächtigungsgeld ${t.destination}, ${t.nights_flat} × ${(t.night_rate_cents / 100).toFixed(2)}`, amount_cents: t.nights_cents, vat_lines: [] });
  }
  for (const m of items.mileage) {
    if (m.amount_cents > 0) {
      lines.push({ kind: 'mileage', date: m.travel_date, description: `Kilometergeld ${m.from_place} – ${m.to_place}, ${(m.km_tenths / 10).toFixed(1)} km`, amount_cents: m.amount_cents, vat_lines: [] });
    }
  }
  for (const r of items.receipts) {
    if (r.reimbursable_cents > 0) lines.push({ kind: 'receipt', date: r.receipt_date, description: `${r.merchant}${r.description ? ` — ${r.description}` : ''}`, amount_cents: r.reimbursable_cents, vat_lines: r.vat_lines });
  }
  const totals = totalsOf(items);
  return {
    version: EXPENSE_TRANSFER_VERSION,
    source: TRANSFER_SOURCE,
    number: row.number,
    title: row.title,
    employee: { name: person.name, email: person.email },
    payee: { holder: account.holder, iban: account.iban, bic: account.bic },
    approved_at: row.decided_at!,
    approved_by: row.decided_by!,
    currency: 'EUR',
    totals,
    lines,
    handed_over_ref: row.handed_over_ref,
  };
}

/** Approved claims waiting for the invoicing module to take them over. */
export function claimsToHandOver(db: Database.Database): { number: string; title: string; employee_name: string; approved_at: string; total_cents: number; has_bank_account: boolean }[] {
  const rows = db
    .prepare("SELECT * FROM expense_claims WHERE status = 'approved' AND payout_mode = 'invoicing' AND handed_over_ref IS NULL ORDER BY decided_at, id")
    .all() as ClaimStored[];
  return rows.map((r) => ({
    number: r.number,
    title: r.title,
    employee_name: employeeRow(db, r.employee_id).name,
    approved_at: r.decided_at!,
    total_cents: totalsOf(itemsOf(db, r)).total_cents,
    has_bank_account: currentBankAccount(db, r.employee_id) !== null,
  }));
}

function machineActor(input: Record<string, unknown>): string {
  // Every write names the person: the invoicing module says who did it there.
  const actor = typeof input.actor === 'string' ? input.actor.trim() : '';
  if (actor === '' || actor.length > 200) throw new DomainError(422, 'Validation failed', [{ field: 'actor', message: 'actor names the person who acted in the invoicing module' }]);
  return actor;
}

function machineReference(input: Record<string, unknown>): string {
  const ref = typeof input.reference === 'string' ? input.reference.trim() : '';
  if (ref === '' || ref.length > 80) throw new DomainError(422, 'Validation failed', [{ field: 'reference', message: 'reference is the bill or payment it became (max 80 characters)' }]);
  return ref;
}

/** The invoicing module now holds the claim as a bill. Idempotent for the same bill. */
export function claimHandedOver(db: Database.Database, number: string, input: Record<string, unknown>): { number: string; handed_over_ref: string; status: ClaimStatus } {
  const actor = machineActor(input);
  const reference = machineReference(input);
  return db.transaction(() => {
    const row = claimByNumber(db, number);
    if (!row) throw new DomainError(404, 'Claim not found');
    if (row.handed_over_ref === reference) return { number, handed_over_ref: reference, status: row.status };
    if (row.handed_over_ref) throw new DomainError(409, `Claim ${number} is already held as ${row.handed_over_ref}`);
    if (row.status !== 'approved' || row.payout_mode !== 'invoicing') throw new DomainError(409, `Claim ${number} is not waiting for a bank transfer`);
    db.prepare('UPDATE expense_claims SET handed_over_ref = ? WHERE id = ?').run(reference, row.id);
    event(db, row.id, 'handed_over', actor, reference, totalsOf(itemsOf(db, row)).total_cents);
    return { number, handed_over_ref: reference, status: row.status };
  })();
}

/** The bill was paid. Idempotent; only the bill the claim was handed over as can pay it. */
export function claimPaidByInvoicing(db: Database.Database, number: string, input: Record<string, unknown>): { number: string; status: ClaimStatus; paid_at: string } {
  const actor = machineActor(input);
  const reference = machineReference(input);
  const bill = typeof input.bill === 'string' ? input.bill.trim() : '';
  return db.transaction(() => {
    const row = claimByNumber(db, number);
    if (!row) throw new DomainError(404, 'Claim not found');
    if (!row.handed_over_ref || row.handed_over_ref !== bill) throw new DomainError(409, `Claim ${number} was not handed over as ${bill || 'that bill'}`);
    if (row.status === 'paid') return { number, status: row.status, paid_at: row.paid_at! };
    if (row.status !== 'approved') throw new DomainError(409, `Claim ${number} is ${row.status}`);
    const at = nowIso();
    db.prepare("UPDATE expense_claims SET status = 'paid', paid_at = ?, paid_ref = ? WHERE id = ?").run(at, reference, row.id);
    event(db, row.id, 'paid', actor, reference, totalsOf(itemsOf(db, row)).total_cents);
    return { number, status: 'paid' as const, paid_at: at };
  })();
}

// ── Payout with the salary: the export ──────────────────────────────────

const euro = (cents: number): string => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
};

/**
 * Approved claims for payroll, one row each, amounts split the way a payslip
 * shows them: per diem and night allowance and mileage (§ 26 Z 4 EStG) apart
 * from out-of-pocket costs refunded against receipts (§ 26 Z 2 EStG).
 * Semicolons and decimal commas, as Austrian spreadsheets read them.
 */
export function payrollCsv(db: Database.Database, filter: { status: 'approved' | 'paid'; from?: string; to?: string }): string {
  const rows = db
    .prepare(
      `SELECT * FROM expense_claims WHERE status = ? AND payout_mode = 'payroll'
         AND (? IS NULL OR substr(decided_at, 1, 10) >= ?) AND (? IS NULL OR substr(decided_at, 1, 10) <= ?)
       ORDER BY decided_at, id`,
    )
    .all(filter.status, filter.from ?? null, filter.from ?? null, filter.to ?? null, filter.to ?? null) as ClaimStored[];
  const header = ['Claim', 'Employee', 'Email', 'Title', 'Submitted', 'Approved', 'Approved by', 'Per diem', 'Night allowance', 'Mileage', 'Receipts', 'Total', 'Status', 'Paid reference'];
  const lines = [header.map((h) => escapeCell(h, ';')).join(';')];
  for (const r of rows) {
    const person = employeeRow(db, r.employee_id);
    const t = totalsOf(itemsOf(db, r));
    lines.push(
      [
        r.number,
        person.name,
        person.email ?? '',
        r.title,
        r.submitted_at.slice(0, 10),
        (r.decided_at ?? '').slice(0, 10),
        r.decided_by ?? '',
        euro(t.per_diem_cents),
        euro(t.nights_cents),
        euro(t.mileage_cents),
        euro(t.receipts_cents),
        euro(t.total_cents),
        r.status,
        r.paid_ref ?? '',
      ]
        .map((c) => escapeCell(c, ';'))
        .join(';'),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
