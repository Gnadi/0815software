import { createHmac, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';

/** HMAC-SHA256 hex of the raw body, keyed by the shared webhook secret. */
export function expectedSignature(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifySignature(secret: string, rawBody: string, provided: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedSignature(secret, rawBody));
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
