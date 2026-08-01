import type Database from 'better-sqlite3';
import type { Contact, ContactRow } from '../shared/types.js';
import { getCompany } from './companies.js';
import { nowIso, requireRow } from './domain.js';
import { likeTerm } from './companies.js';

export interface ContactInput {
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  companyId: number | null;
  createdAt?: string;
}

export function getContact(db: Database.Database, id: number): Contact {
  return requireRow(
    db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Contact | undefined,
    'Contact',
  );
}

/** Today's date as YYYY-MM-DD (used to classify follow-ups as overdue). */
export function today(): string {
  return nowIso().slice(0, 10);
}

export function listContacts(db: Database.Database, opts: { search?: string; companyId?: number } = {}): ContactRow[] {
  const term = opts.search?.trim();
  const where: string[] = [];
  const params: Record<string, unknown> = { today: today() };
  if (term) {
    where.push('(k.name LIKE @s ESCAPE \'\\\' OR k.email LIKE @s ESCAPE \'\\\' OR k.title LIKE @s ESCAPE \'\\\')');
    params.s = likeTerm(term);
  }
  if (opts.companyId) {
    where.push('k.company_id = @companyId');
    params.companyId = opts.companyId;
  }
  return db
    .prepare(
      `SELECT k.*, c.name AS company_name,
              (SELECT COUNT(*) FROM deals d WHERE d.primary_contact_id = k.id) AS deal_count,
              (SELECT COUNT(*) FROM activities a
                 WHERE a.contact_id = k.id AND a.due_date IS NOT NULL AND a.done = 0) AS open_followup_count
       FROM contacts k
       LEFT JOIN companies c ON c.id = k.company_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY k.name`,
    )
    .all(params) as ContactRow[];
}

export function createContact(db: Database.Database, input: ContactInput): number {
  if (input.companyId !== null) getCompany(db, input.companyId);
  const info = db
    .prepare(
      'INSERT INTO contacts (name, email, phone, title, company_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(input.name, input.email, input.phone, input.title, input.companyId, input.createdAt ?? nowIso());
  return Number(info.lastInsertRowid);
}

export function updateContact(db: Database.Database, id: number, input: ContactInput): void {
  getContact(db, id);
  if (input.companyId !== null) getCompany(db, input.companyId);
  db.prepare('UPDATE contacts SET name = ?, email = ?, phone = ?, title = ?, company_id = ? WHERE id = ?').run(
    input.name,
    input.email,
    input.phone,
    input.title,
    input.companyId,
    id,
  );
}

/**
 * Delete a contact. Deals and activities that referenced it keep their
 * history — the FK is set to NULL (ON DELETE SET NULL) so nothing dangles
 * and the deal stays intact.
 */
export function deleteContact(db: Database.Database, id: number): void {
  getContact(db, id);
  db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
}
