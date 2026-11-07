import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';
import { enqueue } from './queue.js';
import { DomainError, fail } from './errors.js';
import { isAllowedPushEndpoint, sendPush, type PushFetch, type Subscription } from './webpush.js';

/**
 * Notifications addressed to a PERSON — the layer docs/NOTIFICATIONS-PLAN.md
 * describes. `/api/send` delivers a message to an address; this decides
 * whether a person should be interrupted at all, now or later, and on which
 * device.
 *
 *  - A module reports an EVENT: what happened, to whom it matters, how urgent
 *    (`now` interrupts, `digest` waits for the next briefing or wrap-up,
 *    `badge` only counts), and a title that is safe on a lock screen next to a
 *    detail that is not.
 *  - Each person has PREFERENCES over an administrator's defaults: muted
 *    categories, quiet hours, working days, the times of the morning briefing
 *    and the evening wrap-up, whether those come by push, mail or both, and
 *    whether details may show on the lock screen.
 *  - The tick decides: push now, hold for the digest, or drop a muted one.
 *    Security events and on-call events ignore quiet hours and mutes — the
 *    whole point of "someone just turned off your second factor" is lost if
 *    it waits until 7:30.
 *
 * The badge is NOT computed here. What awaits a person lives in the modules
 * and is counted there on every request (`/api/inbox`); a push only tells the
 * app to count again. A number kept here would drift from the rows it claims
 * to count (CLAUDE.md rule 3).
 */

export const URGENCIES = ['now', 'digest', 'badge'] as const;
export type Urgency = (typeof URGENCIES)[number];

export interface Prefs {
  /** IANA time zone the times below are read in. */
  timezone: string;
  /** ISO weekdays (1 = Monday) on which digests are sent. */
  workdays: number[];
  briefing: { enabled: boolean; at: string };
  wrapup: { enabled: boolean; at: string };
  /** Quiet hours, may wrap midnight; null = none. */
  quiet: { from: string; to: string } | null;
  digest_via: 'push' | 'email' | 'both';
  /** Show names, amounts and the like on the lock screen. Off by default. */
  lock_screen_details: boolean;
  /** Categories this person does not want (security cannot be muted). */
  muted: string[];
}

/** What a stack starts with until an administrator says otherwise. */
export const FACTORY_DEFAULTS: Prefs = {
  timezone: 'Europe/Vienna',
  workdays: [1, 2, 3, 4, 5],
  briefing: { enabled: true, at: '07:30' },
  wrapup: { enabled: true, at: '17:00' },
  quiet: { from: '19:00', to: '07:00' },
  digest_via: 'push',
  lock_screen_details: false,
  muted: [],
};

export interface StackSettings {
  defaults: Prefs;
  /** The email channel digests and push fallbacks go out on. */
  email_channel: string;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DIGEST_WINDOW_MIN = 180;
/** How long a handled event stays in the person's feed. */
export const EVENT_RETENTION_DAYS = 60;

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a (partial) preferences object field by field. Unknown fields are
 * refused rather than ignored: a typo in "lock_screen_detail" that silently
 * did nothing would leave someone believing their lock screen was private.
 */
export function parsePrefs(input: unknown, base: Prefs): Prefs {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new DomainError(422, 'Validation failed', [{ field: 'prefs', message: 'must be an object' }]);
  }
  const o = input as Record<string, unknown>;
  const errors: { field: string; message: string }[] = [];
  const out: Prefs = structuredClone(base);
  const known = new Set(Object.keys(FACTORY_DEFAULTS));
  for (const key of Object.keys(o)) if (!known.has(key)) errors.push({ field: key, message: 'is not a preference' });

