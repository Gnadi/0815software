import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { configFromEnv } from './config.js';
import { createIntent, settleProcessing, confirmIntent } from './payments.js';
import { mockProvider } from './providers/mock.js';

/** Idempotent demo data: one settled payment against the mock PSP. */
export async function seed(db: Database.Database): Promise<void> {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM payment_intents').get() as { n: number };
  if (existing.n > 0) return;

  const at = Date.parse('2026-07-01T09:00:00Z');
  const { row } = createIntent(db, { reference: 'invoice:INV-001', amountMinor: 12_000, currency: 'EUR', provider: 'mock', idempotencyKey: 'seed-1' }, at);
  await confirmIntent(db, mockProvider, row, at);
  settleProcessing(db, at + 1000);
  console.log('[seed] inserted 1 settled payment intent');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  void seed(db);
}
