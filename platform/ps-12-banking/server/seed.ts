import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { configFromEnv } from './config.js';
import { REGISTRY } from './bank-registry.js';

/**
 * There is no demo data here, and that is deliberate.
 *
 * Every other service in the catalogue seeds something usable so a fresh
 * checkout has a screen worth looking at. This one cannot: a bank connection
 * only becomes real through a key exchange with an actual bank and a letter
 * signed by hand, and a seeded one would be a row that looks like a bank
 * connection, cannot ever reach `ready`, and is sitting in the same table as
 * the ones that can move money.
 *
 * So `seed` opens the database, lets the migrations run, and says what the
 * first real step is.
 */
export async function seed(db: Database.Database): Promise<void> {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM bank_connections').get() as { n: number };
  if (existing.n > 0) return;
  console.log(
    `[seed] no demo data — a bank connection needs a real EBICS contract. ${REGISTRY.length} bank profiles are ` +
      'available at GET /api/banks; start with POST /api/connections using the host, partner and user ids from ' +
      'the contract your bank sent you.',
  );
  await Promise.resolve();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  void seed(db);
}
