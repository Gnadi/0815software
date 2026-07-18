import type Database from 'better-sqlite3';
import {
  approvePo,
  closePo,
  createPo,
  markOrdered,
  rejectPo,
  submitPo,
  type PoLineInput,
} from './purchase-orders.js';
import { awardRfq, createRfq, inviteSupplier, upsertQuote, rfqLines } from './rfqs.js';

/**
 * Example dataset: 4 suppliers, 3 RFQs (one open, one quoted, one
 * awarded — the award produced a draft PO) and 10 purchase orders across
 * every status and all three approval brackets, with approval histories
 * including one rejection. Everything goes THROUGH the domain functions
 * (createPo → submitPo → approvePo/rejectPo → markOrdered → closePo,
 * createRfq → inviteSupplier → upsertQuote → awardRfq), so the seeded
 * database satisfies the same invariants as a live one: frozen
 * submission snapshots, append-only approvals, no stored totals, no
 * stored derived statuses.
 *
 * Idempotent: the dataset is relational, so seeding is all-or-nothing —
 * if any suppliers exist the seed is skipped entirely.
 */
export function seed(db: Database.Database): void {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM suppliers').get() as { count: number };
  if (count > 0) {
    console.log(`[seed] database already contains ${count} suppliers, skipping`);
    return;
  }

  db.transaction(() => {
    // ── Suppliers ──────────────────────────────────────────────────────
    const insertSupplier = db.prepare(
      'INSERT INTO suppliers (name, contact, email, notes, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    const suppliers: [string, string, string, string | null][] = [
      [
        'Steiner Industriebedarf GmbH',
        'Karin Steiner',
        'verkauf@steiner-industrie.example.at',
        'Framework agreement until 12/2026; 30-day payment terms.',
      ],
      [
        'Novak Metall & Technik e.U.',
        'Jaroslav Novak',
        'office@novak-metall.example.at',
        'Machining and spare parts; short lead times.',
      ],
      [
        'Bureau Praxis Office Supply',
        'Sandra Leitner',
        'orders@bureaupraxis.example.at',
        null,
      ],
      [
        'Danube Cable & Electric GmbH',
        'Georg Pichler',
        'sales@danube-cable.example.at',
        'Certified for industrial installations (ÖVE).',
      ],
    ];
    for (const [name, contact, email, notes] of suppliers) {
      insertSupplier.run(name, contact, email, notes, '2026-01-12T09:00:00Z');
    }
    const sup = (name: string): number =>
      (db.prepare('SELECT id FROM suppliers WHERE name LIKE ?').get(`${name}%`) as { id: number }).id;
    const STEINER = sup('Steiner');
    const NOVAK = sup('Novak');
    const BUREAU = sup('Bureau');
    const DANUBE = sup('Danube');

    // Shorthand: PO line as [description, qty, unit, unit net cents].
    const L = (rows: [string, number, string, number][]): PoLineInput[] =>
      rows.map(([description, quantity, unit, unitPriceCents]) => ({
        description,
        quantity,
        unit,
        unitPriceCents,
      }));

    // ── RFQ 1 — open: invited, no quotes yet ───────────────────────────
    const rfqOpen = createRfq(db, {
      title: 'Workshop consumables Q4/2026',
      dueDate: '2026-08-15',
      note: 'Standing quarterly order — please quote per-unit including delivery.',
      createdAt: '2026-07-10T08:30:00Z',
      lines: [
        { description: 'Cutting discs 125 mm (box of 25)', quantity: 12, unit: 'box' },
        { description: 'Nitrile gloves size L (box of 100)', quantity: 30, unit: 'box' },
        { description: 'Machine oil ISO VG 46', quantity: 8, unit: 'canister' },
      ],
    });
    inviteSupplier(db, rfqOpen, STEINER, '2026-07-10T08:35:00Z');
    inviteSupplier(db, rfqOpen, NOVAK, '2026-07-10T08:36:00Z');

    // ── RFQ 2 — quoted (derived): two quotes in, side-by-side ──────────
    const rfqQuoted = createRfq(db, {
      title: 'Ergonomic office chairs (12×)',
      dueDate: '2026-07-25',
      note: 'Replacement for the second-floor open-plan office.',
      createdAt: '2026-06-24T10:00:00Z',
      lines: [
        { description: 'Ergonomic swivel chair, lumbar support, black', quantity: 12, unit: 'pc' },
        { description: 'Delivery and assembly on site', quantity: 1, unit: 'flat' },
      ],
    });
    inviteSupplier(db, rfqQuoted, BUREAU, '2026-06-24T10:05:00Z');
    inviteSupplier(db, rfqQuoted, STEINER, '2026-06-24T10:06:00Z');
    {
      const [chairLine, deliveryLine] = rfqLines(db, rfqQuoted);
      upsertQuote(db, rfqQuoted, BUREAU, {
        validUntil: '2026-08-31',
        note: 'Chairs from stock; assembly within one week.',
        createdAt: '2026-06-30T14:20:00Z',
        prices: [
          { rfqLineId: chairLine!.id, unitPriceCents: 289_00 },
          { rfqLineId: deliveryLine!.id, unitPriceCents: 240_00 },
        ],
      });
      upsertQuote(db, rfqQuoted, STEINER, {
        validUntil: '2026-09-30',
        note: 'Alternative model, 5-year warranty.',
        createdAt: '2026-07-02T09:10:00Z',
        prices: [
          { rfqLineId: chairLine!.id, unitPriceCents: 274_50 },
          { rfqLineId: deliveryLine!.id, unitPriceCents: 320_00 },
        ],
      });
    }

    // ── RFQ 3 — awarded: winner's quote copied into a draft PO ─────────
    const rfqAwarded = createRfq(db, {
      title: 'CNC spindle replacement incl. installation',
      dueDate: '2026-07-05',
      note: 'Machine M-14; production stops 2026-08-03 for the swap.',
      createdAt: '2026-06-15T07:45:00Z',
      lines: [
        { description: 'Spindle unit 18k rpm, HSK-63', quantity: 1, unit: 'pc' },
        { description: 'Installation and alignment (per hour)', quantity: 16, unit: 'h' },
        { description: 'Test run protocol', quantity: 1, unit: 'flat' },
      ],
    });
    inviteSupplier(db, rfqAwarded, NOVAK, '2026-06-15T08:00:00Z');
    inviteSupplier(db, rfqAwarded, STEINER, '2026-06-15T08:01:00Z');
    {
      const [spindle, install, protocol] = rfqLines(db, rfqAwarded);
      upsertQuote(db, rfqAwarded, NOVAK, {
        validUntil: '2026-08-15',
        note: 'Includes 24-month warranty on the spindle.',
        createdAt: '2026-06-22T11:30:00Z',
        prices: [
          { rfqLineId: spindle!.id, unitPriceCents: 8_450_00 },
          { rfqLineId: install!.id, unitPriceCents: 98_00 },
          { rfqLineId: protocol!.id, unitPriceCents: 180_00 },
        ],
      });
      upsertQuote(db, rfqAwarded, STEINER, {
        validUntil: '2026-07-31',
        note: null,
        createdAt: '2026-06-25T16:05:00Z',
        prices: [
          { rfqLineId: spindle!.id, unitPriceCents: 8_900_00 },
          { rfqLineId: install!.id, unitPriceCents: 92_00 },
          { rfqLineId: protocol!.id, unitPriceCents: 0 },
        ],
      });
    }
    // Novak wins (€10,198.00 vs €10,372.00) → draft PO-2026-0001.
    awardRfq(db, rfqAwarded, NOVAK, '2026-07-01T09:00:00Z');

    // ── Purchase orders across every status and bracket ────────────────

    // Draft, tier-1 bracket (≤ €1,000): never submitted.
    createPo(db, {
      supplierId: BUREAU,
      note: 'Toner and paper restock for July.',
      createdAt: '2026-07-14T09:20:00Z',
      lines: L([
        ['Toner cartridge CF259X', 4, 'pc', 89_90],
        ['Copy paper A4 80g (pallet of 100 reams)', 1, 'pallet', 349_00],
      ]),
    }); // total €708.60 → tier 1 only once submitted

    // Draft AFTER REJECTION, tier-1+2 bracket: history survives.
    const poRejected = createPo(db, {
      supplierId: DANUBE,
      note: 'Cable trays for hall extension — phase 1.',
      createdAt: '2026-07-02T13:00:00Z',
      lines: L([
        ['Cable tray 300 mm galvanized (3 m)', 40, 'pc', 41_50],
        ['Mounting brackets heavy duty', 120, 'pc', 6_80],
        ['Threaded rod M10 (2 m)', 60, 'pc', 4_90],
      ]),
    }); // €2,770.00 → tiers 1+2
    submitPo(db, poRejected, '2026-07-03T08:15:00Z');
    approvePo(db, poRejected, { tier: 1, approver: 'M. Huber', note: 'Prices match framework rates.', at: '2026-07-03T10:40:00Z' });
    rejectPo(db, poRejected, {
      tier: 2,
      approver: 'S. Wagner',
      note: 'Phase 1 quantities look double-ordered — please check against the site plan.',
      at: '2026-07-04T09:05:00Z',
    }); // back to draft; tier-1 approval voided but retained

    // Submitted, tier-1 bracket: waiting for the first approval.
    const poSubmitted1 = createPo(db, {
      supplierId: STEINER,
      note: null,
      createdAt: '2026-07-15T11:10:00Z',
      lines: L([
        ['Workbench mats anti-fatigue', 6, 'pc', 74_00],
        ['First-aid cabinet refill set', 3, 'set', 52_30],
      ]),
    }); // €600.90 → tier 1
    submitPo(db, poSubmitted1, '2026-07-15T11:12:00Z');

    // Submitted, tier-1+2 bracket: tier 1 done, tier 2 pending.
    const poSubmitted2 = createPo(db, {
      supplierId: NOVAK,
      note: 'Spare parts package for annual maintenance.',
      createdAt: '2026-07-12T08:00:00Z',
      lines: L([
        ['Ball screw spindle X-axis', 2, 'pc', 1_240_00],
        ['Linear guide carriage', 8, 'pc', 189_00],
        ['Proximity switch M12', 20, 'pc', 21_40],
      ]),
    }); // €4,420.00 → tiers 1+2
    submitPo(db, poSubmitted2, '2026-07-12T08:05:00Z');
    approvePo(db, poSubmitted2, { tier: 1, approver: 'M. Huber', note: null, at: '2026-07-12T13:30:00Z' });

    // APPROVED (derived), top bracket (> €10,000): all three tiers.
    const poApproved = createPo(db, {
      supplierId: DANUBE,
      note: 'Main distribution board upgrade — CAPEX 2026/17.',
      createdAt: '2026-07-06T10:00:00Z',
      lines: L([
        ['Low-voltage main distribution board 400A', 1, 'pc', 11_800_00],
        ['Installation and commissioning (per hour)', 24, 'h', 105_00],
        ['NYY-J 4x50 cable (per meter)', 180, 'm', 12_40],
      ]),
    }); // €16,552.00 → tiers 1+2+3
    submitPo(db, poApproved, '2026-07-06T10:10:00Z');
    approvePo(db, poApproved, { tier: 1, approver: 'M. Huber', note: null, at: '2026-07-06T15:00:00Z' });
    approvePo(db, poApproved, { tier: 2, approver: 'S. Wagner', note: 'Within CAPEX budget line 17.', at: '2026-07-07T09:20:00Z' });
    approvePo(db, poApproved, { tier: 3, approver: 'D. Berger', note: 'Funding confirmed.', at: '2026-07-08T14:45:00Z' });

    // ORDERED, tier-1+2 bracket.
    const poOrdered = createPo(db, {
      supplierId: STEINER,
      note: 'Racking for the new spare-parts corner.',
      createdAt: '2026-06-20T09:30:00Z',
      lines: L([
        ['Shelving bay 200×100×60 galvanized', 14, 'pc', 132_50],
        ['Anchor set per bay', 14, 'set', 9_90],
      ]),
    }); // €1,993.60 → tiers 1+2
    submitPo(db, poOrdered, '2026-06-20T09:40:00Z');
    approvePo(db, poOrdered, { tier: 1, approver: 'M. Huber', note: null, at: '2026-06-20T11:00:00Z' });
    approvePo(db, poOrdered, { tier: 2, approver: 'S. Wagner', note: null, at: '2026-06-21T08:30:00Z' });
    markOrdered(db, poOrdered, '2026-06-21T09:00:00Z');

    // ORDERED, top bracket — shows up in the ERP exports too.
    const poOrderedBig = createPo(db, {
      supplierId: NOVAK,
      note: 'Tooling package for the new milling line.',
      createdAt: '2026-06-10T07:50:00Z',
      lines: L([
        ['Tool holder HSK-63 precision set', 12, 'set', 640_00],
        ['Carbide end mill assortment', 6, 'set', 890_00],
        ['Tool presetter calibration service', 1, 'flat', 1_150_00],
      ]),
    }); // €14,170.00 → tiers 1+2+3
    submitPo(db, poOrderedBig, '2026-06-10T08:00:00Z');
    approvePo(db, poOrderedBig, { tier: 1, approver: 'M. Huber', note: null, at: '2026-06-10T10:15:00Z' });
    approvePo(db, poOrderedBig, { tier: 2, approver: 'S. Wagner', note: null, at: '2026-06-11T09:00:00Z' });
    approvePo(db, poOrderedBig, { tier: 3, approver: 'D. Berger', note: 'OK per investment plan.', at: '2026-06-12T16:20:00Z' });
    markOrdered(db, poOrderedBig, '2026-06-13T08:30:00Z');

    // CLOSED, tier-1 bracket: the full happy path, done and archived.
    const poClosed = createPo(db, {
      supplierId: BUREAU,
      note: 'Whiteboards for the project rooms.',
      createdAt: '2026-05-18T10:00:00Z',
      lines: L([
        ['Whiteboard 180×120 enamel', 3, 'pc', 219_00],
        ['Marker starter set', 6, 'set', 12_50],
      ]),
    }); // €732.00 → tier 1
    submitPo(db, poClosed, '2026-05-18T10:05:00Z');
    approvePo(db, poClosed, { tier: 1, approver: 'M. Huber', note: null, at: '2026-05-18T12:00:00Z' });
    markOrdered(db, poClosed, '2026-05-19T08:00:00Z');
    closePo(db, poClosed, '2026-06-02T09:30:00Z');

    // Draft, top bracket: big one still being put together.
    createPo(db, {
      supplierId: DANUBE,
      note: 'DRAFT — solar carport wiring, waiting for final layout.',
      createdAt: '2026-07-16T15:00:00Z',
      lines: L([
        ['Solar cable 6 mm² (per meter)', 900, 'm', 1_85],
        ['String inverter 25 kW', 4, 'pc', 2_310_00],
        ['DC combiner box', 4, 'pc', 415_00],
      ]),
    }); // €12,565.00 → will need tiers 1+2+3 once submitted
  })();

  const stats = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM suppliers) AS suppliers,
              (SELECT COUNT(*) FROM rfqs) AS rfqs,
              (SELECT COUNT(*) FROM purchase_orders) AS pos,
              (SELECT COUNT(*) FROM approvals) AS approvals`,
    )
    .get() as { suppliers: number; rfqs: number; pos: number; approvals: number };
  console.log(
    `[seed] inserted ${stats.suppliers} suppliers, ${stats.rfqs} RFQs, ${stats.pos} purchase orders, ${stats.approvals} approval rows`,
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
