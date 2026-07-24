import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { configFromEnv } from './config.js';
import { recordEvent } from './audit.js';

/**
 * Idempotent demo data: a few chained audit events. Re-running is a no-op
 * once any event exists (the chain must not be seeded twice).
 */
export function seed(db: Database.Database): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number };
  if (existing.n > 0) return;

  const base = Date.parse('2026-07-01T09:00:00Z');
  recordEvent(db, { actor: 'user:1', org: 'acme', action: 'invoice.created', resource: 'invoice:INV-001', after: { total: 100 } }, base);
  recordEvent(db, { actor: 'user:1', org: 'acme', action: 'invoice.sent', resource: 'invoice:INV-001', metadata: { channel: 'email' } }, base + 60_000);
  recordEvent(db, { actor: 'user:2', org: 'acme', action: 'invoice.paid', resource: 'invoice:INV-001', before: { status: 'sent' }, after: { status: 'paid' } }, base + 120_000);

  console.log('[seed] inserted 3 chained audit events');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  seed(db);
}
