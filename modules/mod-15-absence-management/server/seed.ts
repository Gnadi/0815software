import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { configFromEnv } from './config.js';
import { createEmployee, createRequest, setEntitlement, transitionRequest } from './absences.js';

/**
 * Idempotent demo data. A database that already holds employees is never
 * touched, so re-running this is safe.
 *
 * Deliberately spread across regions: a Bavarian, a Berliner and an Austrian
 * booking the same week are charged different numbers of days, and that is the
 * one behaviour of this module a demo has to make visible immediately.
 */
export function seed(db: Database.Database, nowMs: number = Date.now()): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM employees').get() as { n: number };
  if (existing.n > 0) return;

  const at = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const year = Number(at.slice(0, 4));

  const people = [
    { name: 'Anna Berger', email: 'anna.berger@example.de', region: 'DE-BY' as const, base: 30 },
    { name: 'Klara Meyer', email: 'klara.meyer@example.de', region: 'DE-BE' as const, base: 28 },
    { name: 'Lukas Steiner', email: 'l.steiner@example.at', region: 'AT' as const, base: 25 },
    { name: 'Sofia Ranner', email: 'sofia.ranner@example.de', region: 'DE-SN' as const, base: 30 },
  ];

  const ids: number[] = [];
  for (const person of people) {
    const employee = createEmployee(
      db,
      { name: person.name, email: person.email, region: person.region, startedOn: `${year - 3}-04-01` },
      at,
    );
    ids.push(employee.id);
    setEntitlement(
      db,
      {
        employeeId: employee.id,
        year,
        baseDays: person.base,
        carryOverDays: 5,
        // The German and Austrian norm: carry-over lapses at the end of March.
        carryOverExpiresOn: `${year}-03-31`,
        },
      at,
    );
  }

  // The demonstration: one week, three regions, three different day counts.
  // Fronleichnam falls in this week in Bayern and Austria but not in Berlin.
  const approved = createRequest(
    db,
    {
      employeeId: ids[0]!,
      type: 'vacation',
      fromDate: `${year}-08-03`,
      toDate: `${year}-08-14`,
      halfStart: false,
      halfEnd: false,
      note: 'Sommerurlaub',
      actor: 'seed',
    },
    at,
  );
  transitionRequest(db, approved.id, 'approved', 'seed', 'Genehmigt', at);

  createRequest(
    db,
    {
      employeeId: ids[1]!,
      type: 'vacation',
      fromDate: `${year}-09-07`,
      toDate: `${year}-09-11`,
      halfStart: false,
      halfEnd: true,
      note: 'Kurzurlaub',
      actor: 'seed',
    },
    at,
  );

  // Sick leave lands approved with no approver, and does not touch the balance.
  createRequest(
    db,
    {
      employeeId: ids[2]!,
      type: 'sick',
      fromDate: `${year}-05-04`,
      toDate: `${year}-05-06`,
      halfStart: false,
      halfEnd: false,
      note: 'Grippe',
      actor: 'seed',
    },
    at,
  );

  console.log(`[seed] created ${people.length} employees with ${year} entitlements and 3 requests`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  seed(db);
}
