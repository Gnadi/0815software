import { createHmac, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';
import type { ProviderEntry } from './provider-registry.js';

/** Compute the expected signature for a provider's scheme. */
export function expectedSignature(entry: ProviderEntry, secret: string, rawBody: string): string {
  const digest = createHmac('sha256', secret)
    .update(rawBody)
    .digest(entry.signature_encoding === 'base64' ? 'base64' : 'hex');
  return `${entry.signature_prefix}${digest}`;
}

export function verifySignature(entry: ProviderEntry, secret: string, rawBody: string, provided: unknown): boolean {
  if (entry.signature_scheme === 'none') return true;
  if (typeof provided !== 'string') return false;
  const expected = expectedSignature(entry, secret, rawBody);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function storeWebhookEvent(
  db: Database.Database,
  opts: { provider: string; eventType: string | null; signatureValid: boolean; payload: string; now: number },
): number {
  const info = db
    .prepare(
      `INSERT INTO webhook_events (provider, connection_id, event_type, signature_valid, payload, status, received_at)
       VALUES (?, NULL, ?, ?, ?, 'received', ?)`,
    )
    .run(opts.provider, opts.eventType, opts.signatureValid ? 1 : 0, opts.payload, nowIso(opts.now));
  return Number(info.lastInsertRowid);
}
