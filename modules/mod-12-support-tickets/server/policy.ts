import type Database from 'better-sqlite3';
import { PRIORITIES, type FieldError, type HelpdeskSettings, type SlaPolicy, type SlaPolicyVersion } from '../shared/types.js';
import { DEFAULT_POLICY } from './sla-config.js';
import { DomainError } from './tickets.js';

/**
 * What an administrator sets in the UI (`manage`):
 *
 * - **The SLA policy** — targets per priority, business hours or around the
 *   clock, the weekly opening windows, time zone, holidays, at-risk window,
 *   and whether waiting on the requester stops the resolution clock. Saved
 *   as a new VERSION each time (`sla_policies`, append-only); a ticket is
 *   held to the version in force when it came in.
 * - **The rest** (`helpdesk_settings`, one row) — satisfaction ratings,
 *   replies by email, the mailbox.
 */

export const DEFAULT_SETTINGS: HelpdeskSettings = {
  csat: { enabled: false, invite_by_email: false },
  reply_by_email: false,
  mailbox: { enabled: false, connection_id: null, poll_seconds: 120 },
};

// ── SLA policy versions ──────────────────────────────────────────────

interface VersionRow {
  id: number;
  policy: string;
  created_by: string;
  created_at: string;
}

const toVersion = (row: VersionRow): SlaPolicyVersion => ({ id: row.id, policy: JSON.parse(row.policy) as SlaPolicy, created_by: row.created_by, created_at: row.created_at });

export const DEFAULT_VERSION: SlaPolicyVersion = { id: null, policy: DEFAULT_POLICY, created_by: null, created_at: null };

/** Every saved version, oldest first — loaded once per read of many tickets. */
export function policyVersions(db: Database.Database): SlaPolicyVersion[] {
  return (db.prepare('SELECT * FROM sla_policies ORDER BY created_at, id').all() as VersionRow[]).map(toVersion);
}

/** The version a ticket created at `createdAt` is held to. */
export function versionAt(versions: readonly SlaPolicyVersion[], createdAt: string): SlaPolicyVersion {
  let found = DEFAULT_VERSION;
  for (const v of versions) if (v.created_at! <= createdAt) found = v;
  return found;
}

export function currentPolicy(db: Database.Database): SlaPolicyVersion {
  const row = db.prepare('SELECT * FROM sla_policies ORDER BY created_at DESC, id DESC LIMIT 1').get() as VersionRow | undefined;
  return row ? toVersion(row) : DEFAULT_VERSION;
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function wholeIn(raw: unknown, min: number, max: number): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max ? raw : null;
}

/** Validate a whole policy as the UI sends it; every problem is named. */
export function validatePolicy(raw: unknown): SlaPolicy {
  const errors: FieldError[] = [];
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const targetsIn = (input.targets ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const targets = {} as SlaPolicy['targets'];
  for (const p of PRIORITIES) {
    const t = targetsIn[p] ?? {};
    const first = wholeIn(t.first_response_minutes, 1, 43_200);
    const resolution = wholeIn(t.resolution_minutes, 1, 525_600);
    if (first === null) errors.push({ field: `targets.${p}.first_response_minutes`, message: 'must be a whole number of minutes, 1 to 43200 (30 days)' });
    if (resolution === null) errors.push({ field: `targets.${p}.resolution_minutes`, message: 'must be a whole number of minutes, 1 to 525600 (a year)' });
    if (first !== null && resolution !== null && first > resolution) errors.push({ field: `targets.${p}.first_response_minutes`, message: 'cannot be longer than the resolution target' });
    targets[p] = { first_response_minutes: first ?? 0, resolution_minutes: resolution ?? 0, business_hours: t.business_hours === true };
  }
  const atRisk = wholeIn(input.at_risk_minutes, 1, 1440);
  if (atRisk === null) errors.push({ field: 'at_risk_minutes', message: 'must be a whole number of minutes, 1 to 1440' });
  const timezone = typeof input.timezone === 'string' ? input.timezone.trim() : '';
  if (!timezone || !validTimezone(timezone)) errors.push({ field: 'timezone', message: 'must be an IANA time zone, e.g. Europe/Vienna' });

  const weekIn = Array.isArray(input.week) ? input.week : [];
  if (weekIn.length !== 7) errors.push({ field: 'week', message: 'must list the opening windows of all seven days, Monday first' });
  const week = [0, 1, 2, 3, 4, 5, 6].map((d) => {
    const day = Array.isArray(weekIn[d]) ? (weekIn[d] as unknown[]) : [];
    if (day.length > 3) errors.push({ field: `week.${d}`, message: 'at most three windows a day' });
    let previousEnd = '';
    return day.map((w, i) => {
      const win = (w ?? {}) as Record<string, unknown>;
      const start = typeof win.start === 'string' ? win.start : '';
      const end = typeof win.end === 'string' ? win.end : '';
      if (!TIME.test(start) || start === '24:00' || !TIME.test(end)) errors.push({ field: `week.${d}.${i}`, message: 'start and end must be HH:MM (end may be 24:00)' });
      else if (start >= end) errors.push({ field: `week.${d}.${i}`, message: 'must end after it starts' });
      else if (previousEnd && start < previousEnd) errors.push({ field: `week.${d}.${i}`, message: 'windows must be in order and not overlap' });
      previousEnd = end;
      return { start, end };
    });
  });
  if (PRIORITIES.some((p) => targets[p].business_hours) && week.every((d) => d.length === 0)) {
    errors.push({ field: 'week', message: 'a priority counts business hours, so the week needs at least one opening window' });
  }

  const holidaysIn = Array.isArray(input.holidays) ? input.holidays : [];
  if (holidaysIn.length > 366) errors.push({ field: 'holidays', message: 'at most 366 holidays' });
  const seen = new Set<string>();
  const holidays = holidaysIn.map((h, i) => {
    const hol = (h ?? {}) as Record<string, unknown>;
    const date = typeof hol.date === 'string' ? hol.date : '';
    const name = typeof hol.name === 'string' ? hol.name.trim() : '';
    if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) errors.push({ field: `holidays.${i}.date`, message: 'must be a date, YYYY-MM-DD' });
    else if (seen.has(date)) errors.push({ field: `holidays.${i}.date`, message: `${date} is listed twice` });
    seen.add(date);
    if (name.length > 120) errors.push({ field: `holidays.${i}.name`, message: 'at most 120 characters' });
    return { date, name };
  });
  holidays.sort((a, b) => a.date.localeCompare(b.date));

  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return { targets, at_risk_minutes: atRisk!, timezone, week, holidays, pause_on_pending: input.pause_on_pending === true };
}

