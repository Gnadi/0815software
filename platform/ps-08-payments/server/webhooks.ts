import { createHmac, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';

/** HMAC-SHA256 hex of the raw body, keyed by the shared webhook secret.
 *  Used by the generic/mock provider (`X-Signature`). */
export function expectedSignature(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifySignature(secret: string, rawBody: string, provided: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedSignature(secret, rawBody));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Stripe's real webhook scheme: the signature covers `${timestamp}.${rawBody}`,
 * and is presented as `Stripe-Signature: t=<unixSeconds>,v1=<hexHmac>`. The
 * timestamp lets the receiver reject replays outside a tolerance window.
 */
export function stripeSignatureHeader(secret: string, rawBody: string, timestampSec: number): string {
  const v1 = createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`).digest('hex');
  return `t=${timestampSec},v1=${v1}`;
}

export function verifyStripeSignature(
  secret: string,
  rawBody: string,
  header: string | undefined,
  nowMs: number,
  toleranceSec = 300,
): boolean {
  if (typeof header !== 'string') return false;
  const parts: Record<string, string> = {};
  for (const kv of header.split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || typeof v1 !== 'string') return false;
  // Replay protection: reject stale or future-dated timestamps.
  if (Math.abs(Math.floor(nowMs / 1000) - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(v1);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function storeWebhookEvent(
  db: Database.Database,
  opts: { provider: string; eventType: string | null; intentPublicId: string | null; signatureValid: boolean; payload: string; now: number },
): number {
  const info = db
    .prepare(
      `INSERT INTO webhook_events (provider, event_type, intent_public_id, signature_valid, payload, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(opts.provider, opts.eventType, opts.intentPublicId, opts.signatureValid ? 1 : 0, opts.payload, nowIso(opts.now));
  return Number(info.lastInsertRowid);
}
