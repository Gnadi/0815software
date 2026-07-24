import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { configFromEnv } from './config.js';
import { configure } from './numbering.js';

/** Idempotent demo data: a couple of typical numbering scopes. */
export function seed(db: Database.Database): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM sequences').get() as { n: number };
  if (existing.n > 0) return;

  configure(db, 'invoice', 'INV-{YYYY}-{seq:0000}', 'year');
  configure(db, 'order', 'ORD-{YYYY}-{seq:0000}', 'year');
  console.log('[seed] configured invoice + order sequences');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  seed(db);
}
