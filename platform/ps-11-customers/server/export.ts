import type Database from 'better-sqlite3';
import { listRefs } from './parties.js';

/**
 * Subject access and portability (GDPR Art. 15 / 20).
 *
 * PS-11 holds the PRIMARY copy of a counterparty's identity — not a mirror —
 * so for anyone the modules bill or buy from, this service is where most of
 * "everything you hold about me" lives. Erasure was already answerable; being
 * asked to hand the data over was not.
 *
 * A party is looked up the way a data subject can identify themselves: by
 * email, or by an exact party id when the operator already knows it. Parties
 * that were merged away are included too — their rows still carry the identity
 * that was merged, and a subject is entitled to those as well.
 */

export interface SubjectExport {
  service: string;
  subject: string;
  exported_at: string;
  /** Empty when this service holds nothing about them — itself a real answer. */
  records: Record<string, unknown[]>;
}

export function exportSubject(db: Database.Database, subject: string, at: string): SubjectExport {
  const email = subject.trim().toLowerCase();
  const byId = /^\d+$/.test(email) ? Number(email) : null;

  const parties = (
    byId === null
      ? db.prepare("SELECT * FROM parties WHERE LOWER(IFNULL(email, '')) = ? ORDER BY id").all(email)
      : db.prepare('SELECT * FROM parties WHERE id = ?').all(byId)
  ) as { id: number }[];

  const records: Record<string, unknown[]> = {};
  if (parties.length > 0) {
    records.parties = parties;
    // The per-module references are part of the answer: they say WHICH other
    // systems in this deployment hold a row about the same person.
    records.references = parties.flatMap((party) => listRefs(db, party.id));
    // A party merged into this one carries the same identity under another id.
    const ids = parties.map((p) => p.id);
    records.merged_away = db
      .prepare(`SELECT * FROM parties WHERE merged_into IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
      .all(...ids);
  }

  for (const [key, value] of Object.entries(records)) {
    if (value.length === 0) delete records[key];
  }
  return { service: 'ps-11-customers', subject: email, exported_at: at, records };
}
