import type Database from 'better-sqlite3';
import {
  cancelInvoice,
  createDraft,
  finalizeInvoice,
  recordPayment,
  type LineInput,
} from './invoices.js';

/**
 * Example dataset: 5 customers and 12 invoices across both years and
 * every status — drafts, sent (some overdue), partially and fully paid,
 * and cancelled — plus payments including partial ones. Everything goes
 * THROUGH the domain functions (createDraft → finalizeInvoice →
 * recordPayment/cancelInvoice), so the seeded database satisfies the
 * same invariants as a live one: gapless numbers per year, no stored
 * totals, no stored payment status.
 *
 * Idempotent: the dataset is relational, so seeding is all-or-nothing —
 * if any customers exist the seed is skipped entirely.
 */
export function seed(db: Database.Database): void {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM customers').get() as { count: number };
  if (count > 0) {
    console.log(`[seed] database already contains ${count} customers, skipping`);
    return;
  }

  db.transaction(() => {
    // ── Customers ──────────────────────────────────────────────────────
    const insertCustomer = db.prepare(
      'INSERT INTO customers (name, email, vat_id, address, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    const customers: [string, string, string, string][] = [
      [
        'Auer & Söhne Maschinenbau GmbH',
        'buchhaltung@auer-soehne.example.at',
        'ATU10000001',
        'Industriestraße 14\n4020 Linz\nAustria',
      ],
      [
        'Bergwald Consulting e.U.',
        'office@bergwald.example.at',
        'ATU10000002',
        'Getreidegasse 31\n5020 Salzburg\nAustria',
      ],
      [
        'Cathedral Media Studio KG',
        'invoices@cathedral.example.at',
        'ATU10000003',
        'Stephansplatz 5/12\n1010 Wien\nAustria',
      ],
      [
        'Donaufracht Logistik GmbH',
        'rechnung@donaufracht.example.at',
        'ATU10000004',
        'Handelskai 92\n1200 Wien\nAustria',
      ],
      [
        'Ebner IT Services GmbH',
        'accounting@ebner-it.example.de',
        'DE310000005',
        'Sendlinger Straße 8\n80331 München\nGermany',
      ],
    ];
    for (const [name, email, vatId, address] of customers) {
      insertCustomer.run(name, email, vatId, address, '2025-01-10T09:00:00Z');
    }
    const cust = (name: string): number =>
      (db.prepare('SELECT id FROM customers WHERE name LIKE ?').get(`${name}%`) as { id: number }).id;
    const AUER = cust('Auer');
    const BERGWALD = cust('Bergwald');
    const CATHEDRAL = cust('Cathedral');
    const DONAU = cust('Donaufracht');
    const EBNER = cust('Ebner');

    // Shorthand: line item as [description, qty, unit net cents, VAT %].
    const L = (rows: [string, number, number, number][]): LineInput[] =>
      rows.map(([description, quantity, unitPriceCents, vatRate]) => ({
        description,
        quantity,
        unitPriceCents,
        vatRate,
      }));

    interface SeedInvoice {
      customer: number;
      terms: number;
      note?: string;
      lines: LineInput[];
      created: string;
      issue?: string; // finalize with this date; omit → stays a draft
      payments?: [string, number, string?][]; // [date, cents, note?]
      cancelled?: [string, string]; // [dateTime, reason]
    }

    const invoices: SeedInvoice[] = [
      // ── 2025 ── INV-2025-0001 … INV-2025-0004 (finalization order!)
      {
        customer: AUER,
        terms: 14,
        created: '2025-02-03T10:12:00Z',
        issue: '2025-02-04',
        lines: L([
          ['Retrofit control cabinet wiring — hall 2', 1, 1_840_00, 20],
          ['On-site commissioning (per hour)', 12, 95_00, 20],
          ['Travel flat rate Linz', 1, 120_00, 20],
        ]),
        payments: [['2025-02-16', 3_720_00, 'Bank transfer']],
      },
      {
        customer: BERGWALD,
        terms: 30,
        created: '2025-04-14T08:40:00Z',
        issue: '2025-04-15',
        lines: L([
          ['Process audit workshop (2 days)', 2, 1_200_00, 20],
          ['Documentation package', 1, 380_00, 20],
        ]),
        payments: [['2025-05-09', 3_336_00]],
      },
      {
        customer: CATHEDRAL,
        terms: 14,
        created: '2025-06-02T13:25:00Z',
        issue: '2025-06-02',
        note: 'Duplicate of INV-2025-0002 scope — cancelled.',
        lines: L([['Brand film production — concept phase', 1, 2_500_00, 20]]),
        cancelled: ['2025-06-05T09:30:00Z', 'Issued twice for the same order by mistake'],
      },
      {
        customer: AUER,
        terms: 14,
        created: '2025-11-20T11:00:00Z',
        issue: '2025-11-21',
        lines: L([
          ['Maintenance contract Q4/2025', 1, 950_00, 20],
          ['Spare part: drive belt set', 3, 68_50, 20],
        ]),
        payments: [['2025-12-15', 600_00, 'Partial payment — remainder disputed']],
      },
      // ── 2026 ── INV-2026-0001 … INV-2026-0006
      {
        customer: DONAU,
        terms: 14,
        created: '2026-01-08T09:05:00Z',
        issue: '2026-01-09',
        lines: L([
          ['Fleet telematics setup (25 vehicles)', 25, 49_00, 20],
          ['Driver training session', 2, 340_00, 10],
        ]),
        payments: [['2026-01-20', 2_218_00]],
      },
      {
        customer: AUER,
        terms: 30,
        created: '2026-02-11T15:45:00Z',
        issue: '2026-02-12',
        lines: L([
          ['Conveyor line software update', 1, 2_100_00, 20],
          ['Operator handbook (printed)', 10, 24_90, 10],
        ]),
        payments: [
          ['2026-02-27', 1_500_00, 'First instalment'],
          ['2026-03-13', 1_293_90, 'Final instalment'],
        ],
      },
      {
        customer: BERGWALD,
        terms: 14,
        created: '2026-05-08T10:30:00Z',
        issue: '2026-05-10',
        note: 'Second reminder sent by post.',
        lines: L([
          ['Interim management April 2026 (per day)', 8, 780_00, 20],
          ['Expenses: rail travel', 1, 156_40, 10],
        ]),
        // No payments — overdue since 2026-05-24.
      },
      {
        customer: EBNER,
        terms: 30,
        created: '2026-06-18T14:20:00Z',
        issue: '2026-06-20',
        lines: L([
          ['Server rack hardware (reverse charge)', 2, 1_890_00, 0],
          ['Installation service', 6, 110_00, 0],
        ]),
        payments: [['2026-07-01', 2_000_00, 'Partial payment']],
      },
      {
        customer: CATHEDRAL,
        terms: 14,
        created: '2026-07-09T09:15:00Z',
        issue: '2026-07-10',
        lines: L([
          ['Product photography half-day', 1, 640_00, 20],
          ['Image licences (per image)', 24, 18_00, 20],
          ['Rush delivery surcharge', 1, 90_00, 20],
        ]),
      },
      {
        customer: DONAU,
        terms: 14,
        created: '2026-07-01T16:00:00Z',
        issue: '2026-07-02',
        lines: L([['GPS tracker hardware batch', 40, 62_00, 20]]),
        cancelled: ['2026-07-06T08:10:00Z', 'Order returned — wrong hardware revision delivered'],
      },
      // ── Drafts (no number yet) ──
      {
        customer: BERGWALD,
        terms: 14,
        created: '2026-07-14T11:30:00Z',
        note: 'Mixed-rate example: per-line rounding at work.',
        lines: L([
          ['USB-C adapter (promo price)', 3, 33, 20],
          ['Strategy review June 2026', 1, 1_450_00, 20],
          ['Book: "Boring Software That Works"', 2, 29_90, 10],
        ]),
      },
      {
        customer: EBNER,
        terms: 30,
        created: '2026-07-16T09:50:00Z',
        lines: L([
          ['Managed backup — Q3/2026', 3, 240_00, 0],
          ['Offsite storage per TB', 12, 9_50, 0],
        ]),
      },
    ];

    for (const spec of invoices) {
      const invoiceId = createDraft(db, {
        customerId: spec.customer,
        paymentTermsDays: spec.terms,
        note: spec.note ?? null,
        lines: spec.lines,
        createdAt: spec.created,
      });
      if (spec.issue) finalizeInvoice(db, invoiceId, spec.issue);
      for (const [date, amountCents, note] of spec.payments ?? []) {
        recordPayment(db, invoiceId, { date, amountCents, note: note ?? null, createdAt: `${date}T12:00:00Z` });
      }
      if (spec.cancelled) cancelInvoice(db, invoiceId, spec.cancelled[1], spec.cancelled[0]);
    }
  })();

  const stats = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM customers) AS customers,
              (SELECT COUNT(*) FROM invoices) AS invoices,
              (SELECT COUNT(*) FROM payments) AS payments`,
    )
    .get() as { customers: number; invoices: number; payments: number };
  console.log(
    `[seed] inserted ${stats.customers} customers, ${stats.invoices} invoices, ${stats.payments} payments`,
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