  if ('timezone' in o) {
    if (typeof o.timezone === 'string' && isTimeZone(o.timezone)) out.timezone = o.timezone;
    else errors.push({ field: 'timezone', message: 'must be an IANA time zone' });
  }
  if ('workdays' in o) {
    const days = o.workdays;
    if (Array.isArray(days) && days.every((d) => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7)) {
      out.workdays = [...new Set(days as number[])].sort();
    } else errors.push({ field: 'workdays', message: 'must be ISO weekdays 1–7' });
  }
  for (const key of ['briefing', 'wrapup'] as const) {
    if (!(key in o)) continue;
    const v = o[key] as Record<string, unknown> | null;
    if (v && typeof v === 'object' && typeof v.enabled === 'boolean' && typeof v.at === 'string' && HHMM.test(v.at)) {
      out[key] = { enabled: v.enabled, at: v.at };
    } else errors.push({ field: key, message: 'must be {enabled: boolean, at: "HH:MM"}' });
  }
  if ('quiet' in o) {
    const v = o.quiet as Record<string, unknown> | null;
    if (v === null) out.quiet = null;
    else if (typeof v === 'object' && typeof v.from === 'string' && typeof v.to === 'string' && HHMM.test(v.from) && HHMM.test(v.to)) {
      out.quiet = { from: v.from, to: v.to };
    } else errors.push({ field: 'quiet', message: 'must be null or {from: "HH:MM", to: "HH:MM"}' });
  }
  if ('digest_via' in o) {
    if (o.digest_via === 'push' || o.digest_via === 'email' || o.digest_via === 'both') out.digest_via = o.digest_via;
    else errors.push({ field: 'digest_via', message: 'must be push, email or both' });
  }
  if ('lock_screen_details' in o) {
    if (typeof o.lock_screen_details === 'boolean') out.lock_screen_details = o.lock_screen_details;
    else errors.push({ field: 'lock_screen_details', message: 'must be a boolean' });
  }
  if ('muted' in o) {
    const m = o.muted;
    if (Array.isArray(m) && m.every((c) => typeof c === 'string' && SLUG.test(c))) {
      out.muted = [...new Set(m as string[])].filter((c) => c !== 'security').sort();
    } else errors.push({ field: 'muted', message: 'must be a list of category names' });
  }
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return out;
}

export function readSettings(db: Database.Database): StackSettings {
  const row = db.prepare('SELECT settings FROM notify_settings WHERE id = 1').get() as { settings: string } | undefined;
  const stored = row ? (JSON.parse(row.settings) as Partial<StackSettings>) : {};
  return {
    defaults: { ...FACTORY_DEFAULTS, ...(stored.defaults ?? {}) },
    email_channel: stored.email_channel ?? 'transactional-email',
  };
}

