import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { configFromEnv } from './config.js';
import { indexDoc } from './search.js';

/** Idempotent demo data: a few indexed products. */
export function seed(db: Database.Database): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM search').get() as { n: number };
  if (existing.n > 0) return;

  indexDoc(db, { collection: 'products', id: '1', title: 'Blue Widget', body: 'A sturdy blue widget', facets: { category: 'widgets', color: 'blue' } });
  indexDoc(db, { collection: 'products', id: '2', title: 'Red Widget', body: 'A bright red widget', facets: { category: 'widgets', color: 'red' } });
  indexDoc(db, { collection: 'products', id: '3', title: 'Blue Gadget', body: 'A compact blue gadget', facets: { category: 'gadgets', color: 'blue' } });
  console.log('[seed] indexed 3 demo products');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  seed(db);
}
