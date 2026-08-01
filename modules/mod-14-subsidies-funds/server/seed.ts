import type Database from 'better-sqlite3';
import type { ApplicationStatus, Category, ProgramStatus } from '../shared/types.js';
import {
  addObligation,
  createApplication,
  recordTranche,
  toggleObligation,
  transitionApplication,
} from './applications.js';
import { nowIso } from './core.js';
import { createProgram } from './programs.js';

/**
 * Example dataset from the APPLICANT's point of view: 6 funding programs
 * (mixed categories, some with deadlines, some rolling, one closed) and 12
 * applications across every status — including approved-and-partially-
 * disbursed, approved-and-fully-disbursed, rejected, withdrawn and drafts —
 * with tranche histories and post-award reporting obligations (some
 * overdue, some at-risk, some upcoming).
 *
 * Everything goes THROUGH the domain functions (createApplication →
 * transitionApplication / recordTranche / addObligation / toggleObligation),
 * so the seeded database satisfies the same invariants as a live one:
 * append-only status timeline, legal transitions only, no over-disbursement,
 * no stored derived balance.
 *
 * RELATIVE TIMESTAMPS. Program deadlines and obligation due dates are
 * expressed as offsets from the seed day, so the derived overdue/at-risk/
 * upcoming states are stable whenever you seed.
 *
 * That guarantee holds only while the reader's "now" IS the seed day, which
 * is why `base` is a parameter. A caller that pins the clock — a test, a demo
 * at a fixed date — must seed at the same instant, or the dataset drifts out
 * from under it as the real calendar advances and deliberately-overdue rows
 * stop being overdue. Defaults to now, so the app and the CLI are unchanged.
 *
 * Idempotent: the dataset is relational, so seeding is all-or-nothing — if
 * any program already exists the seed is skipped entirely.
 */
