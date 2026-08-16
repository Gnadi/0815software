import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { configFromEnv } from './config.js';
import { addMessage, createCase, transitionCase } from './cases.js';
import { addDays, addMonths, nowIso } from './deadlines.js';

/**
 * Idempotent demo data. A database that already holds cases is never touched.
 *
 * The dates are RELATIVE to seed time, so the derived deadline states are the
 * same whenever you seed: one case comfortably inside its window, one about
 * to breach the seven-day acknowledgement, one that already has, and one
 * concluded. A demo whose clock has drifted shows nothing.
 */
export function seed(db: Database.Database, nowMs: number = Date.now()): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number };
  if (existing.n > 0) return;

  const now = nowIso(nowMs);

  // 1. Filed yesterday, untouched. Acknowledgement still comfortably open.
  createCase(
    db,
    {
      category: 'corruption',
      subject: 'Einkäufer nimmt Geschenke eines Lieferanten an',
      body:
        'Ein Kollege im Einkauf hat im letzten Quartal mehrfach Einladungen und Sachgeschenke ' +
        'eines Lieferanten angenommen. Kurz darauf wurde derselbe Lieferant ohne Vergleichs' +
        'angebot beauftragt. Ich möchte anonym bleiben.',
      contact: null,
    },
    addDays(now, -1),
  );

  // 2. Filed six days ago, still not acknowledged — at risk, one day left.
  createCase(
    db,
    {
      category: 'workplace_safety',
      subject: 'Defekte Absturzsicherung in Halle 2 wird nicht repariert',
      body:
        'Die Absturzsicherung an der Bühne in Halle 2 ist seit Wochen defekt. Meldungen an die ' +
        'Schichtleitung sind ohne Reaktion geblieben.',
      contact: null,
    },
    addDays(now, -6),
  );

  // 3. Filed nine days ago and never acknowledged — the deadline is MISSED,
  //    and the feedback clock has already started from the seven-day expiry.
  createCase(
    db,
    {
      category: 'data_protection',
      subject: 'Kundendaten auf einem privaten Laufwerk',
      body: 'Ein Export der Kundendatenbank liegt auf einem privaten Cloud-Laufwerk eines Mitarbeiters.',
      contact: 'nur über den Zugangscode',
    },
    addDays(now, -9),
  );

  // 4. Handled properly end to end, four months back: acknowledged inside the
  //    week, feedback given, concluded. The reference case.
  const handled = createCase(
    db,
    {
      category: 'fraud',
      subject: 'Auffällige Spesenabrechnungen im Vertrieb',
      body: 'Mehrere Spesenabrechnungen enthalten Belege, die zweimal eingereicht wurden.',
      contact: null,
    },
    addMonths(now, -4),
  );
  const handledId = (db.prepare('SELECT id FROM cases WHERE ref = ?').get(handled.ref) as { id: number }).id;
  transitionCase(db, handledId, 'acknowledged', 'seed', null, addDays(addMonths(now, -4), 2));
  transitionCase(db, handledId, 'investigating', 'seed', null, addDays(addMonths(now, -4), 3));
  addMessage(
    db,
    handledId,
    {
      actor: 'seed',
      actorType: 'handler',
      visibility: 'reporter',
      body: 'Wir haben die Abrechnungen des genannten Zeitraums geprüft und die Belege abgeglichen.',
    },
    addDays(addMonths(now, -4), 20),
  );
  addMessage(
    db,
    handledId,
    { actor: 'seed', actorType: 'handler', visibility: 'internal', body: 'Interne Notiz: Rücksprache mit der Revision.' },
    addDays(addMonths(now, -4), 21),
  );
  transitionCase(db, handledId, 'closed', 'seed', 'partly_substantiated', addDays(addMonths(now, -4), 40));

  console.log('[seed] created 4 cases across the deadline states');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  seed(db);
}
