import type Database from 'better-sqlite3';
import { userRoles } from './identity.js';
import type { UserRow } from './identity.js';

/**
 * Subject access and portability (GDPR Art. 15 / 20).
 *
 * Erasure has been answerable for a while; "give me everything you hold about
 * me" was not. A controller who gets that request has to be able to answer it
 * from the deployment, and reading it out of SQLite by hand under a one-month
 * deadline is not an answer.
 *
 * This returns what THIS service holds about one person, keyed by the only
 * identifier a data subject actually has: their email address. It is a read —
 * nothing is deleted, and the caller needs `user:read`, because an export is
 * every bit as sensitive as the records it copies.
 */

export interface SubjectExport {
  /** Which service produced this, so an assembled report is traceable. */
  service: string;
  subject: string;
  exported_at: string;
  /** Empty when this service holds nothing about them — a real answer. */
  records: Record<string, unknown[]>;
}

export function exportSubject(
  db: Database.Database,
  orgId: number,
  subject: string,
  at: string,
): SubjectExport {
  const email = subject.trim().toLowerCase();
  const records: Record<string, unknown[]> = {};

  const user = db.prepare('SELECT * FROM users WHERE org_id = ? AND email = ?').get(orgId, email) as
    | UserRow
    | undefined;

  if (user) {
    // The password hash is deliberately absent: it is data ABOUT them that
    // discloses a credential, and Art. 15 does not require handing it over.
    records.user = [
      {
        id: user.id,
        org_id: user.org_id,
        email: user.email,
        name: user.name,
        status: user.status,
        created_at: user.created_at,
      },
    ];
    records.roles = userRoles(db, user.id).map((role) => ({ key: role.key, name: role.name }));
    records.auth_events = db
      .prepare('SELECT id, type, ip, meta, created_at FROM auth_events WHERE user_id = ? ORDER BY id')
      .all(user.id);
    records.api_keys = db
      .prepare('SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE created_by = ? ORDER BY id')
      .all(user.id);
  }

  // Failed logins carry the typed address in their meta, so they exist even
  // when no account does — someone repeatedly mistyping their own address
  // leaves a trace under it, and that trace is about them.
  //
  // Scoped to the caller's organization like everything else here. Without the
  // scope this was the one query in the service that read across tenants: a
  // failed login against ANOTHER organization records that org's id and a null
  // user (the address has no account there), so any administrator could ask for
  // any address and read back the IP addresses of attempts aimed at a customer
  // they have nothing to do with. Attempts against an organization that does
  // not exist at all carry no org id and belong to nobody, so they are not
  // reported here either.
  records.failed_logins = db
    .prepare(
      `SELECT id, type, ip, meta, created_at FROM auth_events
        WHERE user_id IS NULL AND org_id = ? AND json_extract(meta, '$.email') = ? ORDER BY id`,
    )
    .all(orgId, email);

  for (const [key, value] of Object.entries(records)) {
    if (value.length === 0) delete records[key];
  }
  return { service: 'ps-01-identity', subject: email, exported_at: at, records };
}