export function seed(db: Database.Database, base: number = Date.now()): void {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM programs').get() as { count: number };
  if (count > 0) {
    console.log(`[seed] database already contains ${count} programs, skipping`);
    return;
  }

  const DAY = 86_400_000;
  /** ISO timestamp for `m` minutes before the seed moment. */
  const ago = (m: number): string => nowIso(base - m * 60_000);
  /** YYYY-MM-DD, `d` days from the seed day (negative = in the past). */
  const day = (d: number): string => new Date(base + d * DAY).toISOString().slice(0, 10);

  db.transaction(() => {
    // ── Funding programs ───────────────────────────────────────────────
    const prog = (
      name: string,
      fundingBody: string,
      category: Category,
      rate: number,
      maxGrant: number,
      deadline: string | null,
      status: ProgramStatus,
      description: string,
    ): number =>
      createProgram(db, {
        name,
        fundingBody,
        category,
        description,
        fundingRate: rate,
        maxGrantCents: maxGrant,
        applicationDeadline: deadline,
        status,
        createdAt: ago(60 * 24 * 90),
      });

    const digitalJetzt = prog(
      'Digital Jetzt',
      'BMWK',
      'digitalisation',
      40,
      50_000_00,
      day(60), // upcoming (beyond the 30-day at-risk window)
      'open',
      'Investitionszuschuss für Digitalisierung in KMU: Hard-/Software und Qualifizierung.',
    );
    const kmuInnovativ = prog(
      'KMU-innovativ: Forschung & Entwicklung',
      'BMBF',
      'rd',
      50,
      200_000_00,
      null, // rolling
      'open',
      'Förderung risikoreicher industrieller Forschung und experimenteller Entwicklung.',
    );
    const umweltKlima = prog(
      'Umwelt- und Klimaschutz',
      'KfW',
      'environment',
      30,
      100_000_00,
      day(20), // at risk (within 30 days)
      'open',
      'Zuschuss für betriebliche Investitionen in Energieeffizienz und Klimaschutz.',
    );
    const eingliederung = prog(
      'Eingliederungszuschuss',
      'Agentur für Arbeit',
      'hiring',
      50,
      15_000_00,
      null, // rolling
      'open',
      'Lohnkostenzuschuss bei Einstellung von Arbeitnehmern mit Vermittlungshemmnissen.',
    );
    const goInternational = prog(
      'go-international',
      'AWS',
      'export',
      60,
      8_000_00,
      day(-10), // overdue application deadline (program still open)
      'open',
      'Unterstützung beim Markteintritt in neue Exportmärkte.',
    );
    prog(
      'EXIST-Gründerstipendium',
      'BMWK',
      'startup',
      100,
      30_000_00,
      day(5),
      'closed', // closed program — excluded from the deadlines dashboard
      'Stipendium für innovative technologie- oder wissensbasierte Gründungen.',
    );

    // ── Timeline driver ────────────────────────────────────────────────
    interface Spec {
      program: number;
      title: string;
      eligible: number;
      requested: number;
      reference: string | null;
      notes: string | null;
      created: number; // minutes ago
      steps: { to: ApplicationStatus; at: number; approved?: number }[];
      tranches?: { on: string; amount: number; at: number; reference?: string; note?: string }[];
      obligations?: { title: string; due: string; done?: boolean }[];
    }

    const run = (spec: Spec): void => {
      const appId = createApplication(db, {
        programId: spec.program,
        title: spec.title,
        eligibleCostsCents: spec.eligible,
        requestedAmountCents: spec.requested,
        submissionDate: null,
        reference: spec.reference,
        notes: spec.notes,
        createdAt: ago(spec.created),
      });
      for (const step of spec.steps) {
        transitionApplication(db, appId, {
          to: step.to,
          actor: 'admin',
          note: null,
          approvedAmountCents: step.approved ?? null,
          at: ago(step.at),
        });
      }
      for (const t of spec.tranches ?? []) {
        recordTranche(db, appId, {
          disbursedOn: t.on,
          amountCents: t.amount,
          reference: t.reference ?? null,
          note: t.note ?? null,
          at: ago(t.at),
        });
      }
      for (const o of spec.obligations ?? []) {
        const obId = addObligation(db, appId, { title: o.title, dueDate: o.due, at: ago(spec.created - 1) });
        if (o.done) toggleObligation(db, obId, ago(1));
      }
    };

    // A1 — approved, partially disbursed; interim report OVERDUE, final upcoming.
    run({
      program: digitalJetzt,
      title: 'ERP-Modernisierung und Warehouse-Automatisierung',
      eligible: 100_000_00,
      requested: 40_000_00,
      reference: 'DJ-2026-1187',
      notes: 'Ablösung des Alt-ERP, Einführung Lagerverwaltung mit Scannern.',
      created: 60 * 24 * 40,
      steps: [
        { to: 'submitted', at: 60 * 24 * 39 },
        { to: 'under_review', at: 60 * 24 * 30 },
        { to: 'approved', at: 60 * 24 * 20, approved: 38_000_00 },
      ],
      tranches: [
        { on: day(-18), amount: 15_000_00, at: 60 * 24 * 18, reference: 'ZW-1' },
        { on: day(-6), amount: 5_000_00, at: 60 * 24 * 6, reference: 'ZW-2' },
      ],
      obligations: [
        { title: 'Zwischenbericht (Mittelverwendung Q1)', due: day(-5) },
        { title: 'Verwendungsnachweis (Abschluss)', due: day(120) },
      ],
    });

    // A2 — approved, FULLY disbursed; final report at-risk, proof of use done.
    run({
      program: kmuInnovativ,
      title: 'KI-gestützte Qualitätskontrolle in der Fertigung',
      eligible: 40_000_00,
      requested: 20_000_00,
      reference: 'KMU-INNO-8842',
      notes: 'Machbarkeitsstudie Bildverarbeitung an der Produktionslinie.',
      created: 60 * 24 * 120,
      steps: [
        { to: 'submitted', at: 60 * 24 * 118 },
        { to: 'under_review', at: 60 * 24 * 100 },
        { to: 'approved', at: 60 * 24 * 80, approved: 20_000_00 },
      ],
      tranches: [{ on: day(-70), amount: 20_000_00, at: 60 * 24 * 70, reference: 'AUSZ-VOLL' }],
      obligations: [
        { title: 'Sachbericht (Endabrechnung)', due: day(15) },
        { title: 'Zahlungsnachweise eingereicht', due: day(-40), done: true },
      ],
    });

    // A3 — approved, partially disbursed; interim report OVERDUE.
    run({
      program: umweltKlima,
      title: 'PV-Anlage und Wärmepumpe für Betriebsgebäude',
      eligible: 200_000_00,
      requested: 60_000_00,
      reference: 'KFW-UK-4471',
      notes: 'Dach-PV 180 kWp plus Prozesswärme-Umstellung.',
      created: 60 * 24 * 25,
      steps: [
        { to: 'submitted', at: 60 * 24 * 24 },
        { to: 'under_review', at: 60 * 24 * 18 },
        { to: 'approved', at: 60 * 24 * 12, approved: 50_000_00 },
      ],
      tranches: [
        { on: day(-10), amount: 10_000_00, at: 60 * 24 * 10 },
        { on: day(-3), amount: 15_000_00, at: 60 * 24 * 3 },
      ],
      obligations: [{ title: 'Zwischennachweis Baufortschritt', due: day(-2) }],
    });

    // A4 — rejected.
    run({
      program: eingliederung,
      title: 'Lohnkostenzuschuss Neueinstellung Servicetechnik',
      eligible: 10_000_00,
      requested: 5_000_00,
      reference: 'AA-EGZ-2231',
      notes: 'Antrag für zwei Neueinstellungen.',
      created: 60 * 24 * 50,
      steps: [
        { to: 'submitted', at: 60 * 24 * 49 },
        { to: 'under_review', at: 60 * 24 * 45 },
        { to: 'rejected', at: 60 * 24 * 35 },
      ],
    });

    // A5 — withdrawn (we pulled it before a decision).
    run({
      program: goInternational,
      title: 'Markteintritt Skandinavien',
      eligible: 10_000_00,
      requested: 6_000_00,
      reference: 'AWS-GI-0091',
      notes: 'Zurückgezogen — Strategiewechsel.',
      created: 60 * 24 * 30,
      steps: [
        { to: 'submitted', at: 60 * 24 * 28 },
        { to: 'withdrawn', at: 60 * 24 * 22 },
      ],
    });

    // A6 — draft.
    run({
      program: digitalJetzt,
      title: 'E-Commerce-Plattform und PIM-System',
      eligible: 50_000_00,
      requested: 18_000_00,
      reference: null,
      notes: 'In Vorbereitung — Angebote werden eingeholt.',
      created: 60 * 24 * 3,
      steps: [],
    });

    // A7 — submitted (awaiting acknowledgement).
    run({
      program: kmuInnovativ,
      title: 'Predictive-Maintenance-Sensorik',
      eligible: 80_000_00,
      requested: 35_000_00,
      reference: 'KMU-INNO-9310',
      notes: 'Eingereicht, Eingangsbestätigung ausstehend.',
      created: 60 * 24 * 6,
      steps: [{ to: 'submitted', at: 60 * 24 * 5 }],
    });

    // A8 — under review.
    run({
      program: umweltKlima,
      title: 'Abwärmenutzung Drucklufterzeugung',
      eligible: 30_000_00,
      requested: 9_000_00,
      reference: 'KFW-UK-4620',
      notes: 'In Prüfung durch den Fördergeber.',
      created: 60 * 24 * 14,
      steps: [
        { to: 'submitted', at: 60 * 24 * 13 },
        { to: 'under_review', at: 60 * 24 * 8 },
      ],
    });

    // A9 — approved, FULLY disbursed; single upcoming obligation.
    run({
      program: eingliederung,
      title: 'Eingliederungszuschuss Lagerlogistik',
      eligible: 8_000_00,
      requested: 4_000_00,
      reference: 'AA-EGZ-2588',
      notes: 'Bewilligt, vollständig ausgezahlt.',
      created: 60 * 24 * 90,
      steps: [
        { to: 'submitted', at: 60 * 24 * 88 },
        { to: 'under_review', at: 60 * 24 * 80 },
        { to: 'approved', at: 60 * 24 * 70, approved: 4_000_00 },
      ],
      tranches: [{ on: day(-60), amount: 4_000_00, at: 60 * 24 * 60 }],
      obligations: [{ title: 'Beschäftigungsnachweis (6 Monate)', due: day(90) }],
    });

    // A10 — approved, NOTHING disbursed yet; interim at-risk, final upcoming.
    run({
      program: kmuInnovativ,
      title: 'Digitaler Zwilling der Montagelinie',
      eligible: 60_000_00,
      requested: 30_000_00,
      reference: 'KMU-INNO-9001',
      notes: 'Bewilligt, Mittelabruf steht noch aus.',
      created: 60 * 24 * 20,
      steps: [
        { to: 'submitted', at: 60 * 24 * 19 },
        { to: 'under_review', at: 60 * 24 * 12 },
        { to: 'approved', at: 60 * 24 * 5, approved: 25_000_00 },
      ],
      obligations: [
        { title: 'Zwischenbericht (Meilenstein 1)', due: day(10) },
        { title: 'Verwendungsnachweis (Abschluss)', due: day(200) },
      ],
    });

    // A11 — draft.
    run({
      program: digitalJetzt,
      title: 'Dokumentenmanagement und Workflow-Automation',
      eligible: 20_000_00,
      requested: 8_000_00,
      reference: null,
      notes: 'Frühe Planungsphase.',
      created: 60 * 24 * 1,
      steps: [],
    });

    // A12 — approved, partially disbursed; obligation OVERDUE.
    run({
      program: goInternational,
      title: 'Messeauftritt und Vertriebsaufbau DACH-Export',
      eligible: 5_000_00,
      requested: 3_000_00,
      reference: 'AWS-GI-0142',
      notes: 'Bewilligt, erste Tranche geflossen.',
      created: 60 * 24 * 45,
      steps: [
        { to: 'submitted', at: 60 * 24 * 44 },
        { to: 'under_review', at: 60 * 24 * 38 },
        { to: 'approved', at: 60 * 24 * 30, approved: 3_000_00 },
      ],
      tranches: [{ on: day(-25), amount: 1_500_00, at: 60 * 24 * 25 }],
      obligations: [{ title: 'Verwendungsnachweis Messebeteiligung', due: day(-2) }],
    });
  })();

  const stats = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM programs) AS programs,
              (SELECT COUNT(*) FROM applications) AS applications,
              (SELECT COUNT(*) FROM disbursements) AS tranches,
              (SELECT COUNT(*) FROM obligations) AS obligations,
              (SELECT COUNT(*) FROM application_events) AS events`,
    )
    .get() as { programs: number; applications: number; tranches: number; obligations: number; events: number };
  console.log(
    `[seed] inserted ${stats.programs} programs, ${stats.applications} applications, ${stats.tranches} tranches, ${stats.obligations} obligations, ${stats.events} timeline events`,
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
