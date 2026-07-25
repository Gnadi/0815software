import type Database from 'better-sqlite3';
import type { Delivery, DeliveryStatus, Webhook } from '../shared/types.js';
import { hmacSign, nowIso } from './auth.js';
import { nextBackoffMs } from './retry.js';

export interface WebhookRow {
  id: number;
  event_type: string;
  url: string;
  secret: string;
  active: number;
  created_at: string;
}

export interface DeliveryRow {
  id: number;
  webhook_id: number;
  event_type: string;
  payload: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  response_status: number | null;
  created_at: string;
  updated_at: string;
}

export function mapWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    event_type: row.event_type,
    url: row.url,
    active: row.active === 1,
    created_at: row.created_at,
  };
}

export function mapDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    webhook_id: row.webhook_id,
    status: row.status as DeliveryStatus,
    attempts: row.attempts,
    next_attempt_at: row.next_attempt_at,
    last_error: row.last_error,
    response_status: row.response_status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** A minimal, injectable HTTP client so tests never touch the network. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status };
};

/** Enqueue one delivery per active webhook subscribed to `eventType`. */
export function enqueueDeliveries(
  db: Database.Database,
  eventType: string,
  payload: unknown,
  now = Date.now(),
): number {
  const hooks = db
    .prepare('SELECT * FROM webhooks WHERE event_type = ? AND active = 1')
    .all(eventType) as WebhookRow[];
  const at = nowIso(now);
  const body = JSON.stringify({ event_type: eventType, payload });
  const stmt = db.prepare(
    `INSERT INTO webhook_deliveries
       (webhook_id, event_type, payload, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
  );
  for (const hook of hooks) stmt.run(hook.id, eventType, body, at, at, at);
  return hooks.length;
}

export interface DispatchResult {
  delivered: number;
  failed: number;
  dead: number;
}

/** Attempt every due delivery once, applying backoff / dead-lettering. */
export async function dispatch(
  db: Database.Database,
  fetchImpl: FetchLike = defaultFetch,
  now = Date.now(),
): Promise<DispatchResult> {
  const at = nowIso(now);
  const due = db
    .prepare(
      `SELECT * FROM webhook_deliveries
       WHERE status IN ('pending', 'failed') AND next_attempt_at <= ?
       ORDER BY id`,
    )
    .all(at) as DeliveryRow[];

  const result: DispatchResult = { delivered: 0, failed: 0, dead: 0 };

  for (const d of due) {
    const hook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(d.webhook_id) as
      | WebhookRow
      | undefined;
    if (!hook) continue;
    const attempts = d.attempts + 1;

    let ok = false;
    let responseStatus: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetchImpl(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': hmacSign(d.payload, hook.secret),
        },
        body: d.payload,
      });
      responseStatus = res.status;
      ok = res.ok;
      if (!ok) error = `HTTP ${res.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    if (ok) {
      db.prepare(
        `UPDATE webhook_deliveries
         SET status = 'delivered', attempts = ?, response_status = ?, last_error = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(attempts, responseStatus, at, d.id);
      result.delivered++;
      continue;
    }

    const backoff = nextBackoffMs(attempts);
    if (backoff === null) {
      db.prepare(
        `UPDATE webhook_deliveries
         SET status = 'dead', attempts = ?, response_status = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      ).run(attempts, responseStatus, error, at, d.id);
      result.dead++;
    } else {
      db.prepare(
        `UPDATE webhook_deliveries
         SET status = 'failed', attempts = ?, response_status = ?, last_error = ?,
             next_attempt_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(attempts, responseStatus, error, nowIso(now + backoff), at, d.id);
      result.failed++;
    }
  }

  return result;
}
