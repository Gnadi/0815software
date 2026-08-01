import type Database from 'better-sqlite3';
import type { Company, CompanyRow } from '../shared/types.js';
import { DomainError, nowIso, requireRow } from './domain.js';

/** A LIKE pattern that matches the term literally — see the ESCAPE clauses below. */
export function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export interface CompanyInput {
  name: string;
  domain: string | null;
  notes: string | null;
  createdAt?: string;
}

export function getCompany(db: Database.Database, id: number): Company {
  return requireRow(
    db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as Company | undefined,
    'Company',
  );
}

export function listCompanies(db: Database.Database, search?: string): CompanyRow[] {
  const term = search?.trim();
  return db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM contacts k WHERE k.company_id = c.id) AS contact_count,
              (SELECT COUNT(*) FROM deals d WHERE d.company_id = c.id) AS deal_count
       FROM companies c
       ${term ? 'WHERE c.name LIKE @s ESCAPE \'\\\' OR c.domain LIKE @s ESCAPE \'\\\'' : ''}
       ORDER BY c.name`,
    )
    .all(term ? { s: likeTerm(term) } : {}) as CompanyRow[];
}

export function createCompany(db: Database.Database, input: CompanyInput): number {
  const info = db
    .prepare('INSERT INTO companies (name, domain, notes, created_at) VALUES (?, ?, ?, ?)')
    .run(input.name, input.domain, input.notes, input.createdAt ?? nowIso());
  return Number(info.lastInsertRowid);
}

export function updateCompany(db: Database.Database, id: number, input: CompanyInput): void {
  getCompany(db, id);
  db.prepare('UPDATE companies SET name = ?, domain = ?, notes = ? WHERE id = ?').run(
    input.name,
    input.domain,
    input.notes,
    id,
  );
}

/**
 * A company with contacts or deals cannot be deleted — reassign or clear
 * them first (409). Empty companies delete cleanly.
 */
export function deleteCompany(db: Database.Database, id: number): void {
  getCompany(db, id);
  const used = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM contacts WHERE company_id = @id) AS contacts,
              (SELECT COUNT(*) FROM deals WHERE company_id = @id) AS deals`,
    )
    .get({ id }) as { contacts: number; deals: number };
  if (used.contacts > 0 || used.deals > 0) {
    throw new DomainError(
      409,
      `Company has ${used.contacts} contact(s) and ${used.deals} deal(s) — reassign or clear them before deleting`,
    );
  }
  db.prepare('DELETE FROM companies WHERE id = ?').run(id);
}
