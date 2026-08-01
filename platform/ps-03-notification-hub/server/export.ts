import type Database from 'better-sqlite3';

/**
 * Subject access and portability (GDPR Art. 15 / 20).
 *
 * What PS-03 holds about a person is what was SENT to them: the address, the
 * subject line and the body — which for an invoice mail or a ticket reply is
 * personal data with content, not just metadata. `RETENTION_DAYS` ages the
 * terminal ones out; whatever is still here is still disclosable.
 *
 * The subject is the recipient address, which is exactly how these rows are
 * keyed, so nothing has to be guessed at.
 */

export interface SubjectExport {
  service: string;
  subject: string;
  exported_at: string;
  /** Empty when this service holds nothing about them — itself a real answer. */
  records: Record<string, unknown[]>;
}

export function exportSubject(db: Database.Database, subject: string, at: string): SubjectExport {
  const address = subject.trim().toLowerCase();
  const records: Record<string, unknown[]> = {};

  const messages = db
    .prepare(
      `SELECT id, channel_id, template_key, to_address, subject, body, status, attempts,
              last_error, created_at, updated_at, sent_at
         FROM messages WHERE LOWER(to_address) = ? ORDER BY id`,
    )
    .all(address) as { id: number }[];

  if (messages.length > 0) {
    records.messages = messages;
    const ids = messages.map((m) => m.id);
    records.message_events = db
      .prepare(`SELECT * FROM message_events WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
      .all(...ids);
  }

  for (const [key, value] of Object.entries(records)) {
    if (value.length === 0) delete records[key];
  }
  return { service: 'ps-03-notification-hub', subject: address, exported_at: at, records };
}
