import type Database from 'better-sqlite3';
import { createItem, transitionItem } from './items.js';

/**
 * Example data, written THROUGH the domain functions (never raw inserts), so
 * the seeded database satisfies the same invariants as a live one.
 *
 * Idempotent: if any item exists the seed is skipped entirely.
 */
export function seed(db: Database.Database): void {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM items').get() as { count: number };
  if (count > 0) {
    console.log(`[seed] database already contains ${count} items, skipping`);
    return;
  }
  createItem(db, { title: 'Replace the example domain', notes: 'server/items.ts, server/db.ts, shared/types.ts' }, 'seed');
  createItem(db, { title: 'Write the access rules', notes: 'server/access.ts — what needs manage?' }, 'seed');
  const third = createItem(db, { title: 'Fill in the README', notes: null }, 'seed');
  transitionItem(db, third.id, 'done', 'seed');
}

// CLI entry: npm run seed
const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { openDb } = await import('./db.js');
  const { configFromEnv } = await import('./config.js');
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  seed(db);
  db.close();
  console.log(`[seed] done — database at ${config.databasePath}`);
}
