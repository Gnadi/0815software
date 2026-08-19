/**
 * The published reporting contract — the `report_*` views (server/db.ts,
 * docs/REPORTING-CONTRACT.md).
 *
 * These views are what OTHER software reads. The tables behind them are
 * private and get refactored; the views are the promise. So this suite tests
 * the promise, not the implementation:
 *
 *   - the views exist after a plain openDb(), on a fresh AND an existing
 *     database (the migration is append-only and idempotent);
 *   - drafts never appear in any of them;
 *   - a view's money equals the module's own computeTotals() for the same
 *     invoice — the property that stops a report and the invoice PDF from
 *     disagreeing;
 *   - cancelled invoices are present and marked, but are not receivables;
 *   - the aging buckets are right ON their boundaries, not just near them.
 *
 * Every invoice here is built through the real domain functions, so the rows
 * under test got there the way a user's rows do.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import {
  addDays,
  cancelInvoice,
  createDraft,
  finalizeInvoice,
  recordPayment,
  todayIso,
  type LineInput,
} from '../server/invoices.js';
import { computeTotals } from '../shared/money.js';

const REPORT_VIEWS = [
  'report_invoices',
  'report_invoice_lines',
  'report_payments',
  'report_receivables_aging',
];

const ONE_LINE: LineInput[] = [
  { description: 'Consulting', quantity: 1, unitPriceCents: 10_000, vatRate: 20 },
];

let db: Database.Database;

/** A customer with a name and VAT id, returning its id. */
function addCustomer(name: string, vatId: string | null = null): number {
  const info = db
    .prepare('INSERT INTO customers (name, email, vat_id, address, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, null, vatId, null, '2026-01-01T00:00:00.000Z');
  return Number(info.lastInsertRowid);
}

/** Draft → sent, issued `issueDate`. Returns the invoice id and its number. */
function sendInvoice(
  customerId: number,
  lines: LineInput[] = ONE_LINE,
  issueDate = todayIso(),
  paymentTermsDays = 14,
): { id: number; number: string } {
  const id = createDraft(db, { customerId, paymentTermsDays, note: null, lines });
  const { number } = finalizeInvoice(db, id, issueDate);
  return { id, number };
}

/**
 * Send an invoice whose due date is exactly `daysOverdue` days in the past.
 * Payment terms are 0, so due_date === issue_date and the arithmetic is exact.
 */
function sendDueDaysAgo(customerId: number, daysOverdue: number, lines = ONE_LINE): string {
  return sendInvoice(customerId, lines, addDays(todayIso(), -daysOverdue), 0).number;
}

function reportInvoice(number: string): Record<string, any> {
  return db.prepare('SELECT * FROM report_invoices WHERE invoice_number = ?').get(number) as any;
}

function agingFor(customerId: number): Record<string, any> | undefined {
  return db
    .prepare('SELECT * FROM report_receivables_aging WHERE customer_id = ?')
    .get(customerId) as any;
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('the views exist and the migration is idempotent', () => {
  it('creates every report_* view on a fresh database', () => {
    const views = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name")
      .all() as { name: string }[];
    expect(views.map((v) => v.name)).toEqual([...REPORT_VIEWS].sort());
  });

  it('publishes exactly the documented columns, in order', () => {
    // Column names ARE the contract. Renaming or dropping one below is a
    // breaking change for every consumer and has to be a deliberate edit here.
    const columns = (view: string) =>
      (db.prepare(`PRAGMA table_info(${view})`).all() as { name: string }[]).map((c) => c.name);

    expect(columns('report_invoices')).toEqual([
      'invoice_number',
      'issue_date',
      'due_date',
      'status',
      'is_cancelled',
      'cancelled_at',
      'cancellation_reason',
      'payment_terms_days',
      'customer_id',
      'customer_name',
      'customer_vat_id',
      'net_cents',
      'vat_cents',
      'gross_cents',
      'paid_cents',
      'outstanding_cents',
      'days_overdue',
    ]);
    expect(columns('report_invoice_lines')).toEqual([
      'invoice_number',
      'issue_date',
      'line_position',
      'description',
      'quantity',
      'unit_price_cents',
      'vat_rate',
      'line_net_cents',
      'status',
      'is_cancelled',
    ]);
    expect(columns('report_payments')).toEqual([
      'payment_id',
      'invoice_number',
      'customer_id',
      'customer_name',
      'payment_date',
      'amount_cents',
      'note',
      'invoice_status',
      'invoice_is_cancelled',
    ]);
    expect(columns('report_receivables_aging')).toEqual([
      'customer_id',
      'customer_name',
      'customer_vat_id',
      'open_invoice_count',
      'outstanding_cents',
      'current_cents',
      'overdue_1_30_cents',
      'overdue_31_60_cents',
      'overdue_61_90_cents',
      'overdue_90_plus_cents',
    ]);
  });

  it('REBUILDS the views on re-open, so an added column reaches an existing database', () => {
    // The property this protects: `CREATE VIEW IF NOT EXISTS` is inert on a
    // database that already ran it, so every column added to the contract
    // would land in fresh test databases and never in a deployed stack.
    // Simulated here by planting an OLD definition and re-opening.
    const dir = mkdtempSync(join(tmpdir(), 'mod04-views-'));
    const path = join(dir, 'data.db');
    try {
      const first = openDb(path);
      const customer = Number(
        first
          .prepare('INSERT INTO customers (name, email, vat_id, address, created_at) VALUES (?,?,?,?,?)')
          .run('Upgrade GmbH', null, null, null, '2026-01-01T00:00:00.000Z').lastInsertRowid,
      );
      first
        .prepare(
          `INSERT INTO invoices (number, customer_id, status, issue_date, due_date, payment_terms_days, created_at)
           VALUES ('INV-2026-0001', ?, 'sent', '2026-01-01', '2026-01-15', 14, '2026-01-01T00:00:00.000Z')`,
        )
        .run(customer);

      // Downgrade the contract behind the module's back: a view without the
      // cancellation columns, exactly like a database provisioned before they
      // were added.
      first.exec(`
        DROP VIEW report_invoice_lines;
        CREATE VIEW report_invoice_lines AS SELECT 'stale' AS invoice_number;
      `);
      expect(
        (first.prepare('PRAGMA table_info(report_invoice_lines)').all() as { name: string }[]).map(
          (c) => c.name,
        ),
      ).toEqual(['invoice_number']);
      first.close();

      const second = openDb(path);
      try {
        const columns = (
          second.prepare('PRAGMA table_info(report_invoice_lines)').all() as { name: string }[]
        ).map((c) => c.name);
        expect(columns).toContain('is_cancelled');
        expect(columns).toContain('line_net_cents');
        // Every view is back to the current definition, not just the one we
        // clobbered, and the data underneath is untouched.
        const views = (
          second
            .prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name")
            .all() as { name: string }[]
        ).map((v) => v.name);
        expect(views).toEqual([...REPORT_VIEWS].sort());
        expect(
          second.prepare('SELECT COUNT(*) AS n FROM report_invoices').get(),
        ).toEqual({ n: 1 });
        expect(second.prepare('SELECT COUNT(*) AS n FROM customers').get()).toEqual({ n: 1 });
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The views are a read-only contract: `ensureReportViews` may add and
  // rebuild views, and must never materialize one as a table or touch the
  // module's own. The list is the whole schema, receivables and payables
  // alike, so a stray CREATE TABLE anywhere in the migration shows up here.
  it('adds no table and changes no existing one', () => {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[]
    ).map((t) => t.name);
    expect(tables).toEqual([
      'bills',
      'creditors',
      'customers',
      'invoice_counters',
      'invoice_lines',
      'invoices',
      'payment_run_items',
      'payment_runs',
      'payments',
    ]);
    expect(tables.some((t) => t.startsWith('report_'))).toBe(false);
  });
});

describe('drafts never appear', () => {
  it('excludes a draft from every view, and includes it once sent', () => {
    const customer = addCustomer('Draft AG');
    const draftId = createDraft(db, {
      customerId: customer,
      paymentTermsDays: 14,
      note: null,
      lines: ONE_LINE,
    });

    expect(db.prepare('SELECT COUNT(*) AS n FROM report_invoices').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM report_invoice_lines').get()).toEqual({ n: 0 });

    const { number } = finalizeInvoice(db, draftId, todayIso());
    expect(db.prepare('SELECT COUNT(*) AS n FROM report_invoices').get()).toEqual({ n: 1 });
    expect(reportInvoice(number).invoice_number).toBe(number);
    expect(db.prepare('SELECT COUNT(*) AS n FROM report_invoice_lines').get()).toEqual({ n: 1 });
  });

  it('never yields a row with a null invoice_number or issue_date', () => {
    const customer = addCustomer('Mixed GmbH');
    sendInvoice(customer);
    createDraft(db, { customerId: customer, paymentTermsDays: 14, note: null, lines: ONE_LINE });

    for (const view of ['report_invoices', 'report_invoice_lines']) {
      const nulls = db
        .prepare(`SELECT COUNT(*) AS n FROM ${view} WHERE invoice_number IS NULL OR issue_date IS NULL`)
        .get() as { n: number };
      expect(nulls.n, view).toBe(0);
    }
  });
});

describe('money matches the module’s own computation', () => {
  /** The awkward cases: per-line rounding, mixed VAT rates, fractional qty. */
  const CASES: { label: string; lines: LineInput[] }[] = [
    {
      label: '3 × €0.33 at 20% (the classic cent case)',
      lines: [{ description: 'Widget', quantity: 3, unitPriceCents: 33, vatRate: 20 }],
    },
    {
      label: 'fractional hours at an odd rate',
      lines: [{ description: 'Hours', quantity: 7.5, unitPriceCents: 8_333, vatRate: 20 }],
    },
    {
      label: 'three VAT rates on one invoice',
      lines: [
        { description: 'Hardware', quantity: 2, unitPriceCents: 19_999, vatRate: 20 },
        { description: 'Books', quantity: 3, unitPriceCents: 1_499, vatRate: 10 },
        { description: 'Exempt service', quantity: 1, unitPriceCents: 50_000, vatRate: 0 },
      ],
    },
    {
      label: 'a base whose VAT lands exactly on a half cent',
      lines: [{ description: 'Half-cent', quantity: 1, unitPriceCents: 5, vatRate: 10 }],
    },
    {
      label: 'many small lines, each rounded before summing',
      lines: Array.from({ length: 25 }, (_, i) => ({
        description: `Line ${i + 1}`,
        quantity: 1 / 3,
        unitPriceCents: 100 + i,
        vatRate: i % 2 === 0 ? 20 : 10,
      })),
    },
  ];

  it.each(CASES.map((c) => [c.label, c.lines] as const))(
    'report_invoices agrees with computeTotals: %s',
    (_label, lines) => {
      const customer = addCustomer('Totals GmbH');
      const { number } = sendInvoice(customer, [...lines]);

      const expected = computeTotals(
        lines.map((l) => ({
          quantity: l.quantity,
          unit_price_cents: l.unitPriceCents,
          vat_rate: l.vatRate,
        })),
      );
      const row = reportInvoice(number);
      expect(row.net_cents).toBe(expected.net_cents);
      expect(row.vat_cents).toBe(expected.vat_cents);
      expect(row.gross_cents).toBe(expected.gross_cents);
    },
  );

  it('rounds the line net per line, so the lines sum to the invoice net', () => {
    const lines: LineInput[] = [
      { description: 'A', quantity: 3, unitPriceCents: 33, vatRate: 20 },
      { description: 'B', quantity: 1 / 3, unitPriceCents: 101, vatRate: 20 },
      { description: 'C', quantity: 2.5, unitPriceCents: 4_999, vatRate: 10 },
    ];
    const customer = addCustomer('Lines GmbH');
    const { number } = sendInvoice(customer, lines);

    const rows = db
      .prepare('SELECT * FROM report_invoice_lines WHERE invoice_number = ? ORDER BY line_position')
      .all(number) as any[];
    expect(rows.map((r) => r.line_net_cents)).toEqual(
      lines.map((l) => Math.round(l.quantity * l.unitPriceCents)),
    );

    const sum = rows.reduce((acc, r) => acc + r.line_net_cents, 0);
    expect(sum).toBe(reportInvoice(number).net_cents);
  });

  it('reports paid and outstanding from the payments the module recorded', () => {
    const customer = addCustomer('Paying GmbH');
    const { id, number } = sendInvoice(customer);
    const gross = reportInvoice(number).gross_cents;

    recordPayment(db, id, { date: todayIso(), amountCents: 4_000, note: null });
    let row = reportInvoice(number);
    expect(row.paid_cents).toBe(4_000);
    expect(row.outstanding_cents).toBe(gross - 4_000);

    recordPayment(db, id, { date: todayIso(), amountCents: gross - 4_000, note: 'rest' });
    row = reportInvoice(number);
    expect(row.paid_cents).toBe(gross);
    expect(row.outstanding_cents).toBe(0);

    const payments = db
      .prepare('SELECT * FROM report_payments WHERE invoice_number = ? ORDER BY payment_id')
      .all(number) as any[];
    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.amount_cents)).toEqual([4_000, gross - 4_000]);
    expect(payments[0].customer_name).toBe('Paying GmbH');
    expect(payments[1].note).toBe('rest');
  });

  it('reports an invoice with no lines as zero, not as null', () => {
    // Finalization requires a line, so this is a hand-built edge case — the
    // view must still answer with numbers a consumer can sum.
    const customer = addCustomer('Empty GmbH');
    db.prepare(
      `INSERT INTO invoices (number, customer_id, status, issue_date, due_date, payment_terms_days, created_at)
       VALUES ('INV-2026-9999', ?, 'sent', '2026-01-01', '2026-01-15', 14, '2026-01-01T00:00:00.000Z')`,
    ).run(customer);
    const row = reportInvoice('INV-2026-9999');
    expect(row.net_cents).toBe(0);
    expect(row.vat_cents).toBe(0);
    expect(row.gross_cents).toBe(0);
    expect(row.paid_cents).toBe(0);
    expect(row.outstanding_cents).toBe(0);
  });
});

describe('cancelled invoices are included and marked', () => {
  it('keeps the number and the totals, flags it, and drops it from receivables', () => {
    const customer = addCustomer('Cancelled GmbH');
    const number = sendDueDaysAgo(customer, 45);
    const invoiceId = (
      db.prepare('SELECT id FROM invoices WHERE number = ?').get(number) as { id: number }
    ).id;

    expect(agingFor(customer)!.outstanding_cents).toBe(12_000);

    cancelInvoice(db, invoiceId, 'duplicate', '2026-07-01T09:00:00.000Z');

    const row = reportInvoice(number);
    expect(row.status).toBe('cancelled');
    expect(row.is_cancelled).toBe(1);
    expect(row.cancellation_reason).toBe('duplicate');
    expect(row.cancelled_at).toBe('2026-07-01T09:00:00.000Z');
    // The money it was issued for is still visible — a report that wants it
    // gone filters on the flag, it does not have to guess.
    expect(row.gross_cents).toBe(12_000);
    expect(row.days_overdue).toBe(0);

    expect(agingFor(customer)).toBeUndefined();
  });

  it('marks cancellation on the LINE and PAYMENT views, not only on the header', () => {
    // Without this, `SELECT SUM(line_net_cents) FROM report_invoice_lines`
    // silently counts cancelled revenue and there is no column to filter on.
    const customer = addCustomer('Mixed Fate GmbH');
    const live = sendInvoice(customer, [
      { description: 'Kept A', quantity: 1, unitPriceCents: 10_000, vatRate: 20 },
      { description: 'Kept B', quantity: 2, unitPriceCents: 2_500, vatRate: 20 },
    ]);
    const doomed = sendInvoice(customer, [
      { description: 'Voided', quantity: 1, unitPriceCents: 40_000, vatRate: 20 },
    ]);
    recordPayment(db, live.id, { date: todayIso(), amountCents: 1_000, note: 'part' });
    recordPayment(db, doomed.id, { date: todayIso(), amountCents: 2_000, note: 'refund me' });
    cancelInvoice(db, doomed.id, 'ordered in error', '2026-07-01T09:00:00.000Z');

    const lines = db
      .prepare('SELECT * FROM report_invoice_lines ORDER BY invoice_number, line_position')
      .all() as any[];
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      // Every published row is filterable: it says which invoice it belongs
      // to and whether that invoice still stands.
      expect(line.status, line.invoice_number).toMatch(/^(sent|cancelled)$/);
      expect(line.is_cancelled).toBe(line.invoice_number === doomed.number ? 1 : 0);
    }
    const liveNet = db
      .prepare('SELECT SUM(line_net_cents) AS n FROM report_invoice_lines WHERE is_cancelled = 0')
      .get() as { n: number };
    expect(liveNet.n).toBe(15_000);

    const payments = db
      .prepare('SELECT * FROM report_payments ORDER BY payment_id')
      .all() as any[];
    expect(payments).toHaveLength(2);
    for (const payment of payments) {
      expect(payment.invoice_status).toMatch(/^(sent|cancelled)$/);
      expect(payment.invoice_is_cancelled).toBe(
        payment.invoice_number === doomed.number ? 1 : 0,
      );
    }
    // A payment against a cancelled invoice is still a real payment and is
    // still published — it is money that moved and probably needs refunding.
    const againstCancelled = payments.filter((p) => p.invoice_is_cancelled === 1);
    expect(againstCancelled).toHaveLength(1);
    expect(againstCancelled[0].amount_cents).toBe(2_000);
    expect(againstCancelled[0].invoice_status).toBe('cancelled');

    // The header view agrees with both detail views.
    expect(reportInvoice(doomed.number).is_cancelled).toBe(1);
    expect(reportInvoice(live.number).is_cancelled).toBe(0);
  });

  it('leaves no published row without a way to tell whether it was cancelled', () => {
    const customer = addCustomer('Coverage GmbH');
    const kept = sendInvoice(customer);
    const killed = sendInvoice(customer);
    recordPayment(db, kept.id, { date: todayIso(), amountCents: 500, note: null });
    recordPayment(db, killed.id, { date: todayIso(), amountCents: 500, note: null });
    cancelInvoice(db, killed.id, 'test', '2026-07-01T09:00:00.000Z');

    // Contract rule 3, asserted as a property rather than per-row: no row in
    // either detail view has a NULL cancellation marker.
    for (const [view, flag] of [
      ['report_invoice_lines', 'is_cancelled'],
      ['report_payments', 'invoice_is_cancelled'],
    ] as const) {
      const unknown = db
        .prepare(`SELECT COUNT(*) AS n FROM ${view} WHERE ${flag} IS NULL`)
        .get() as { n: number };
      expect(unknown.n, view).toBe(0);
      const marked = db
        .prepare(`SELECT COUNT(*) AS n FROM ${view} WHERE ${flag} = 1`)
        .get() as { n: number };
      expect(marked.n, view).toBe(1);
    }
  });
});

describe('days_overdue and the aging buckets', () => {
  it('is 0 up to and including the due date, then counts whole days', () => {
    const customer = addCustomer('Timing GmbH');
    const dueToday = sendDueDaysAgo(customer, 0);
    const dueTomorrow = sendInvoice(customer, ONE_LINE, todayIso(), 1).number;
    const oneDayLate = sendDueDaysAgo(customer, 1);
    const thirtyLate = sendDueDaysAgo(customer, 30);

    expect(reportInvoice(dueToday).days_overdue).toBe(0);
    expect(reportInvoice(dueTomorrow).days_overdue).toBe(0);
    expect(reportInvoice(oneDayLate).days_overdue).toBe(1);
    expect(reportInvoice(thirtyLate).days_overdue).toBe(30);
  });

  it('is 0 once the invoice is settled, however late it was', () => {
    const customer = addCustomer('Settled GmbH');
    const number = sendDueDaysAgo(customer, 200);
    const id = (db.prepare('SELECT id FROM invoices WHERE number = ?').get(number) as { id: number })
      .id;
    expect(reportInvoice(number).days_overdue).toBe(200);

    recordPayment(db, id, { date: todayIso(), amountCents: 12_000, note: null });
    expect(reportInvoice(number).days_overdue).toBe(0);
    expect(reportInvoice(number).outstanding_cents).toBe(0);
  });

  it('puts each invoice in the right bucket exactly at the boundaries', () => {
    const customer = addCustomer('Aging GmbH', 'ATU12345678');
    // One invoice per boundary day, each €120.00 gross (€100 net at 20%).
    for (const days of [0, 1, 30, 31, 60, 61, 90, 91]) sendDueDaysAgo(customer, days);

    const row = agingFor(customer)!;
    expect(row.customer_name).toBe('Aging GmbH');
    expect(row.customer_vat_id).toBe('ATU12345678');
    expect(row.open_invoice_count).toBe(8);
    expect(row.outstanding_cents).toBe(8 * 12_000);

    expect(row.current_cents).toBe(12_000); // day 0 — due today, not late
    expect(row.overdue_1_30_cents).toBe(2 * 12_000); // days 1 and 30
    expect(row.overdue_31_60_cents).toBe(2 * 12_000); // days 31 and 60
    expect(row.overdue_61_90_cents).toBe(2 * 12_000); // days 61 and 90
    expect(row.overdue_90_plus_cents).toBe(12_000); // day 91

    // The buckets partition the balance: no double counting, nothing lost.
    const buckets =
      row.current_cents +
      row.overdue_1_30_cents +
      row.overdue_31_60_cents +
      row.overdue_61_90_cents +
      row.overdue_90_plus_cents;
    expect(buckets).toBe(row.outstanding_cents);
  });

  it('nets partial payments off the bucket, and drops a customer who owes nothing', () => {
    const customer = addCustomer('Partial GmbH');
    const number = sendDueDaysAgo(customer, 40);
    const id = (db.prepare('SELECT id FROM invoices WHERE number = ?').get(number) as { id: number })
      .id;

    recordPayment(db, id, { date: todayIso(), amountCents: 5_000, note: null });
    expect(agingFor(customer)!.overdue_31_60_cents).toBe(7_000);
    expect(agingFor(customer)!.outstanding_cents).toBe(7_000);

    recordPayment(db, id, { date: todayIso(), amountCents: 7_000, note: null });
    expect(agingFor(customer)).toBeUndefined();
  });

  it('reports one row per customer, keyed by customer_id', () => {
    const a = addCustomer('Alpha GmbH');
    const b = addCustomer('Beta GmbH');
    sendDueDaysAgo(a, 10);
    sendDueDaysAgo(a, 100);
    sendDueDaysAgo(b, 5);

    const rows = db
      .prepare('SELECT * FROM report_receivables_aging ORDER BY customer_id')
      .all() as any[];
    expect(rows.map((r) => r.customer_id)).toEqual([a, b]);
    expect(rows[0].open_invoice_count).toBe(2);
    expect(rows[0].outstanding_cents).toBe(24_000);
    expect(rows[1].open_invoice_count).toBe(1);
  });
});
