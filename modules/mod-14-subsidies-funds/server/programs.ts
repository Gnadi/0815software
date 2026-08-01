import type Database from 'better-sqlite3';
import { categoryLabel, type ProgramDetail, type ProgramRow, type ProgramStatus } from '../shared/types.js';
import { applicationsForProgram } from './applications.js';
import { DomainError, nowIso, requireRow } from './core.js';
import { likeTerm } from './applications.js';

interface ProgramStoredRow {
  id: number;
  name: string;
  funding_body: string;
  category: string;
  description: string | null;
  funding_rate: number;
  max_grant_cents: number;
  currency: string;
  application_deadline: string | null;
  status: ProgramStatus;
  created_at: string;
}

export interface ProgramInput {
  name: string;
  fundingBody: string;
  category: string;
  description: string | null;
  fundingRate: number;
  maxGrantCents: number;
  applicationDeadline: string | null;
  status: ProgramStatus;
  createdAt?: string;
}

export function getProgramRow(db: Database.Database, id: number): ProgramStoredRow {
  return requireRow(
    db.prepare('SELECT * FROM programs WHERE id = ?').get(id) as ProgramStoredRow | undefined,
    'Funding program',
  );
}

function applicationCount(db: Database.Database, programId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM applications WHERE program_id = ?')
    .get(programId) as { n: number };
  return row.n;
}

function toRow(db: Database.Database, program: ProgramStoredRow): ProgramRow {
  return {
    id: program.id,
    name: program.name,
    funding_body: program.funding_body,
    category: program.category,
    category_label: categoryLabel(program.category),
    description: program.description,
    funding_rate: program.funding_rate,
    max_grant_cents: program.max_grant_cents,
    currency: program.currency,
    application_deadline: program.application_deadline,
    status: program.status,
    application_count: applicationCount(db, program.id),
    created_at: program.created_at,
  };
}

export function listPrograms(
  db: Database.Database,
  opts: { status?: ProgramStatus; category?: string; search?: string } = {},
): ProgramRow[] {
  const search = opts.search?.trim();
  const programs = db
    .prepare(
      `SELECT * FROM programs
       ${search ? 'WHERE name LIKE @s ESCAPE \'\\\' OR funding_body LIKE @s ESCAPE \'\\\'' : ''}
       ORDER BY status, name`,
    )
    .all(search ? { s: likeTerm(search) } : {}) as ProgramStoredRow[];
  let rows = programs.map((p) => toRow(db, p));
  if (opts.status) rows = rows.filter((r) => r.status === opts.status);
  if (opts.category) rows = rows.filter((r) => r.category === opts.category);
  return rows;
}

export function programDetail(db: Database.Database, id: number): ProgramDetail {
  const program = getProgramRow(db, id);
  return { ...toRow(db, program), applications: applicationsForProgram(db, id) };
}

export function createProgram(db: Database.Database, input: ProgramInput): number {
  const info = db
    .prepare(
      `INSERT INTO programs
        (name, funding_body, category, description, funding_rate, max_grant_cents, currency, application_deadline, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?)`,
    )
    .run(
      input.name,
      input.fundingBody,
      input.category,
      input.description,
      input.fundingRate,
      input.maxGrantCents,
      input.applicationDeadline,
      input.status,
      input.createdAt ?? nowIso(),
    );
  return Number(info.lastInsertRowid);
}

export function updateProgram(db: Database.Database, id: number, input: ProgramInput): void {
  getProgramRow(db, id);
  db.prepare(
    `UPDATE programs SET
       name = ?, funding_body = ?, category = ?, description = ?,
       funding_rate = ?, max_grant_cents = ?, application_deadline = ?, status = ?
     WHERE id = ?`,
  ).run(
    input.name,
    input.fundingBody,
    input.category,
    input.description,
    input.fundingRate,
    input.maxGrantCents,
    input.applicationDeadline,
    input.status,
    id,
  );
}

/**
 * A program with applications cannot be hard-deleted — its applications
 * are our record and would be orphaned. Close/archive it instead (set
 * status = 'closed'). Only a program nobody has applied to can be removed.
 */
export function deleteProgram(db: Database.Database, id: number): void {
  const program = getProgramRow(db, id);
  const count = applicationCount(db, id);
  if (count > 0) {
    throw new DomainError(
      409,
      `${program.name} has ${count} application${count === 1 ? '' : 's'} and cannot be deleted — close it instead (set status to closed)`,
    );
  }
  db.prepare('DELETE FROM programs WHERE id = ?').run(id);
}
