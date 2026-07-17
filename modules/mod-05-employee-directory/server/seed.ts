import type Database from 'better-sqlite3';
import {
  addDays,
  createDepartment,
  createEmployee,
  offboardEmployee,
  setOnboardingFlags,
  todayIso,
} from './directory.js';

/**
 * Example dataset: 5 departments (Platform nested under Engineering)
 * and 21 employees in a three-level hierarchy with TWO roots (the two
 * managing directors), a couple of upcoming starters, one recent
 * starter mid-checklist, and one offboarded former employee who keeps
 * his record but is absent from the org chart.
 *
 * Everything goes THROUGH the domain functions (createDepartment,
 * createEmployee, offboardEmployee), so the seeded database satisfies
 * the same invariants as a live one — in particular the manager forest
 * is checked on every insert. Start dates for the onboarding examples
 * are RELATIVE to the day you seed, so the onboarding view always has
 * content.
 *
 * Idempotent: the dataset is relational, so seeding is all-or-nothing —
 * if any departments exist the seed is skipped entirely.
 */
export function seed(db: Database.Database): void {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM departments').get() as { count: number };
  if (count > 0) {
    console.log(`[seed] database already contains ${count} departments, skipping`);
    return;
  }

  const today = todayIso();

  db.transaction(() => {
    // ── Departments (Platform is nested under Engineering) ────────────
    const ENG = createDepartment(db, { name: 'Engineering', code: 'ENG', parentId: null });
    const PLT = createDepartment(db, { name: 'Platform', code: 'ENG-PLT', parentId: ENG });
    const OPS = createDepartment(db, { name: 'Operations', code: 'OPS', parentId: null });
    const SLS = createDepartment(db, { name: 'Sales', code: 'SLS', parentId: null });
    const GNA = createDepartment(db, { name: 'General & Administration', code: 'GNA', parentId: null });

    // Shorthand: [name, email-local, title, dept, manager, phone?, location?, start]
    const E = (
      name: string,
      local: string,
      jobTitle: string,
      departmentId: number,
      managerId: number | null,
      phone: string | null,
      location: string | null,
      startDate: string,
    ): number =>
      createEmployee(db, {
        name,
        email: `${local}@0815software.example`,
        jobTitle,
        departmentId,
        managerId,
        phone,
        location,
        startDate,
      });

    // ── Root 1: commercial side ────────────────────────────────────────
    const johanna = E('Johanna Berger', 'johanna.berger', 'Managing Director', GNA, null, '+43 1 890 08 15', 'Vienna HQ', '2019-03-01');
    const klaus = E('Klaus Steiner', 'klaus.steiner', 'Head of Operations', OPS, johanna, '+43 1 890 08 16', 'Vienna HQ', '2019-09-16');
    E('Petra Maier', 'petra.maier', 'Logistics Coordinator', OPS, klaus, '+43 732 44 08 15', 'Linz', '2021-04-06');
    E('Stefan Wagner', 'stefan.wagner', 'Facilities Manager', OPS, klaus, null, 'Vienna HQ', '2020-11-02');
    const sabine = E('Sabine Hofer', 'sabine.hofer', 'Head of Sales', SLS, johanna, '+43 1 890 08 17', 'Vienna HQ', '2020-02-03');
    E('Thomas Egger', 'thomas.egger', 'Account Executive', SLS, sabine, '+43 316 90 08 15', 'Graz', '2022-01-10');
    E('Julia Pichler', 'julia.pichler', 'Account Executive', SLS, sabine, null, 'Vienna HQ', '2023-05-08');
    E('David Moser', 'david.moser', 'Sales Development Rep', SLS, sabine, null, 'Graz', '2024-09-02');
    const anna = E('Anna Fuchs', 'anna.fuchs', 'Finance & HR Manager', GNA, johanna, '+43 1 890 08 18', 'Vienna HQ', '2021-01-11');
    E('Lukas Schmid', 'lukas.schmid', 'Office Administrator', GNA, anna, null, 'Vienna HQ', '2023-10-02');

    // ── Root 2: technical side ─────────────────────────────────────────
    const markus = E('Markus Winkler', 'markus.winkler', 'Technical Director', ENG, null, '+43 1 890 08 20', 'Vienna HQ', '2019-03-01');
    const elena = E('Elena Novak', 'elena.novak', 'Platform Lead', PLT, markus, '+43 1 890 08 21', 'Vienna HQ', '2020-06-15');
    E('Georg Aigner', 'georg.aigner', 'Backend Engineer', PLT, elena, null, 'Vienna HQ', '2021-08-16');
    E('Miriam Steger', 'miriam.steger', 'Backend Engineer', PLT, elena, null, 'Linz', '2022-03-01');
    E('Patrick Wolf', 'patrick.wolf', 'DevOps Engineer', PLT, elena, null, 'Remote', '2023-02-06');
    E('Christoph Bauer', 'christoph.bauer', 'Senior Software Engineer', ENG, markus, null, 'Vienna HQ', '2020-09-01');
    E('Verena Huber', 'verena.huber', 'Software Engineer', ENG, markus, null, 'Vienna HQ', '2022-11-14');

    // ── Onboarding examples (dates relative to the seeding day) ────────
    // Just started 6 days ago — checklist half done.
    const felix = E('Felix Gruber', 'felix.gruber', 'QA Engineer', ENG, markus, null, 'Linz', addDays(today, -6));
    setOnboardingFlags(db, felix, { account_created: true, hardware_issued: true });
    // Starting soon.
    E('Nina Brandstätter', 'nina.brandstaetter', 'Operations Analyst', OPS, klaus, null, 'Vienna HQ', addDays(today, 12));
    E('Sara Leitner', 'sara.leitner', 'Frontend Engineer', PLT, elena, null, 'Remote', addDays(today, 25));

    // ── One offboarded former employee (keeps history, off the chart) ──
    const martin = E('Martin Lang', 'martin.lang', 'Software Engineer', ENG, markus, null, 'Vienna HQ', '2021-05-03');
    offboardEmployee(db, martin, '2025-11-28T17:00:00Z');
  })();

  const stats = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM departments) AS departments,
              (SELECT COUNT(*) FROM employees) AS employees,
              (SELECT COUNT(*) FROM employees WHERE status = 'active') AS active`,
    )
    .get() as { departments: number; employees: number; active: number };
  console.log(
    `[seed] inserted ${stats.departments} departments, ${stats.employees} employees (${stats.active} active)`,
  );
}

// CLI entry: npm run seed
const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { openDb } = await import('./db.js');
  const { configFromEnv } = await import('./config.js');
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  seed(db);
  db.close();
  console.log(`[seed] done — database at ${config.databasePath}`);
}
