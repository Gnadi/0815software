import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { configFromEnv } from './config.js';
import { createBucket, putObject } from './storage.js';

/** Idempotent demo data: one bucket with a small text object. */
export function seed(db: Database.Database): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM buckets').get() as { n: number };
  if (existing.n > 0) return;

  const at = Date.parse('2026-07-01T09:00:00Z');
  createBucket(db, 'documents', at);
  putObject(
    db,
    { bucket: 'documents', key: 'welcome.txt', content: Buffer.from('Hello from PS-06.\n'), contentType: 'text/plain' },
    at,
  );
  console.log('[seed] inserted 1 bucket, 1 object');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  seed(db);
}
