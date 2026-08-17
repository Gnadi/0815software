import type Database from 'better-sqlite3';
import { createProject, DomainError, getProject } from './tracking.js';
import { validateTransfer, type DocumentTransfer } from '../shared/transfer.js';

export const MODULE_ID = 'mod-11-time-tracking';

/**
 * How many tasks an imported project starts with, at most.
 *
 * One task per line of the offer, so the hours someone books land against the
 * thing that was sold rather than against a single undifferentiated bucket. An
 * offer with fifty lines would produce fifty tasks nobody asked for, so the
 * list is capped and the rest stay implicit — a person adds what they need.
 */
const MAX_TASKS = 12;

export interface ImportContext {
  createdAt?: string;
}

export interface ImportResult {
  projectId: number;
  /** True when an earlier import of the same origin already produced it. */
  replayed: boolean;
}

/**
 * Turn a validated document transfer into a PROJECT to book time against.
 *
 * This is the third consumer of the same neutral shape MOD-13 exports and
 * MOD-04 bills, and it deliberately uses a SUBSET of it: a name, a client, the
 * lines as tasks. What it pointedly does not do is carry the money over.
 *
 * A project's `rate_cents` is what an HOUR costs. An offer's total is what the
 * JOB costs. They are different quantities, and the offer does not say how many
 * hours are in it — a fixed-price offer may not even have an answer. Deriving
 * one from the other would put a number in this module that looks authoritative
 * and is invented, and every timesheet total after it would inherit the
 * invention. So the rate starts at zero and a person sets it, which is what
 * they would have done for a project they created by hand.
 *
 * This module plans work from OFFERS only. A pipeline deal is refused: staffing
 * a project for something the customer has not agreed to buy is how a team ends
 * up having booked real hours against work that never happens.
 *
 * Idempotent on the origin reference: a second import of the same offer returns
 * the project the first one produced, so one job's hours can never end up split
 * across two projects.
 */
export function importTransfer(
  db: Database.Database,
  value: unknown,
  ctx: ImportContext = {},
): ImportResult {
  const problems = validateTransfer(value);
  if (problems.length > 0) {
    throw new DomainError(422, 'The transferred document cannot be planned as a project');
  }
  const transfer = value as DocumentTransfer;

  if (transfer.origin.kind !== 'offer') {
    throw new DomainError(
      422,
      `Only an accepted offer can be planned as a project — ${transfer.origin.reference} is a ${transfer.origin.kind}.` +
        ' Staffing work the customer has not agreed to buy is not something this module will do for you.',
    );
  }

  const reference = transfer.origin.reference.trim();
  const existing = db.prepare('SELECT id FROM projects WHERE origin_reference = ?').get(reference) as
    | { id: number }
    | undefined;
  if (existing) return { projectId: existing.id, replayed: true };

  return db.transaction((): ImportResult => {
    const projectId = createProject(db, {
      // The reference is in the name on purpose. Someone picking a project from
      // a dropdown three weeks later needs to know which job it is, and the
      // customer's name alone stops being enough at the second order from them.
      name: `${reference} · ${transfer.customer.name}`,
      client: transfer.customer.name,
      billableDefault: true,
      // Deliberately not derived from the offer — see the note above.
      rateCents: 0,
      active: true,
      createdAt: ctx.createdAt,
    });
    db.prepare('UPDATE projects SET origin_reference = ? WHERE id = ?').run(reference, projectId);

    const insertTask = db.prepare('INSERT INTO tasks (project_id, name, active) VALUES (?, ?, 1)');
    const seen = new Set<string>();
    for (const line of transfer.lines.slice(0, MAX_TASKS)) {
      // Two lines can legitimately share a description — "Travel", twice, on
      // different dates. As tasks they would be indistinguishable in a
      // dropdown, so the second one is dropped rather than duplicated.
      const name = line.description.slice(0, 120);
      if (seen.has(name)) continue;
      seen.add(name);
      insertTask.run(projectId, name);
    }

    // Re-read through the module's own accessor so a broken write fails loudly
    // here rather than when someone tries to book time against it.
    getProject(db, projectId);
    return { projectId, replayed: false };
  })();
}