export function writeSettings(db: Database.Database, input: unknown, now: number): StackSettings {
  const current = readSettings(db);
  const o = (input ?? {}) as Record<string, unknown>;
  const next: StackSettings = {
    defaults: 'defaults' in o ? parsePrefs(o.defaults, current.defaults) : current.defaults,
    email_channel: current.email_channel,
  };
  if ('email_channel' in o) {
    if (typeof o.email_channel !== 'string' || !db.prepare('SELECT 1 FROM channels WHERE name = ?').get(o.email_channel)) {
      fail(422, 'Validation failed', [{ field: 'email_channel', message: 'must name an existing channel' }]);
    }
    next.email_channel = o.email_channel;
  }
  db.prepare(
    `INSERT INTO notify_settings (id, settings, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(next), nowIso(now));
  return next;
}

/** A person's own choices, stored as overrides only, so a changed default reaches them. */
export function readOverrides(db: Database.Database, recipient: string): Partial<Prefs> {
  const row = db.prepare('SELECT prefs FROM notify_prefs WHERE recipient = ?').get(recipient) as { prefs: string } | undefined;
  return row ? (JSON.parse(row.prefs) as Partial<Prefs>) : {};
}

export function effectivePrefs(db: Database.Database, recipient: string): Prefs {
  return { ...readSettings(db).defaults, ...readOverrides(db, recipient) };
}

export function writeOverrides(db: Database.Database, recipient: string, input: unknown, now: number): Prefs {
  const defaults = readSettings(db).defaults;
  // Validate against the effective set, then store only what differs.
  const merged = parsePrefs(input, effectivePrefs(db, recipient));
  const overrides: Partial<Prefs> = { ...readOverrides(db, recipient) };
  for (const key of Object.keys(input as object) as (keyof Prefs)[]) {
    (overrides as Record<string, unknown>)[key] = merged[key];
  }
  for (const key of Object.keys(overrides) as (keyof Prefs)[]) {
    if (JSON.stringify(overrides[key]) === JSON.stringify(defaults[key])) delete overrides[key];
  }
  db.prepare(
    `INSERT INTO notify_prefs (recipient, prefs, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(recipient) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`,
  ).run(recipient, JSON.stringify(overrides), nowIso(now));
  return { ...defaults, ...overrides };
}

// ── Local time ─────────────────────────────────────────────────────────

export interface LocalTime {
  date: string;
  minutes: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localTime(nowMs: number, timeZone: string): LocalTime {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(nowMs))
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday as string] ?? 1,
  };
}

const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export function inQuietHours(prefs: Prefs, local: LocalTime): boolean {
  if (!prefs.quiet) return false;
  const from = toMinutes(prefs.quiet.from);
  const to = toMinutes(prefs.quiet.to);
  if (from === to) return false;
  return from < to ? local.minutes >= from && local.minutes < to : local.minutes >= from || local.minutes < to;
}

// ── Events ─────────────────────────────────────────────────────────────

export interface EventInput {
  module: string;
  kind: string;
  category: string;
  urgency: Urgency;
  recipients: string[];
  /** Who caused it — never notified about their own action. */
  actor: string | null;
  title: string;
  detail: string | null;
  href: string | null;
  /** Bypass quiet hours (MOD-12 SLA, MOD-02 outages). */
  oncall: boolean;
  /** Bypass quiet hours AND mutes (PS-01 sign-in events). */
  security: boolean;
  idempotencyKey: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

export function parseEvent(body: Record<string, unknown>): EventInput {
  const errors: { field: string; message: string }[] = [];
  const text = (field: string, max: number, required: boolean): string | null => {
    const v = body[field];
    if (v === undefined || v === null || v === '') {
      if (required) errors.push({ field, message: 'is required' });
      return null;
    }
    if (typeof v !== 'string' || v.length > max) {
      errors.push({ field, message: `must be text of at most ${max} characters` });
      return null;
    }
    return v;
  };
  const module = text('module', 40, true);
  const kind = text('kind', 60, true);
  const category = text('category', 40, true);
  if (module && !SLUG.test(module)) errors.push({ field: 'module', message: 'must be a slug' });
  if (category && !SLUG.test(category)) errors.push({ field: 'category', message: 'must be a slug' });
  const urgency = body.urgency;
  if (!(URGENCIES as readonly unknown[]).includes(urgency)) errors.push({ field: 'urgency', message: 'must be now, digest or badge' });
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];
  if (recipients.length === 0 || recipients.length > 100 || !recipients.every((r) => typeof r === 'string' && EMAIL.test(r))) {
    errors.push({ field: 'recipients', message: 'must list 1–100 email addresses' });
  }
  const title = text('title', 140, true);
  const detail = text('detail', 600, false);
  const href = text('href', 500, false);
  // Module-relative paths only: the app turns them into a pane of that module.
  if (href && !href.startsWith('/')) errors.push({ field: 'href', message: 'must be a path starting with /' });
  const key = text('idempotency_key', 200, true);
  const actor = text('actor', 320, false);
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return {
    module: module!,
    kind: kind!,
    category: category!,
    urgency: urgency as Urgency,
    recipients: [...new Set((recipients as string[]).map((r) => r.trim().toLowerCase()))],
    actor: actor ? actor.trim().toLowerCase() : null,
    title: title!,
    detail,
    href,
    oncall: body.oncall === true,
    security: body.security === true,
    idempotencyKey: key!,
  };
}

export interface EventRow {
  id: number;
  module: string;
  kind: string;
  category: string;
  urgency: Urgency;
  oncall: number;
  security: number;
  recipient: string;
  title: string;
  detail: string | null;
  href: string | null;
  idempotency_key: string;
  state: 'pending' | 'digest' | 'pushed' | 'emailed' | 'counted' | 'muted' | 'digested';
  created_at: string;
  delivered_at: string | null;
}

/** Record one row per recipient; the same key for the same person is a no-op. */
export function recordEvent(db: Database.Database, input: EventInput, now: number): { recorded: number; skipped: number } {
  let recorded = 0;
  let skipped = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO notify_events
       (module, kind, category, urgency, oncall, security, recipient, title, detail, href, idempotency_key, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  );
  db.transaction(() => {
    for (const recipient of input.recipients) {
      if (recipient === input.actor) {
        skipped++;
        continue;
      }
      const info = insert.run(
        input.module,
        input.kind,
        input.category,
        input.urgency,
        input.oncall ? 1 : 0,
        input.security ? 1 : 0,
        recipient,
        input.title,
        input.detail,
        input.href,
        input.idempotencyKey,
        nowIso(now),
      );
      if (info.changes > 0) recorded++;
      else skipped++;
    }
  })();
  return { recorded, skipped };
}

// ── Subscriptions ──────────────────────────────────────────────────────

export interface SubscriptionRow {
  id: number;
  recipient: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  device: string | null;
  created_at: string;
  last_sent_at: string | null;
  failures: number;
}

export function saveSubscription(
  db: Database.Database,
  recipient: string,
  input: unknown,
  device: string | null,
  allowedHosts: readonly string[],
  now: number,
): SubscriptionRow {
  const sub = (input ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint : '';
  const p256dh = typeof sub.keys?.p256dh === 'string' ? sub.keys.p256dh : '';
  const auth = typeof sub.keys?.auth === 'string' ? sub.keys.auth : '';
  if (!isAllowedPushEndpoint(endpoint, allowedHosts)) {
    fail(422, 'Validation failed', [{ field: 'subscription.endpoint', message: 'is not a known push service' }]);
  }
  if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) {
    fail(422, 'Validation failed', [{ field: 'subscription.keys', message: 'must carry p256dh (65 bytes) and auth (16 bytes)' }]);
  }
  // An endpoint belongs to one browser profile. If someone else signs in on
  // that device, the subscription moves to them — the previous person must
  // not keep receiving pushes on a phone that is no longer theirs to read.
  db.prepare(
    `INSERT INTO push_subscriptions (recipient, endpoint, p256dh, auth, device, created_at, failures)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(endpoint) DO UPDATE SET recipient = excluded.recipient, p256dh = excluded.p256dh,
       auth = excluded.auth, device = excluded.device, failures = 0`,
  ).run(recipient, endpoint, p256dh, auth, device ? device.slice(0, 120) : null, nowIso(now));
  return db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as SubscriptionRow;
}

// ── The tick ───────────────────────────────────────────────────────────

export interface NotifyDeps {
  vapid: { privateKey: string; subject: string } | null;
  pushFetch?: PushFetch;
}

export interface NotifyTickResult {
  pushed: number;
  emailed: number;
  held: number;
  muted: number;
  counted: number;
  digests: number;
  subscriptions_dropped: number;
}

interface PushMessage {
  title: string;
  body: string;
  /** The module and its path the app opens when the notification is tapped. */
  module: string | null;
  href: string | null;
  tag: string;
}

/** Push to every device of a person. Returns how many accepted it. */
async function pushToPerson(
  db: Database.Database,
  deps: NotifyDeps,
  recipient: string,
  message: PushMessage,
  urgency: 'normal' | 'high',
  now: number,
  result: NotifyTickResult,
): Promise<number> {
  if (!deps.vapid) return 0;
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE recipient = ?').all(recipient) as SubscriptionRow[];
  let accepted = 0;
  for (const row of subs) {
    const sub: Subscription = { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth };
    const sent = await sendPush(sub, { ...message, badge: 'recount' }, {
      vapid: deps.vapid,
      urgency,
      ttlSeconds: 24 * 3600,
      topic: message.tag,
      fetch: deps.pushFetch,
      now,
    });
    if (sent.outcome === 'sent') {
      accepted++;
      db.prepare('UPDATE push_subscriptions SET last_sent_at = ?, failures = 0 WHERE id = ?').run(nowIso(now), row.id);
    } else if (sent.outcome === 'gone' || row.failures + 1 >= 10) {
      // The browser dropped it, or it has not worked for ten tries running.
      db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
      result.subscriptions_dropped++;
    } else {
      db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?').run(row.id);
    }
  }
  return accepted;
}

function emailTo(db: Database.Database, recipient: string, subject: string, body: string, key: string, now: number): boolean {
  const channel = db.prepare('SELECT id FROM channels WHERE name = ? AND enabled = 1').get(readSettings(db).email_channel) as
    | { id: number }
    | undefined;
  if (!channel) return false;
  enqueue(db, { channelId: channel.id, templateKey: null, to: recipient, subject, body, variables: {}, idempotencyKey: key, now });
  return true;
}

/** The lock-screen line: the title always, the detail only if the person said so. */
function pushText(event: EventRow, prefs: Prefs): string {
  return prefs.lock_screen_details && event.detail ? event.detail : 'Open the app to see it.';
}

/**
 * One pass over pending events and due digests. Idempotent per tick: every
 * event leaves `pending` in the same pass that handles it, and a digest is
 * marked sent for (person, kind, local date) before the next one can start.
 */
let notifyInFlight: Promise<unknown> = Promise.resolve();

/**
 * Serialized like the message queue's tick (server/queue.ts): an event is
 * marked handled only after its pushes return, so two overlapping ticks would
 * otherwise both push it — two buzzes for one thing.
 */
export function notifyTick(db: Database.Database, deps: NotifyDeps, now: number): Promise<NotifyTickResult> {
  const run = notifyInFlight.then(
    () => runNotifyTick(db, deps, now),
    () => runNotifyTick(db, deps, now),
  );
  notifyInFlight = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function runNotifyTick(db: Database.Database, deps: NotifyDeps, now: number): Promise<NotifyTickResult> {
  const result: NotifyTickResult = { pushed: 0, emailed: 0, held: 0, muted: 0, counted: 0, digests: 0, subscriptions_dropped: 0 };
  const setState = db.prepare('UPDATE notify_events SET state = ?, delivered_at = ? WHERE id = ?');
  const pending = db.prepare("SELECT * FROM notify_events WHERE state = 'pending' ORDER BY id").all() as EventRow[];

  for (const event of pending) {
    const prefs = effectivePrefs(db, event.recipient);
    if (!event.security && prefs.muted.includes(event.category)) {
      setState.run('muted', nowIso(now), event.id);
      result.muted++;
      continue;
    }
    if (event.urgency === 'badge') {
      setState.run('counted', nowIso(now), event.id);
      result.counted++;
      continue;
    }
    const local = localTime(now, prefs.timezone);
    const bypass = event.security === 1 || event.oncall === 1;
    if (event.urgency === 'digest' || (!bypass && inQuietHours(prefs, local))) {
      setState.run('digest', null, event.id);
      result.held++;
      continue;
    }
    const accepted = await pushToPerson(
      db,
      deps,
      event.recipient,
      { title: event.title, body: pushText(event, prefs), module: event.module, href: event.href, tag: `${event.module}-${event.id}` },
      'high',
      now,
      result,
    );
    if (accepted > 0) {
      setState.run('pushed', nowIso(now), event.id);
      result.pushed++;
    } else if (emailTo(db, event.recipient, event.title, [event.title, event.detail].filter(Boolean).join('\n\n'), `notify-event-${event.id}`, now)) {
      // No device took it: "now" still means now, by mail.
      setState.run('emailed', nowIso(now), event.id);
      result.emailed++;
    } else {
      setState.run('digest', null, event.id);
      result.held++;
    }
  }

  // Digests: per person with something waiting, inside the window after the
  // configured time on a working day, once per kind and local date.
  const waiting = db.prepare("SELECT DISTINCT recipient FROM notify_events WHERE state = 'digest'").all() as { recipient: string }[];
  for (const { recipient } of waiting) {
    const prefs = effectivePrefs(db, recipient);
    const local = localTime(now, prefs.timezone);
    if (!prefs.workdays.includes(local.weekday)) continue;
    for (const kind of ['briefing', 'wrapup'] as const) {
      const cfg = prefs[kind];
      if (!cfg.enabled) continue;
      const start = toMinutes(cfg.at);
      if (local.minutes < start || local.minutes >= start + DIGEST_WINDOW_MIN) continue;
      const claimed = db
        .prepare('INSERT OR IGNORE INTO notify_digests (recipient, kind, local_date, item_count, created_at) VALUES (?, ?, ?, 0, ?)')
        .run(recipient, kind, local.date, nowIso(now));
      if (claimed.changes === 0) continue;
      const items = db
        .prepare("SELECT * FROM notify_events WHERE recipient = ? AND state = 'digest' ORDER BY id")
        .all(recipient) as EventRow[];
      if (items.length === 0) continue;
      const digestId = (
        db.prepare('SELECT id FROM notify_digests WHERE recipient = ? AND kind = ? AND local_date = ?').get(recipient, kind, local.date) as { id: number }
      ).id;
      db.prepare('UPDATE notify_digests SET item_count = ? WHERE id = ?').run(items.length, digestId);
      const heading =
        kind === 'briefing'
          ? `Good morning — ${items.length} ${items.length === 1 ? 'thing waits' : 'things wait'} for you`
          : `End of day — ${items.length} ${items.length === 1 ? 'thing' : 'things'} came in`;
      let pushed = 0;
      if (prefs.digest_via !== 'email') {
        const lines = items.slice(0, 4).map((e) => `• ${e.title}`);
        if (items.length > 4) lines.push(`… and ${items.length - 4} more`);
        pushed = await pushToPerson(db, deps, recipient, { title: heading, body: lines.join('\n'), module: null, href: null, tag: `digest-${kind}` }, 'normal', now, result);
      }
      // By mail when asked for, and when push was asked for but no device took it.
      if (prefs.digest_via !== 'push' || pushed === 0) {
        const body = items.map((e) => [`• ${e.title}`, e.detail ? `  ${e.detail}` : null].filter(Boolean).join('\n')).join('\n');
        emailTo(db, recipient, heading, body, `notify-digest-${digestId}`, now);
      }
      db.prepare(`UPDATE notify_events SET state = 'digested', delivered_at = ? WHERE recipient = ? AND state = 'digest'`).run(nowIso(now), recipient);
      result.digests++;
    }
  }
  // What was delivered stops being needed after the window the feed shows;
  // titles and details name people and records, so they do not stay forever.
  db.prepare(
    "DELETE FROM notify_events WHERE state NOT IN ('pending','digest') AND created_at < ?",
  ).run(nowIso(now - EVENT_RETENTION_DAYS * 86_400_000));
  return result;
}
