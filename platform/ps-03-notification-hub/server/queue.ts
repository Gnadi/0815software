import type Database from 'better-sqlite3';
import type { Channel, ChannelType, Message, MessageStatus } from '../shared/types.js';
import { nowIso } from './auth.js';
import { nextBackoffMs } from './retry.js';
import type { ProviderResolver } from './providers/index.js';
import { checkEgressTarget, enforceEgress, OPEN_EGRESS, type EgressPolicy, type ResolveHost } from './egress.js';

export interface ChannelRow {
  id: number;
  type: string;
  name: string;
  provider: string;
  config: string;
  enabled: number;
  created_at: string;
}

export interface MessageRow {
  id: number;
  channel_id: number;
  template_key: string | null;
  to_address: string;
  subject: string | null;
  body: string;
  variables: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  provider_message_id: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

export function mapChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    type: row.type as ChannelType,
    name: row.name,
    provider: row.provider,
    config: JSON.parse(row.config) as Record<string, unknown>,
    enabled: row.enabled === 1,
    created_at: row.created_at,
  };
}

export function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    channel_id: row.channel_id,
    template_key: row.template_key,
    to_address: row.to_address,
    subject: row.subject,
    body: row.body,
    status: row.status as MessageStatus,
    attempts: row.attempts,
    next_attempt_at: row.next_attempt_at,
    last_error: row.last_error,
    provider_message_id: row.provider_message_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    sent_at: row.sent_at,
  };
}

function appendEvent(db: Database.Database, messageId: number, type: string, meta: Record<string, unknown>, now: number): void {
  db.prepare('INSERT INTO message_events (message_id, type, meta, created_at) VALUES (?, ?, ?, ?)').run(
    messageId,
    type,
    JSON.stringify(meta),
    nowIso(now),
  );
}

export interface EnqueueResult {
  message: MessageRow;
  created: boolean;
}

