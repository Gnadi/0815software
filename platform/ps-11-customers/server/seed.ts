import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { configFromEnv } from './config.js';
import { cleanInput, createParty } from './parties.js';

/**
 * Idempotent demo data: a couple of customer parties and the stack owner's own
 * `self` party, so a fresh service is usable — and so the seller identity has a
 * value before an operator fills in the real one. A database that already holds
 * parties is never touched.
 */
export function seed(db: Database.Database): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM parties').get() as { n: number };
  if (existing.n > 0) return;

  createParty(
    db,
    cleanInput({
      kind: 'self',
      name: '0815software GmbH',
      email: 'office@0815software.example.at',
      vat_id: 'ATU00000000',
      address_lines: ['Beispielgasse 8/15', '1010 Wien', 'Austria'],
      iban: 'AT00 0000 0000 0000 0000',
      bic: 'EXAMPLEX',
    }),
  );
  createParty(
    db,
    cleanInput({
      name: 'Blaustern Café GmbH',
      contact_person: 'Anna Berger',
      email: 'buchhaltung@blaustern.example',
      vat_id: 'ATU12345678',
      address_lines: ['Hauptstraße 12', '5020 Salzburg', 'Austria'],
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
    }),
  );
  console.log('[seed] created the self party and 2 customer parties');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  seed(db);
}
