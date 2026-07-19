import type Database from 'better-sqlite3';
import { addDays, weekStartOf } from '../shared/time.js';
import {
  approveTimesheet,
  createEmployee,
  createEntry,
  createProject,
  createTask,
  submitTimesheet,
  todayIso,
} from './tracking.js';

/**
 * Example dataset: 4 projects (mixed billable flags and hourly rates,
 * one non-billable internal project at rate 0), 5 employees, and three
 * weeks of daily entries — the current week (draft), last week
 * (submitted, awaiting approval) and the week before (approved, and
 * therefore LOCKED). Dates are RELATIVE to the day you seed, so the
 * daily grid, timesheets and summaries always have fresh content.
 *
 * Everything goes THROUGH the domain functions (createEntry,
 * submitTimesheet, approveTimesheet), so the seeded database satisfies
 * the same invariants a live one does — the 24h/day cap and the
 * approved-week lock are honoured (entries are written before the week
 * is approved).
 *
 * Idempotent: the dataset is relational, so seeding is all-or-nothing —
 * if any projects already exist the seed is skipped entirely.
 */
export function seed(db: Database.Database): void {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number };
  if (count > 0) {
    console.log(`[seed] database already contains ${count} projects, skipping`);
    return;
  }

  db.transaction(() => {
    // ── Projects (mixed billable / rate) ───────────────────────────────
    const acme = createProject(db, {
      name: 'Acme Website Redesign',
      client: 'Acme GmbH',
      billableDefault: true,
      rateCents: 12_000, // €120/h
      active: true,
    });
    const acmeDesign = createTask(db, acme, 'Design');
    const acmeFrontend = createTask(db, acme, 'Frontend');
    createTask(db, acme, 'Backend');

    const internal = createProject(db, {
      name: 'Internal Tooling',
      client: null,
      billableDefault: false, // non-billable by default
      rateCents: 0,
      active: true,
    });
    const internalMaint = createTask(db, internal, 'Maintenance');

    const donau = createProject(db, {
      name: 'Donaufracht Logistics Portal',
      client: 'Donaufracht AG',
      billableDefault: true,
      rateCents: 9_500, // €95/h
      active: true,
    });
    const donauImpl = createTask(db, donau, 'Implementation');

    const support = createProject(db, {
      name: 'Support Retainer',
      client: 'Various',
      billableDefault: true,
      rateCents: 8_000, // €80/h
      active: true,
    });

    // ── Employees ──────────────────────────────────────────────────────
    const anna = createEmployee(db, { name: 'Anna Berger', email: 'anna@0815software.example' });
    const bob = createEmployee(db, { name: 'Bob Novak', email: 'bob@0815software.example' });
    const clara = createEmployee(db, { name: 'Clara Weiss', email: 'clara@0815software.example' });
    const david = createEmployee(db, { name: 'David Hofer', email: 'david@0815software.example' });
    createEmployee(db, { name: 'Eva Klein', email: 'eva@0815software.example' });

    // ── Weeks (Monday of the current, previous and two-weeks-ago week) ──
    const thisWeek = weekStartOf(todayIso());
    const lastWeek = addDays(thisWeek, -7);
    const priorWeek = addDays(thisWeek, -14);

    // Shorthand for one entry on day `d` (0=Mon) of week `w`.
    const E = (
      employeeId: number,
      projectId: number,
      taskId: number | null,
      week: string,
      day: number,
      minutes: number,
      billable: boolean | null = null,
      note: string | null = null,
    ): void => {
      createEntry(db, {
        employeeId,
        projectId,
        taskId,
        entryDate: addDays(week, day),
        minutes,
        billable,
        note,
      });
    };

    // Prior week — will be APPROVED (locked) below.
    E(anna, acme, acmeDesign, priorWeek, 0, 240, null, 'Wireframes');
    E(anna, acme, acmeFrontend, priorWeek, 1, 300);
    E(anna, internal, internalMaint, priorWeek, 2, 90, null, 'CI cleanup');
    E(anna, acme, acmeFrontend, priorWeek, 3, 420);
    E(bob, donau, donauImpl, priorWeek, 0, 360);
    E(bob, donau, donauImpl, priorWeek, 1, 375, null, '90 min pairing + rest'); // odd minutes
    E(bob, support, null, priorWeek, 2, 120);

    // Last week — will be SUBMITTED (awaiting approval).
    E(anna, acme, acmeFrontend, lastWeek, 0, 300);
    E(anna, acme, acmeFrontend, lastWeek, 1, 315, null, 'Component library');
    E(anna, support, null, lastWeek, 2, 60, false, 'Non-billable triage');
    E(bob, donau, donauImpl, lastWeek, 0, 480);
    E(bob, donau, donauImpl, lastWeek, 2, 420);
    E(clara, acme, acmeDesign, lastWeek, 1, 240);
    E(clara, internal, internalMaint, lastWeek, 3, 150);

    // Current week — DRAFT, still being filled in.
    E(anna, acme, acmeFrontend, thisWeek, 0, 180);
    E(bob, donau, donauImpl, thisWeek, 0, 240);
    E(clara, acme, acmeDesign, thisWeek, 1, 90, null, '7-min sync + design'); // will co-exist with edits
    E(david, support, null, thisWeek, 0, 127, null, 'Odd support ticket'); // odd minutes for rounding demo

    // ── Approval workflow state ────────────────────────────────────────
    // Approve the prior week for Anna and Bob (submit → approve) → those
    // entries are now locked.
    submitTimesheet(db, anna, priorWeek, 'admin');
    approveTimesheet(db, anna, priorWeek, 'admin', 'Looks good');
    submitTimesheet(db, bob, priorWeek, 'admin');
    approveTimesheet(db, bob, priorWeek, 'admin', null);

    // Submit last week for Anna, Bob and Clara → awaiting approval.
    submitTimesheet(db, anna, lastWeek, 'admin');
    submitTimesheet(db, bob, lastWeek, 'admin');
    submitTimesheet(db, clara, lastWeek, 'admin');
  })();

  console.log('[seed] example data created (4 projects, 5 employees, 3 weeks of entries)');
}

// Allow `npm run seed` to run this file directly.
if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
  const { openDb } = await import('./db.js');
  const { configFromEnv } = await import('./config.js');
  const db = openDb(configFromEnv().databasePath);
  seed(db);
}