export function enqueue(
  db: Database.Database,
  opts: {
    channelId: number;
    templateKey: string | null;
    to: string;
    subject: string | null;
    body: string;
    variables: Record<string, unknown>;
    idempotencyKey: string | null;
    now: number;
  },
): EnqueueResult {
  if (opts.idempotencyKey !== null) {
    const existing = db
      .prepare('SELECT * FROM messages WHERE idempotency_key = ?')
      .get(opts.idempotencyKey) as MessageRow | undefined;
    if (existing) return { message: existing, created: false };
  }
  const at = nowIso(opts.now);
  const info = db
    .prepare(
      `INSERT INTO messages
         (channel_id, template_key, to_address, subject, body, variables, status,
          attempts, next_attempt_at, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
    )
    .run(
      opts.channelId,
      opts.templateKey,
      opts.to,
      opts.subject,
      opts.body,
      JSON.stringify(opts.variables),
      at,
      opts.idempotencyKey,
      at,
      at,
    );
  const id = Number(info.lastInsertRowid);
  appendEvent(db, id, 'queued', {}, opts.now);
  return { message: db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow, created: true };
}

export interface QueueResult {
  sent: number;
  failed: number;
  dead: number;
  pruned: number;
}

/**
 * Retention: delete terminal messages (sent or dead) older than
 * `retentionDays`. Their bodies carry recipient PII, so a per-customer window
 * bounds how long that data is retained. Returns the number removed.
 */
export function pruneMessages(db: Database.Database, retentionDays: number, now = Date.now()): number {
  if (!retentionDays || retentionDays <= 0) return 0;
  const cutoff = nowIso(now - retentionDays * 86_400_000);
  const info = db
    .prepare(`DELETE FROM messages WHERE status IN ('sent','dead') AND created_at < ?`)
    .run(cutoff);
  return info.changes;
}

/**
 * One tick at a time, per process.
 *
 * A message is only marked attempted AFTER the provider call returns, so two
 * overlapping ticks — the internal ticker and a `POST /api/tick`, or one slow
 * provider and the next timer firing — both pick up the same queued rows and
 * send every message twice. Since "twice" here means a customer receiving two
 * copies of the same invoice mail, callers queue behind the run in flight.
 */
let tickInFlight: Promise<unknown> = Promise.resolve();

export interface TickOptions {
  /** Which chat-webhook targets a channel may post to. */
  egress?: EgressPolicy;
  /** Injectable DNS resolution for the egress check (tests). */
  resolveHost?: ResolveHost;
}

export function tick(
  db: Database.Database,
  resolve: ProviderResolver,
  now = Date.now(),
  retentionDays = 0,
  options: TickOptions = {},
): Promise<QueueResult> {
  const run = tickInFlight.then(
    () => drainDue(db, resolve, now, retentionDays, options),
    () => drainDue(db, resolve, now, retentionDays, options),
  );
  tickInFlight = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Attempt every due message once, applying backoff / dead-lettering, then
 *  prune terminal messages past the retention window. */
async function drainDue(
  db: Database.Database,
  resolve: ProviderResolver,
  now: number,
  retentionDays: number,
  options: TickOptions = {},
): Promise<QueueResult> {
  const egress = options.egress ?? OPEN_EGRESS;
  const at = nowIso(now);
  const due = db
    .prepare(
      `SELECT * FROM messages WHERE status IN ('queued','failed') AND next_attempt_at <= ? ORDER BY id`,
    )
    .all(at) as MessageRow[];

  const result: QueueResult = { sent: 0, failed: 0, dead: 0, pruned: 0 };

  for (const m of due) {
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(m.channel_id) as ChannelRow | undefined;
    if (!channel) continue;
    const attempts = m.attempts + 1;
    appendEvent(db, m.id, 'attempted', { attempt: attempts }, now);

    // A chat channel (Slack, Teams, Discord) posts to a URL configured on the
    // channel, so it is an outbound target like any other and gets judged the
    // same way. A refused one fails the message rather than the whole tick.
    const channelConfig = JSON.parse(channel.config) as Record<string, unknown>;
    const target = typeof channelConfig.url === 'string' ? channelConfig.url : null;
    if (target !== null) {
      const verdict = await checkEgressTarget(target, egress, options.resolveHost);
      if (!enforceEgress(verdict, egress, 'ps-03', target)) {
        db.prepare(
          `UPDATE messages SET status = 'dead', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        ).run(attempts, `refused by egress policy: ${verdict.reason ?? 'internal target'}`, at, m.id);
        appendEvent(db, m.id, 'dead', { error: verdict.reason }, now);
        result.dead++;
        continue;
      }
    }

    const provider = resolve({ provider: channel.provider, config: JSON.parse(channel.config) });
    const outcome = await provider.send({
      channelType: channel.type as ChannelType,
      to: m.to_address,
      subject: m.subject,
      body: m.body,
      config: JSON.parse(channel.config) as Record<string, unknown>,
    });

    if (outcome.ok) {
      db.prepare(
        `UPDATE messages SET status = 'sent', attempts = ?, provider_message_id = ?, last_error = NULL,
           sent_at = ?, updated_at = ? WHERE id = ?`,
      ).run(attempts, outcome.providerMessageId ?? null, at, at, m.id);
      appendEvent(db, m.id, 'sent', { provider: provider.name }, now);
      result.sent++;
      continue;
    }

    const backoff = nextBackoffMs(attempts);
    if (backoff === null) {
      db.prepare(`UPDATE messages SET status = 'dead', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`).run(
        attempts,
        outcome.error ?? 'delivery failed',
        at,
        m.id,
      );
      appendEvent(db, m.id, 'dead', { error: outcome.error }, now);
      result.dead++;
    } else {
      db.prepare(
        `UPDATE messages SET status = 'failed', attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
      ).run(attempts, outcome.error ?? 'delivery failed', nowIso(now + backoff), at, m.id);
      appendEvent(db, m.id, 'failed', { error: outcome.error }, now);
      result.failed++;
    }
  }

  result.pruned = pruneMessages(db, retentionDays, now);
  return result;
}
