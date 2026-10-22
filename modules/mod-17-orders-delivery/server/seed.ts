import type Database from 'better-sqlite3';
import { createDeliveryNote, createOrder, orderDetail, todayIso } from './orders.js';
import { addDaysIso } from './dates.js';

/**
 * Example data, written THROUGH the domain functions (never raw inserts), so
 * the seeded database satisfies the same invariants as a live one: one order
 * partly delivered, one waiting.
 *
 * Idempotent: if any order exists the seed is skipped entirely.
 */
export function seed(db: Database.Database): void {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM orders').get() as { count: number };
  if (count > 0) {
    console.log(`[seed] database already contains ${count} orders, skipping`);
    return;
  }
  const today = todayIso();
  const first = createOrder(
    db,
    {
      orderDate: addDaysIso(today, -6),
      customer: { name: 'Kunde GmbH', contactPerson: 'Maria Huber', email: 'einkauf@kunde.example', vatId: 'ATU12345678', addressLines: ['Hauptplatz 1', '8010 Graz'] },
      customerReference: 'PO-4711',
      note: null,
      lines: [
        { description: 'Bürostuhl ergonomisch', quantity: 12, unitPriceCents: 24900, discountPercent: 5, vatRate: 20 },
        { description: 'Montage vor Ort', quantity: 1, unitPriceCents: 45000, discountPercent: 0, vatRate: 20 },
      ],
    },
    'seed',
  );
  const lines = orderDetail(db, first).lines;
  createDeliveryNote(db, first, { deliveredOn: addDaysIso(today, -2), note: 'Erste Teillieferung', lines: [{ orderLineId: lines[0]!.id, quantity: 8 }] }, 'seed', today);
  createOrder(
    db,
    {
      orderDate: today,
      customer: { name: 'Beispiel AG', contactPerson: null, email: 'office@beispiel.example', vatId: null, addressLines: ['Ring 5', '1010 Wien'] },
      customerReference: null,
      note: 'Lieferung bitte avisieren',
      lines: [{ description: 'Schreibtisch 160 × 80', quantity: 4, unitPriceCents: 38900, discountPercent: 0, vatRate: 20 }],
    },
    'seed',
  );
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
