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
import { addEntitlement, createRequest, decideRequest } from './leave.js';
import { addSchedule } from './schedules.js';
import { createMilestone, moveTask, planTask } from './planning.js';
import { addFlexEntry, flexAccount } from './flextime.js';
import { createMileage, createReceipt, createTrip, decideClaim, putReceiptFile, setBankAccount, submitClaim } from './expenses.js';

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

    // ── Planning ───────────────────────────────────────────────────────
    // The Acme relaunch as a planned project: a budget, a go-live milestone,
    // tasks on the board with people, dates and estimates — one of them late.
    const boss = { actor: 'admin', access: 'manage' as const };
    db.prepare('UPDATE projects SET budget_minutes = ? WHERE id = ?').run(80 * 60, acme);
    const goLive = createMilestone(db, acme, 'Go-live', addDays(thisWeek, 25)).id;
    const acmeBackend = (db.prepare("SELECT id FROM tasks WHERE project_id = ? AND name = 'Backend'").get(acme) as { id: number }).id;
    const plan = (taskId: number, assigneeId: number, dueIn: number, estimateHours: number, milestoneId: number | null, description: string | null = null) =>
      planTask(db, taskId, { assigneeId, dueDate: addDays(thisWeek, dueIn), estimateMinutes: estimateHours * 60, milestoneId, description });
    plan(acmeDesign, clara, -3, 8, goLive, 'Wireframes and the visual design for every page');
    plan(acmeFrontend, anna, 11, 24, goLive);
    plan(acmeBackend, bob, 18, 16, goLive);
    moveTask(db, acmeDesign, 'in_progress', null, boss);
    moveTask(db, acmeFrontend, 'in_progress', null, boss);
    plan(donauImpl, bob, 30, 60, null);
    moveTask(db, donauImpl, 'in_progress', null, boss);
    plan(internalMaint, david, -1, 4, null);

    // ── Working time ───────────────────────────────────────────────────
    // Flexitime accounts from the first seeded week: full-time, part-time on
    // three days, and Eva without one. The seeded entries are a sample, not
    // full weeks, so each account brings the balance it had in the "old
    // system" — chosen so the board shows one person in plus, one with
    // overtime above the 40 h cap, and one below the floor (David, none).
    const admin = { actor: 'admin', access: 'manage' as const };
    const schedule = (employeeId: number, weeklyMinutes: number, workDays: string) =>
      addSchedule(db, employeeId, { validFrom: priorWeek, weeklyMinutes, workDays, note: null }, 'admin');
    schedule(anna, 2310, '12345'); // 38.5 h
    schedule(bob, 2400, '12345');
    schedule(clara, 1200, '123'); // 20 h, Monday to Wednesday
    schedule(david, 2400, '12345');
    const today = todayIso();
    for (const [person, wanted] of [
      [anna, 390], // +6:30 today
      [bob, 2760], // +46:00 — six hours of overtime
      [clara, 120],
    ] as const) {
      const opening = wanted - flexAccount(db, person, today, admin).balance;
      if (opening !== 0) addFlexEntry(db, person, { kind: 'opening', minutes: opening, effectiveDate: priorWeek, note: 'Carried over from the old system' }, 'admin', admin);
    }

    // ── Absences ───────────────────────────────────────────────────────
    // Allowances for this year and next (a request near New Year may land
    // in either), one approved and one pending vacation, one sick day.
    const year = Number(thisWeek.slice(0, 4));
    for (const person of [anna, bob, clara, david]) {
      for (const y of [year, year + 1]) addEntitlement(db, person, { year: y, kind: 'allowance', days: 25, note: null }, 'admin');
    }
    // Monday to Friday of a week ahead, kept inside one year as the rules require.
    const weekOff = (weeks: number): { startDate: string; endDate: string } => {
      const startDate = addDays(thisWeek, 7 * weeks);
      const friday = addDays(startDate, 4);
      return { startDate, endDate: friday.slice(0, 4) === startDate.slice(0, 4) ? friday : `${startDate.slice(0, 4)}-12-31` };
    };
    const annaOff = createRequest(db, { employeeId: anna, type: 'vacation', ...weekOff(2), halfDay: false, note: 'Family visit' }, admin);
    decideRequest(db, annaOff.id, 'approved', null, admin);
    createRequest(db, { employeeId: bob, type: 'vacation', ...weekOff(3), halfDay: false, note: null }, admin);
    createRequest(db, { employeeId: david, type: 'sick', startDate: addDays(lastWeek, 4), endDate: addDays(lastWeek, 4), halfDay: false, note: null }, admin);

    // ── Expenses ───────────────────────────────────────────────────────
    // Anna's two days in Linz last week, waiting for a decision: the trip
    // (one paid lunch, one night at the flat rate), the drive with a
    // colleague, and the car park's till receipt. Bob's day at the fair in
    // Munich, already approved. A 1×1 picture stands in for the photos.
    const tue = addDays(lastWeek, 1);
    const wed = addDays(lastWeek, 2);
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    setBankAccount(db, anna, { holder: 'Anna Berger', iban: 'AT61 1904 3002 3457 3201' }, admin);
    const linz = createTrip(db, { employee_id: anna, purpose: 'Workshop at Donaufracht', destination: 'Linz', start_local: `${tue}T07:00`, end_local: `${wed}T19:00`, meals: [0, 1], nights_flat: 1, project_id: donau }, admin).trip;
    const drive = createMileage(db, { employee_id: anna, trip_id: linz.id, travel_date: tue, from_place: 'Wien', to_place: 'Linz', purpose: 'Workshop at Donaufracht', km_tenths: 1850, vehicle: 'car', passengers: 1 }, admin).mileage;
    const parking = createReceipt(db, {
      employee_id: anna,
      trip_id: linz.id,
      merchant: 'Parkgarage Hauptplatz',
      category: 'parking',
      rksv_code: `_R1-AT1_PARK-LNZ-2_40712_${tue}T08:41:17_14,00_0,00_0,00_0,00_0,00_lHZnU+ICvLM=_5e3a9c1d_cg8hNU5ihto=_k2lVUXZ6/9WC/YIM3gl1n3z2YljGcJKuvufYvCUiiYdpCo8LWGdNdPMIhQP4D4bt+oGDdRwwrFjYzPMfxYTK8g==`,
    }, admin).receipt;
    putReceiptFile(db, parking.id, pixel, admin);
    submitClaim(db, { employee_id: anna, trip_ids: [linz.id], mileage_ids: [drive.id], receipt_ids: [parking.id], title: 'Linz workshop' }, admin);

    const munich = createTrip(db, {
      employee_id: bob,
      purpose: 'Trade fair',
      destination: 'München',
      country: 'Deutschland',
      start_local: `${lastWeek}T05:30`,
      end_local: `${lastWeek}T21:30`,
      border_out: `${lastWeek}T07:15`,
      border_in: `${lastWeek}T19:45`,
    }, admin).trip;
    const ticket = createReceipt(db, { employee_id: bob, trip_id: munich.id, merchant: 'Messe München', category: 'other', description: 'Visitor ticket', receipt_date: lastWeek, gross_cents: 4900, vat_lines: [{ rate_bp: 1900, gross_cents: 4900 }] }, admin).receipt;
    putReceiptFile(db, ticket.id, pixel, admin);
    const bobs = submitClaim(db, { employee_id: bob, trip_ids: [munich.id], receipt_ids: [ticket.id], title: 'Munich trade fair' }, admin).claim;
    decideClaim(db, bobs.claim.id, 'approved', null, admin);
  })();

  console.log('[seed] example data created (4 projects, 5 employees, 3 weeks of entries, absences, expenses)');
}

// Allow `npm run seed` to run this file directly.
if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
  const { openDb } = await import('./db.js');
  const { configFromEnv } = await import('./config.js');
  const db = openDb(configFromEnv().databasePath);
  seed(db);
}