/** Save a new version — unless it is the one in force already. */
export function savePolicy(db: Database.Database, raw: unknown, actor: string, at: string): SlaPolicyVersion {
  const policy = validatePolicy(raw);
  const current = currentPolicy(db);
  if (JSON.stringify(current.policy) === JSON.stringify(policy)) return current;
  // A version must start after the last one: an injected clock that goes
  // backwards would otherwise reorder history.
  if (current.created_at && at < current.created_at) throw new DomainError(409, 'A newer policy version exists');
  const info = db.prepare('INSERT INTO sla_policies (policy, created_by, created_at) VALUES (?, ?, ?)').run(JSON.stringify(policy), actor, at);
  return toVersion(db.prepare('SELECT * FROM sla_policies WHERE id = ?').get(info.lastInsertRowid) as VersionRow);
}

// ── Settings ─────────────────────────────────────────────────────────

export function readSettings(db: Database.Database): HelpdeskSettings {
  const row = db.prepare('SELECT settings FROM helpdesk_settings WHERE id = 1').get() as { settings: string } | undefined;
  if (!row) return DEFAULT_SETTINGS;
  const stored = JSON.parse(row.settings) as Partial<HelpdeskSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    csat: { ...DEFAULT_SETTINGS.csat, ...stored.csat },
    mailbox: { ...DEFAULT_SETTINGS.mailbox, ...stored.mailbox },
  };
}

export function settingsStamp(db: Database.Database): { updated_by: string | null; updated_at: string | null } {
  const row = db.prepare('SELECT updated_by, updated_at FROM helpdesk_settings WHERE id = 1').get() as { updated_by: string; updated_at: string } | undefined;
  return { updated_by: row?.updated_by ?? null, updated_at: row?.updated_at ?? null };
}

/** Merge a partial update into the current settings and validate the result. */
export function writeSettings(db: Database.Database, raw: unknown, actor: string, at: string): HelpdeskSettings {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const current = readSettings(db);
  const errors: FieldError[] = [];
  const bool = (value: unknown, field: string, fallback: boolean): boolean => {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') errors.push({ field, message: 'must be true or false' });
    return value === true;
  };
  const csatIn = (input.csat ?? {}) as Record<string, unknown>;
  const mailIn = (input.mailbox ?? {}) as Record<string, unknown>;
  const next: HelpdeskSettings = {
    csat: { enabled: bool(csatIn.enabled, 'csat.enabled', current.csat.enabled), invite_by_email: bool(csatIn.invite_by_email, 'csat.invite_by_email', current.csat.invite_by_email) },
    reply_by_email: bool(input.reply_by_email, 'reply_by_email', current.reply_by_email),
    mailbox: { ...current.mailbox, enabled: bool(mailIn.enabled, 'mailbox.enabled', current.mailbox.enabled) },
  };
  if (mailIn.connection_id !== undefined) {
    if (mailIn.connection_id === null) next.mailbox.connection_id = null;
    else if (wholeIn(mailIn.connection_id, 1, 2_147_483_647) === null) errors.push({ field: 'mailbox.connection_id', message: 'must be a PS-05 connection id' });
    else next.mailbox.connection_id = mailIn.connection_id as number;
  }
  if (mailIn.poll_seconds !== undefined) {
    const seconds = wholeIn(mailIn.poll_seconds, 30, 3600);
    if (seconds === null) errors.push({ field: 'mailbox.poll_seconds', message: 'must be a whole number of seconds, 30 to 3600' });
    else next.mailbox.poll_seconds = seconds;
  }
  if (next.csat.invite_by_email && !next.csat.enabled) errors.push({ field: 'csat.invite_by_email', message: 'needs ratings switched on' });
  if (next.mailbox.enabled && next.mailbox.connection_id === null) errors.push({ field: 'mailbox.connection_id', message: 'choose the mailbox to read first' });
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  db.prepare(
    `INSERT INTO helpdesk_settings (id, settings, updated_by, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET settings = excluded.settings, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(next), actor, at);
  return next;
}
