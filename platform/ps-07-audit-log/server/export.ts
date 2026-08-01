import type Database from 'better-sqlite3';

/**
 * Subject access and portability (GDPR Art. 15 / 20).
 *
 * The audit log holds two kinds of record about a person: the ones they caused
 * (they are the `actor`) and the ones about them (their identifier appears in
 * the resource or inside a before/after snapshot). Both are disclosable, so
 * both are searched — the second by substring, because what a snapshot embeds
 * is not something this service can index in advance.
 *
 * An export never deletes: the chain's whole value is that it is append-only.
 * Erasing from an audit trail is a different question with a different answer
 * — the retention window, see `pruneForRetention`.
 */

export interface SubjectExport {
  service: string;
  subject: string;
  exported_at: string;
  /** Empty when this service holds nothing about them — itself a real answer. */
  records: Record<string, unknown[]>;
}

export function exportSubject(db: Database.Database, subject: string, at: string): SubjectExport {
  const needle = subject.trim().toLowerCase();
  const records: Record<string, unknown[]> = {};

  records.events_as_actor = db
    .prepare('SELECT * FROM audit_events WHERE LOWER(actor) = ? ORDER BY id')
    .all(needle);

  // Escaped: an address holds no wildcards, but the subject is caller input,
  // and a bare "%" would otherwise hand back the entire log.
  const like = `%${needle.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  records.events_mentioning = db
    .prepare(
      `SELECT * FROM audit_events
        WHERE LOWER(actor) <> ?
          AND (LOWER(resource) LIKE ? ESCAPE '\\'
            OR LOWER(before_json) LIKE ? ESCAPE '\\'
            OR LOWER(after_json) LIKE ? ESCAPE '\\'
            OR LOWER(metadata) LIKE ? ESCAPE '\\')
        ORDER BY id`,
    )
    .all(needle, like, like, like, like);

  for (const [key, value] of Object.entries(records)) {
    if (value.length === 0) delete records[key];
  }
  return { service: 'ps-07-audit-log', subject: needle, exported_at: at, records };
}
