import type Database from 'better-sqlite3';
import {
  createDraft,
  decideOffer,
  finalizeOffer,
  reviseOffer,
  updateDraft,
  withdrawOffer,
  type LineInput,
} from './offers.js';

/**
 * Example dataset: 5 customers and 12 offers spread across two years and
 * every status — drafts, sent (open), expired, accepted, rejected,
 * withdrawn, and a superseded → revised chain — with realistic line
 * items, per-line discounts and mixed VAT rates. Everything goes THROUGH
 * the domain functions (createDraft → finalizeOffer → decideOffer /
 * withdrawOffer / reviseOffer), so the seeded database satisfies the same
 * invariants as a live one: gapless numbers per year, no stored totals,
 * append-only event history.
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
      'INSERT INTO customers (name, contact_person, email, vat_id, address, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const customers: [string, string, string, string, string][] = [
      [
        'Auer & Söhne Maschinenbau GmbH',
        'Ing. Martina Auer',
        'einkauf@auer-soehne.example.at',
        'ATU10000001',
        'Industriestraße 14\n4020 Linz\nAustria',
      ],
      [
        'Bergwald Consulting e.U.',
        'Dr. Felix Bergwald',
        'office@bergwald.example.at',
        'ATU10000002',
        'Getreidegasse 31\n5020 Salzburg\nAustria',
      ],
      [
        'Cathedral Media Studio KG',
        'Lena Hofmann',
        'projects@cathedral.example.at',
        'ATU10000003',
        'Stephansplatz 5/12\n1010 Wien\nAustria',
      ],
      [
        'Donaufracht Logistik GmbH',
        'Peter Novak',
        'beschaffung@donaufracht.example.at',
        'ATU10000004',
        'Handelskai 92\n1200 Wien\nAustria',
      ],
      [
        'Ebner IT Services GmbH',
        'Sabine Ebner',
        'purchasing@ebner-it.example.de',
        'DE310000005',
        'Sendlinger Straße 8\n80331 München\nGermany',
      ],
    ];
    for (const [name, contact, email, vatId, address] of customers) {
      insertCustomer.run(name, contact, email, vatId, address, '2025-01-10T09:00:00Z');
    }
    const cust = (name: string): number =>
      (db.prepare('SELECT id FROM customers WHERE name LIKE ?').get(`${name}%`) as { id: number }).id;
    const AUER = cust('Auer');
    const BERGWALD = cust('Bergwald');
    const CATHEDRAL = cust('Cathedral');
    const DONAU = cust('Donaufracht');
    const EBNER = cust('Ebner');

    // Shorthand: line as [description, qty, unit net cents, VAT %, discount %?].
    const L = (rows: [string, number, number, number, number?][]): LineInput[] =>
      rows.map(([description, quantity, unitPriceCents, vatRate, discountPercent]) => ({
        description,
        quantity,
        unitPriceCents,
        vatRate,
        discountPercent: discountPercent ?? 0,
      }));

    interface Spec {
      customer: number;
      title: string;
      created: string;
      validUntil: string;
      intro?: string;
      terms?: string;
      lines: LineInput[];
    }

    const draft = (spec: Spec): number =>
      createDraft(db, {
        customerId: spec.customer,
        title: spec.title,
        validUntil: spec.validUntil,
        intro: spec.intro ?? null,
        terms: spec.terms ?? null,
        lines: spec.lines,
        createdAt: spec.created,
      });

    const DEFAULT_TERMS =
      'Prices are net in EUR and exclude VAT where shown. Delivery within 4 weeks of acceptance. Payment 14 days net.';

    // ── 2025 · OFF-2025-0001 … 0004 (finalized in this order) ───────────
    // 0001 — accepted
    let one = draft({
      customer: AUER,
      title: 'Retrofit of control cabinet — hall 2',
      created: '2025-02-28T10:00:00Z',
      validUntil: '2025-04-15',
      intro: 'Thank you for the site visit. We are pleased to offer the following retrofit works.',
      terms: DEFAULT_TERMS,
      lines: L([
        ['Control cabinet wiring, hall 2', 1, 1_840_00, 20],
        ['On-site commissioning (per hour)', 12, 95_00, 20, 10],
        ['Travel flat rate Linz', 1, 120_00, 20],
      ]),
    });
    finalizeOffer(db, one, { sentDate: '2025-03-03' });
    decideOffer(db, one, 'accepted', {
      actor: 'customer',
      note: 'Approved by procurement — please schedule.',
      at: '2025-03-19T14:20:00Z',
      today: '2025-03-19',
    });

    // 0002 — rejected
    let two = draft({
      customer: BERGWALD,
      title: 'Process audit & documentation package',
      created: '2025-05-05T08:40:00Z',
      validUntil: '2025-06-05',
      terms: DEFAULT_TERMS,
      lines: L([
        ['Process audit workshop (2 days)', 2, 1_200_00, 20],
        ['Documentation package', 1, 380_00, 20, 15],
      ]),
    });
    finalizeOffer(db, two, { sentDate: '2025-05-06' });
    decideOffer(db, two, 'rejected', {
      actor: 'customer',
      note: 'Budget deferred to next fiscal year.',
      at: '2025-05-22T09:10:00Z',
      today: '2025-05-22',
    });

    // 0003 — accepted (mixed VAT)
    let three = draft({
      customer: DONAU,
      title: 'Fleet telematics rollout',
      created: '2025-09-10T09:05:00Z',
      validUntil: '2025-10-15',
      intro: 'Rollout across the first 25 vehicles, including driver onboarding.',
      terms: DEFAULT_TERMS,
      lines: L([
        ['Telematics unit incl. install (per vehicle)', 25, 49_00, 20, 5],
        ['Driver training session', 2, 340_00, 10],
      ]),
    });
    finalizeOffer(db, three, { sentDate: '2025-09-12' });
    decideOffer(db, three, 'accepted', {
      actor: 'customer',
      at: '2025-09-30T11:00:00Z',
      today: '2025-09-30',
    });

    // 0004 — withdrawn
    let four = draft({
      customer: CATHEDRAL,
      title: 'Brand film — concept phase',
      created: '2025-11-18T13:25:00Z',
      validUntil: '2025-12-20',
      lines: L([['Brand film production — concept phase', 1, 2_500_00, 20]]),
    });
    finalizeOffer(db, four, { sentDate: '2025-11-20' });
    withdrawOffer(db, four, 'Scope replaced by a direct contract.', {
      actor: 'admin',
      at: '2025-11-28T10:00:00Z',
      today: '2025-11-28',
    });

    // ── 2026 · OFF-2026-0001 … (finalized in this order) ────────────────
    // 0001 — accepted
    let f1 = draft({
      customer: AUER,
      title: 'Conveyor line software update 2026',
      created: '2026-01-08T09:05:00Z',
      validUntil: '2026-02-15',
      intro: 'Annual software update with an extended operator handbook.',
      terms: DEFAULT_TERMS,
      lines: L([
        ['Conveyor line software update', 1, 2_100_00, 20],
        ['Operator handbook (printed)', 10, 24_90, 10],
      ]),
    });
    finalizeOffer(db, f1, { sentDate: '2026-01-09' });
    decideOffer(db, f1, 'accepted', {
      actor: 'customer',
      note: 'Go ahead.',
      at: '2026-01-21T10:30:00Z',
      today: '2026-01-21',
    });

    // 0002 — sent, still open (valid far into the future)
    let f2 = draft({
      customer: EBNER,
      title: 'Managed backup — Q3/2026',
      created: '2026-06-30T14:20:00Z',
      validUntil: '2026-12-31',
      terms: DEFAULT_TERMS,
      lines: L([
        ['Managed backup — Q3/2026', 3, 240_00, 0],
        ['Offsite storage per TB', 12, 9_50, 0, 10],
      ]),
    });
    finalizeOffer(db, f2, { sentDate: '2026-07-01' });

    // 0003 — expired (validity in the past, never decided)
    let f3 = draft({
      customer: BERGWALD,
      title: 'Interim management — spring 2026',
      created: '2026-04-10T10:30:00Z',
      validUntil: '2026-05-15',
      terms: DEFAULT_TERMS,
      lines: L([
        ['Interim management (per day)', 8, 780_00, 20],
        ['Expenses: rail travel', 1, 156_40, 10],
      ]),
    });
    finalizeOffer(db, f3, { sentDate: '2026-04-11' });

    // 0004 — rejected
    let f4 = draft({
      customer: CATHEDRAL,
      title: 'Product photography package',
      created: '2026-05-20T09:15:00Z',
      validUntil: '2026-06-20',
      lines: L([
        ['Product photography half-day', 1, 640_00, 20],
        ['Image licences (per image)', 24, 18_00, 20, 20],
        ['Rush delivery surcharge', 1, 90_00, 20],
      ]),
    });
    finalizeOffer(db, f4, { sentDate: '2026-05-21' });
    decideOffer(db, f4, 'rejected', {
      actor: 'customer',
      note: 'Chose an in-house option.',
      at: '2026-06-02T15:30:00Z',
      today: '2026-06-02',
    });

    // 0005 — superseded by a revision (0006)
    let f5 = draft({
      customer: DONAU,
      title: 'GPS tracker hardware batch',
      created: '2026-06-05T16:00:00Z',
      validUntil: '2026-07-05',
      lines: L([['GPS tracker hardware batch', 40, 62_00, 20]]),
    });
    finalizeOffer(db, f5, { sentDate: '2026-06-06' });
    // Revision: corrected quantity and a volume discount. reviseOffer marks
    // 0005 superseded and returns a fresh draft that we adjust and send.
    const revision = reviseOffer(db, f5, { actor: 'admin', at: '2026-06-12T09:00:00Z' });
    updateDraft(db, revision, {
      customerId: DONAU,
      title: 'GPS tracker hardware batch (rev. 2)',
      validUntil: '2026-07-20',
      intro: 'Revised per your call: corrected quantity and a volume discount.',
      terms: DEFAULT_TERMS,
      lines: L([
        ['GPS tracker hardware batch', 60, 62_00, 20, 8],
        ['Spare antenna kit', 6, 34_00, 20],
      ]),
    });
    finalizeOffer(db, revision, { sentDate: '2026-06-12' }); // → OFF-2026-0006
    decideOffer(db, revision, 'accepted', {
      actor: 'customer',
      note: 'Accepted the revised offer.',
      at: '2026-06-25T10:00:00Z',
      today: '2026-06-25',
    });

    // ── Drafts (no number yet) ──────────────────────────────────────────
    draft({
      customer: BERGWALD,
      title: 'Strategy review — H2/2026',
      created: '2026-07-14T11:30:00Z',
      validUntil: '2026-08-31',
      intro: 'Draft for internal review — mixed-rate example with per-line rounding.',
      lines: L([
        ['USB-C adapter (promo)', 3, 33, 20, 10],
        ['Strategy review June 2026', 1, 1_450_00, 20],
        ['Book: "Boring Software That Works"', 2, 29_90, 10],
      ]),
    });
    draft({
      customer: EBNER,
      title: 'Server rack refresh (draft)',
      created: '2026-07-16T09:50:00Z',
      validUntil: '2026-09-15',
      lines: L([
        ['Server rack hardware (reverse charge)', 2, 1_890_00, 0],
        ['Installation service', 6, 110_00, 0, 5],
      ]),
    });
  })();

  const stats = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM customers) AS customers,
              (SELECT COUNT(*) FROM offers) AS offers,
              (SELECT COUNT(*) FROM offer_events) AS events`,
    )
    .get() as { customers: number; offers: number; events: number };
  console.log(
    `[seed] inserted ${stats.customers} customers, ${stats.offers} offers, ${stats.events} events`,
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
