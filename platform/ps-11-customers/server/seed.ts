import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { configFromEnv } from './config.js';
import { cleanInput, createParty } from './parties.js';

/**
 * Idempotent demo data: a couple of customer parties and a supplier, so a fresh
 * service is usable. A database that already holds parties is never touched.
 *
 * Deliberately NO `self` party. Modules fall back to their own SELLER_* env when
 * PS-11 has none, so seeding a demo seller here would silently replace a
 * customer's configured letterhead with "0815software GmbH" the moment PS-11
 * joined their stack. The operator sets it once, with PUT /api/self.
 */
export function seed(db: Database.Database): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM parties').get() as { n: number };
  if (existing.n > 0) return;

  createParty(
    db,
    cleanInput({
      name: 'Blaustern Café GmbH',
      contact_person: 'Anna Berger',
      email: 'buchhaltung@blaustern.example',
      vat_id: 'ATU12345678',
      address_lines: ['Hauptstraße 12', '5020 Salzburg', 'Austria'],
      street: 'Hauptstraße 12',
      postcode: '5020',
      city: 'Salzburg',
      country_code: 'AT',
    }),
  );
  createParty(
    db,
    cleanInput({
      name: 'Nordwind AG',
      contact_person: 'Klara Meyer',
      email: 'rechnungen@nordwind.example',
      vat_id: 'DE811234567',
      address_lines: ['Hafenstraße 4', '20359 Hamburg', 'Germany'],
      street: 'Hafenstraße 4',
      postcode: '20359',
      city: 'Hamburg',
      country_code: 'DE',
    }),
  );
  createParty(
    db,
    cleanInput({
      kind: 'supplier',
      name: 'Auer & Söhne Maschinenbau GmbH',
      contact_person: 'Franz Auer',
      email: 'verkauf@auer-soehne.example.at',
      vat_id: 'ATU87654321',
      address_lines: ['Industriestraße 22', '4020 Linz', 'Austria'],
      street: 'Industriestraße 22',
      postcode: '4020',
      city: 'Linz',
      country_code: 'AT',
    }),
  );
  console.log('[seed] created 2 customer parties and 1 supplier party');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  seed(db);
}
