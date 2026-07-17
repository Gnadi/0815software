import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { addDays, todayIso } from '../server/invoices.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import { computeTotals } from '../shared/money.js';
import type { InvoiceDetail, InvoiceRow, Ledger } from '../shared/types.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

const seller: SellerConfig = {
  name: '0815software GmbH',
  addressLines: ['Beispielgasse 8/15', '1010 Wien', 'Austria'],
  vatId: 'ATU00000000',
  iban: 'AT00 0000 0000 0000 0000',
  bic: 'EXAMPLEX',
};

let db: Database.Database;
let app: Express;
let cookie: string;

async function listInvoices(query = ''): Promise<InvoiceRow[]> {
  const res = await request(app).get(`/api/invoices${query}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body.invoices as InvoiceRow[];
}

async function detail(id: number): Promise<InvoiceDetail> {
  const res = await request(app).get(`/api/invoices/${id}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as InvoiceDetail;
}

/** Create a draft for customer 1 with the given lines (defaults: one €100 line at 20%). */
async function createDraft(
  lines: Record<string, unknown>[] = [
    { description: 'Test service', quantity: 1, unit_price_cents: 10_000, vat_rate: 20 },
  ],
  extra: Record<string, unknown> = {},
): Promise<InvoiceDetail> {
  const res = await request(app)
    .post('/api/invoices')
    .set('Cookie', cookie)
    .send({ customer_id: 1, payment_terms_days: 14, lines, ...extra });
  expect(res.status).toBe(201);
  return res.body as InvoiceDetail;
}

async function finalize(id: number, issueDate?: string): Promise<InvoiceDetail> {
  const res = await request(app)
    .post(`/api/invoices/${id}/finalize`)
    .set('Cookie', cookie)
    .send(issueDate ? { issue_date: issueDate } : {});
  expect(res.status).toBe(200);
  return res.body as InvoiceDetail;
}

/** Highest sequence number already used for a year. */
function maxSeq(year: number): number {
  const row = db
    .prepare('SELECT COALESCE(last_seq, 0) AS n FROM invoice_counters WHERE year = ?')
    .get(year) as { n: number } | undefined;
  return row?.n ?? 0;
}

beforeAll(async () => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, auth, seller });

  const res = await request(app)
    .post('/api/login')
    .send({ username: 'admin', password: 'test-password' });
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
});

describe('auth', () => {
  it('rejects unauthenticated requests with 401', async () => {
    for (const path of ['/api/invoices', '/api/customers', '/api/invoices/1', '/api/invoices/1/pdf', '/api/customers/1/ledger']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
    }
    const post = await request(app).post('/api/invoices').send({});
    expect(post.status).toBe(401);
  });

  it('rejects bad credentials', async () => {
    const res = await request(app).post('/api/login').send({ username: 'admin', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('accepts good credentials and sets an HttpOnly session cookie', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ username: 'admin', password: 'test-password' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']![0]).toContain('mod04_session=');
    expect(res.headers['set-cookie']![0]).toContain('HttpOnly');
  });
});

describe('totals are derived from lines with per-line rounding', () => {
  it('handles the classic cent-rounding case: 3 × €0.33 at 20%', async () => {
    const invoice = await createDraft([
      { description: 'Sticker', quantity: 3, unit_price_cents: 33, vat_rate: 20 },
    ]);
    // 3 × 33 = 99 (not 0.99 → 1.00 per unit rounding): per-LINE rounding.
    expect(invoice.net_cents).toBe(99);
    expect(invoice.vat_cents).toBe(20); // round(99 × 0.20) = round(19.8)
    expect(invoice.gross_cents).toBe(119);
    expect(invoice.lines[0]!.net_cents).toBe(99);
  });

  it('computes a per-rate VAT breakdown for mixed rates', async () => {
    const invoice = await createDraft([
      { description: 'Zero-rated export', quantity: 2, unit_price_cents: 250, vat_rate: 0 },
      { description: 'Book', quantity: 1, unit_price_cents: 1_000, vat_rate: 10 },
      { description: 'Sticker', quantity: 3, unit_price_cents: 33, vat_rate: 20 },
    ]);
    expect(invoice.vat_breakdown).toEqual([
      { rate: 0, base_cents: 500, vat_cents: 0 },
      { rate: 10, base_cents: 1_000, vat_cents: 100 },
      { rate: 20, base_cents: 99, vat_cents: 20 },
    ]);
    expect(invoice.net_cents).toBe(1_599);
    expect(invoice.vat_cents).toBe(120);
    expect(invoice.gross_cents).toBe(1_719);
  });

  it('rounds fractional-quantity line nets per line (1.5 × €3.33)', async () => {
    const invoice = await createDraft([
      { description: 'Consulting (1.5h)', quantity: 1.5, unit_price_cents: 333, vat_rate: 20 },
    ]);
    expect(invoice.lines[0]!.net_cents).toBe(500); // round(499.5)
    expect(invoice.vat_cents).toBe(100);
    expect(invoice.gross_cents).toBe(600);
  });

  it('never stores totals — every listed amount equals recomputation from lines', async () => {
    const rows = await listInvoices();
    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const row of rows) {
      const lines = db
        .prepare('SELECT quantity, unit_price_cents, vat_rate FROM invoice_lines WHERE invoice_id = ?')
        .all(row.id) as { quantity: number; unit_price_cents: number; vat_rate: number }[];
      const totals = computeTotals(lines);
      expect(row.net_cents, `invoice ${row.id} net`).toBe(totals.net_cents);
      expect(row.vat_cents, `invoice ${row.id} vat`).toBe(totals.vat_cents);
      expect(row.gross_cents, `invoice ${row.id} gross`).toBe(totals.gross_cents);
    }
  });

  it('validates lines (empty set, bad rate, negative price)', async () => {
    const empty = await request(app)
      .post('/api/invoices')
      .set('Cookie', cookie)
      .send({ customer_id: 1, lines: [] });
    expect(empty.status).toBe(422);

    const bad = await request(app)
      .post('/api/invoices')
      .set('Cookie', cookie)
      .send({
        customer_id: 1,
        lines: [{ description: '', quantity: -1, unit_price_cents: 10.5, vat_rate: 19 }],
      });
    expect(bad.status).toBe(422);
    const fields = bad.body.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        'lines[0].description',
        'lines[0].quantity',
        'lines[0].unit_price_cents',
        'lines[0].vat_rate',
      ]),
    );
  });
});

describe('numbering is gapless and sequential per year, assigned at finalization', () => {
  it('drafts have no number; finalizing assigns the next one atomically', async () => {
    const draft = await createDraft();
    expect(draft.number).toBeNull();
    expect(draft.status).toBe('draft');
    expect(draft.issue_date).toBeNull();

    const year = Number(todayIso().slice(0, 4));
    const before = maxSeq(year);
    const sent = await finalize(draft.id);
    expect(sent.number).toBe(`INV-${year}-${String(before + 1).padStart(4, '0')}`);
    expect(sent.status).toBe('sent');
    expect(sent.issue_date).toBe(todayIso());
    expect(sent.due_date).toBe(addDays(todayIso(), 14));
  });

  it('several finalizations (fired concurrently) draw consecutive numbers with no gaps or duplicates', async () => {
    const year = Number(todayIso().slice(0, 4));
    const drafts = await Promise.all(Array.from({ length: 5 }, () => createDraft()));
    const before = maxSeq(year);

    const results = await Promise.all(drafts.map((d) => finalize(d.id)));
    const seqs = results.map((r) => Number(r.number!.split('-')[2])).sort((a, b) => a - b);
    expect(seqs).toEqual([before + 1, before + 2, before + 3, before + 4, before + 5]);

    // No duplicates across the whole table, ever.
    const dup = db
      .prepare('SELECT COUNT(*) AS c FROM (SELECT number FROM invoices WHERE number IS NOT NULL GROUP BY number HAVING COUNT(*) > 1)')
      .get() as { c: number };
    expect(dup.c).toBe(0);
  });

  it('deleting a draft leaves no gap because drafts never had a number', async () => {
    const year = Number(todayIso().slice(0, 4));
    const doomed = await createDraft();
    const survivor = await createDraft();
    const before = maxSeq(year);

    const del = await request(app).delete(`/api/invoices/${doomed.id}`).set('Cookie', cookie);
    expect(del.status).toBe(200);

    const sent = await finalize(survivor.id);
    expect(sent.number).toBe(`INV-${year}-${String(before + 1).padStart(4, '0')}`);
  });

  it('the full number sequence per year is gapless: 1..maxSeq all exist exactly once', () => {
    const years = db.prepare('SELECT year, last_seq FROM invoice_counters').all() as {
      year: number;
      last_seq: number;
    }[];
    expect(years.length).toBeGreaterThanOrEqual(2); // seed covers 2025 + current year
    for (const { year, last_seq } of years) {
      const numbers = (
        db
          .prepare("SELECT number FROM invoices WHERE number LIKE ? ORDER BY number")
          .all(`INV-${year}-%`) as { number: string }[]
      ).map((r) => r.number);
      const expected = Array.from(
        { length: last_seq },
        (_, i) => `INV-${year}-${String(i + 1).padStart(4, '0')}`,
      );
      expect(numbers, `year ${year}`).toEqual(expected);
    }
  });

  it('each year has its own sequence (finalizing into 2025 continues the 2025 series)', async () => {
    const before2025 = maxSeq(2025);
    expect(before2025).toBeGreaterThanOrEqual(4); // from the seed
    const draft = await createDraft();
    const sent = await finalize(draft.id, '2025-12-31');
    expect(sent.number).toBe(`INV-2025-${String(before2025 + 1).padStart(4, '0')}`);
    expect(sent.due_date).toBe('2026-01-14');
  });

  it('finalizing a non-draft is a 409', async () => {
    const draft = await createDraft();
    await finalize(draft.id);
    const again = await request(app).post(`/api/invoices/${draft.id}/finalize`).set('Cookie', cookie).send({});
    expect(again.status).toBe(409);
  });
});

describe('sent invoices are immutable', () => {
  it('editing a sent invoice → 409; drafts stay editable', async () => {
    const draft = await createDraft();
    const edit = await request(app)
      .put(`/api/invoices/${draft.id}`)
      .set('Cookie', cookie)
      .send({
        customer_id: 2,
        payment_terms_days: 30,
        lines: [{ description: 'Edited line', quantity: 2, unit_price_cents: 5_000, vat_rate: 10 }],
      });
    expect(edit.status).toBe(200);
    expect(edit.body.customer_id).toBe(2);
    expect(edit.body.lines[0].description).toBe('Edited line');

    await finalize(draft.id);
    const after = await request(app)
      .put(`/api/invoices/${draft.id}`)
      .set('Cookie', cookie)
      .send({
        customer_id: 2,
        payment_terms_days: 30,
        lines: [{ description: 'Sneaky edit', quantity: 1, unit_price_cents: 1, vat_rate: 0 }],
      });
    expect(after.status).toBe(409);
    expect(after.body.error).toContain('immutable');

    // The lines are untouched.
    const unchanged = await detail(draft.id);
    expect(unchanged.lines[0]!.description).toBe('Edited line');
  });

  it('deleting a sent invoice → 409 (only drafts may be deleted)', async () => {
    const draft = await createDraft();
    const sent = await finalize(draft.id);
    const del = await request(app).delete(`/api/invoices/${draft.id}`).set('Cookie', cookie);
    expect(del.status).toBe(409);
    expect((await detail(draft.id)).number).toBe(sent.number);
  });
});

describe('payments and derived payment status', () => {
  async function sentInvoice(): Promise<InvoiceDetail> {
    const draft = await createDraft(); // gross 12000 (10000 + 20% VAT)
    return finalize(draft.id);
  }

  it('unpaid → partially_paid → paid, with "paid" also reflected in the lifecycle status', async () => {
    const invoice = await sentInvoice();
    expect(invoice.payment_status).toBe('unpaid');
    expect(invoice.gross_cents).toBe(12_000);

    const partial = await request(app)
      .post(`/api/invoices/${invoice.id}/payments`)
      .set('Cookie', cookie)
      .send({ amount_cents: 5_000, note: 'first instalment' });
    expect(partial.status).toBe(201);
    expect(partial.body.payment_status).toBe('partially_paid');
    expect(partial.body.status).toBe('sent');
    expect(partial.body.paid_cents).toBe(5_000);
    expect(partial.body.open_cents).toBe(7_000);

    const rest = await request(app)
      .post(`/api/invoices/${invoice.id}/payments`)
      .set('Cookie', cookie)
      .send({ amount_cents: 7_000 });
    expect(rest.status).toBe(201);
    expect(rest.body.payment_status).toBe('paid');
    expect(rest.body.status).toBe('paid'); // derived, never stored
    expect(rest.body.open_cents).toBe(0);
    expect(db.prepare('SELECT status FROM invoices WHERE id = ?').get(invoice.id)).toEqual({
      status: 'sent', // storage never holds "paid"
    });
  });

  it('overpayment → 422 and no payment row is written', async () => {
    const invoice = await sentInvoice();
    const count = (db.prepare('SELECT COUNT(*) AS c FROM payments').get() as { c: number }).c;
    const res = await request(app)
      .post(`/api/invoices/${invoice.id}/payments`)
      .set('Cookie', cookie)
      .send({ amount_cents: invoice.gross_cents + 1 });
    expect(res.status).toBe(422);
    expect(res.body.details[0].message).toContain('exceeds the open amount');
    expect((db.prepare('SELECT COUNT(*) AS c FROM payments').get() as { c: number }).c).toBe(count);
  });

  it('overpaying across several payments is also rejected', async () => {
    const invoice = await sentInvoice();
    await request(app)
      .post(`/api/invoices/${invoice.id}/payments`)
      .set('Cookie', cookie)
      .send({ amount_cents: 11_999 });
    const res = await request(app)
      .post(`/api/invoices/${invoice.id}/payments`)
      .set('Cookie', cookie)
      .send({ amount_cents: 2 });
    expect(res.status).toBe(422);
  });

  it('payments against drafts and cancelled invoices → 409', async () => {
    const draft = await createDraft();
    const onDraft = await request(app)
      .post(`/api/invoices/${draft.id}/payments`)
      .set('Cookie', cookie)
      .send({ amount_cents: 100 });
    expect(onDraft.status).toBe(409);

    await finalize(draft.id);
    await request(app)
      .post(`/api/invoices/${draft.id}/cancel`)
      .set('Cookie', cookie)
      .send({ reason: 'test cancellation' });
    const onCancelled = await request(app)
      .post(`/api/invoices/${draft.id}/payments`)
      .set('Cookie', cookie)
      .send({ amount_cents: 100 });
    expect(onCancelled.status).toBe(409);
  });

  it('validates the payment payload', async () => {
    const invoice = await sentInvoice();
    const res = await request(app)
      .post(`/api/invoices/${invoice.id}/payments`)
      .set('Cookie', cookie)
      .send({ amount_cents: 10.5, date: 'not-a-date' });
    expect(res.status).toBe(422);
    const fields = res.body.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['amount_cents', 'date']));
  });
});

describe('cancellation keeps the number', () => {
  it('cancels a sent invoice, keeps its number, and blocks further changes', async () => {
    const draft = await createDraft();
    const sent = await finalize(draft.id);
    const res = await request(app)
      .post(`/api/invoices/${draft.id}/cancel`)
      .set('Cookie', cookie)
      .send({ reason: 'Wrong customer billed' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.number).toBe(sent.number); // the number survives
    expect(res.body.cancellation_reason).toBe('Wrong customer billed');

    const del = await request(app).delete(`/api/invoices/${draft.id}`).set('Cookie', cookie);
    expect(del.status).toBe(409);
    const again = await request(app)
      .post(`/api/invoices/${draft.id}/cancel`)
      .set('Cookie', cookie)
      .send({ reason: 'twice' });
    expect(again.status).toBe(409);
  });

  it('drafts cannot be cancelled (delete them instead) and a reason is required', async () => {
    const draft = await createDraft();
    const res = await request(app)
      .post(`/api/invoices/${draft.id}/cancel`)
      .set('Cookie', cookie)
      .send({ reason: 'nope' });
    expect(res.status).toBe(409);

    await finalize(draft.id);
    const noReason = await request(app)
      .post(`/api/invoices/${draft.id}/cancel`)
      .set('Cookie', cookie)
      .send({});
    expect(noReason.status).toBe(422);
  });

  it('the seeded cancelled invoices still hold their numbers', async () => {
    const rows = await listInvoices('?status=cancelled');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) expect(row.number).toMatch(/^INV-\d{4}-\d{4}$/);
  });
});

describe('overdue is derived from the due date, never stored', () => {
  it('a sent invoice due in the past is overdue; a fresh one is not', async () => {
    const today = todayIso();
    const oldDraft = await createDraft();
    const overdue = await finalize(oldDraft.id, addDays(today, -30)); // terms 14 → due 16 days ago
    expect(overdue.overdue).toBe(true);

    const freshDraft = await createDraft();
    const fresh = await finalize(freshDraft.id, today); // due in 14 days
    expect(fresh.overdue).toBe(false);

    // No "overdue" column exists to drift.
    const columns = db.prepare("SELECT name FROM pragma_table_info('invoices')").all() as { name: string }[];
    expect(columns.map((c) => c.name)).not.toContain('overdue');
  });

  it('paying an overdue invoice clears the overdue flag (paid invoices are not overdue)', async () => {
    const draft = await createDraft();
    const sent = await finalize(draft.id, addDays(todayIso(), -60));
    expect(sent.overdue).toBe(true);
    const paid = await request(app)
      .post(`/api/invoices/${draft.id}/payments`)
      .set('Cookie', cookie)
      .send({ amount_cents: sent.gross_cents });
    expect(paid.body.status).toBe('paid');
    expect(paid.body.overdue).toBe(false);
  });

  it('?overdue=1 returns exactly the overdue rows', async () => {
    const rows = await listInvoices('?overdue=1');
    expect(rows.length).toBeGreaterThanOrEqual(2); // seed has overdue invoices
    for (const row of rows) {
      expect(row.status).toBe('sent');
      expect(row.due_date! < todayIso()).toBe(true);
    }
    const all = await listInvoices();
    expect(all.filter((r) => r.overdue).length).toBe(rows.length);
  });
});

describe('customer ledger', () => {
  it('runs chronologically and the running balance ends at invoiced − paid', async () => {
    const res = await request(app).get('/api/customers/1/ledger').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const ledger = res.body as Ledger;
    expect(ledger.entries.length).toBeGreaterThanOrEqual(5);

    // Chronological order.
    const dates = ledger.entries.map((e) => e.date);
    expect([...dates].sort()).toEqual(dates);

    // Running balance is the prefix sum of signed amounts…
    let balance = 0;
    for (const entry of ledger.entries) {
      balance += entry.amount_cents;
      expect(entry.balance_cents).toBe(balance);
    }

    // …and the final balance equals total invoiced minus total paid.
    expect(balance).toBe(ledger.invoiced_cents - ledger.paid_cents);
    expect(ledger.balance_cents).toBe(ledger.invoiced_cents - ledger.paid_cents);

    // Cross-check the totals against the database directly.
    const paid = db
      .prepare(
        `SELECT COALESCE(SUM(p.amount_cents), 0) AS paid FROM payments p
         JOIN invoices i ON i.id = p.invoice_id WHERE i.customer_id = 1`,
      )
      .get() as { paid: number };
    expect(ledger.paid_cents).toBe(paid.paid);
  });

  it('cancelled invoices appear as a debit + matching credit and do not count as invoiced', async () => {
    const res = await request(app).get('/api/customers/3/ledger').set('Cookie', cookie);
    const ledger = res.body as Ledger;
    const cancellation = ledger.entries.find((e) => e.type === 'cancellation');
    expect(cancellation).toBeDefined();
    const issued = ledger.entries.find(
      (e) => e.type === 'invoice' && e.invoice_id === cancellation!.invoice_id,
    );
    expect(issued!.amount_cents).toBe(-cancellation!.amount_cents);
  });

  it('drafts never appear on a statement', async () => {
    const res = await request(app).get('/api/customers/2/ledger').set('Cookie', cookie);
    const ledger = res.body as Ledger;
    const draftIds = (
      db.prepare("SELECT id FROM invoices WHERE status = 'draft'").all() as { id: number }[]
    ).map((r) => r.id);
    for (const entry of ledger.entries) expect(draftIds).not.toContain(entry.invoice_id);
  });
});

describe('customers CRUD', () => {
  it('round-trips a customer', async () => {
    const created = await request(app)
      .post('/api/customers')
      .set('Cookie', cookie)
      .send({ name: 'Testkunde GmbH', email: 'test@example.at', vat_id: 'ATU99999999', address: 'Teststraße 1\n1010 Wien' });
    expect(created.status).toBe(201);
    const id = created.body.id as number;

    const updated = await request(app)
      .put(`/api/customers/${id}`)
      .set('Cookie', cookie)
      .send({ name: 'Testkunde & Co KG', email: null, vat_id: null, address: null });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('Testkunde & Co KG');
    expect(updated.body.email).toBeNull();

    const deleted = await request(app).delete(`/api/customers/${id}`).set('Cookie', cookie);
    expect(deleted.status).toBe(200);
    const gone = await request(app).get(`/api/customers/${id}`).set('Cookie', cookie);
    expect(gone.status).toBe(404);
  });

  it('validates name and email', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('Cookie', cookie)
      .send({ name: '', email: 'not-an-email' });
    expect(res.status).toBe(422);
    const fields = res.body.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['name', 'email']));
  });

  it('refuses to delete a customer with invoices (409)', async () => {
    const res = await request(app).delete('/api/customers/1').set('Cookie', cookie);
    expect(res.status).toBe(409);
  });
});

describe('invoice list filters', () => {
  it('filters by search on number and customer name', async () => {
    const byNumber = await listInvoices('?search=INV-2025-0001');
    expect(byNumber.length).toBe(1);
    expect(byNumber[0]!.number).toBe('INV-2025-0001');

    const byCustomer = await listInvoices('?search=Donaufracht');
    expect(byCustomer.length).toBeGreaterThanOrEqual(2);
    for (const row of byCustomer) expect(row.customer_name).toContain('Donaufracht');
  });

  it('filters by derived status', async () => {
    for (const status of ['draft', 'sent', 'paid', 'cancelled'] as const) {
      const rows = await listInvoices(`?status=${status}`);
      expect(rows.length, status).toBeGreaterThanOrEqual(1);
      for (const row of rows) expect(row.status).toBe(status);
    }
    const bad = await request(app).get('/api/invoices?status=bogus').set('Cookie', cookie);
    expect(bad.status).toBe(422);
  });
});

describe('PDF export', () => {
  const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };

  async function fetchPdf(id: number): Promise<{ status: number; type: string; body: Buffer }> {
    const res = await request(app)
      .get(`/api/invoices/${id}/pdf`)
      .set('Cookie', cookie)
      .buffer(true)
      .parse(binary);
    return { status: res.status, type: res.headers['content-type'] ?? '', body: res.body as Buffer };
  }

  it('returns a valid, nontrivial PDF for a sent invoice', async () => {
    const rows = await listInvoices('?status=sent');
    const { status, type, body } = await fetchPdf(rows[0]!.id);
    expect(status).toBe(200);
    expect(type).toContain('application/pdf');
    expect(body.length).toBeGreaterThan(1_500);
    expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(body.toString('latin1')).toContain('%%EOF');
    // Content streams are uncompressed → the invoice number is visible.
    expect(body.toString('latin1')).toContain(rows[0]!.number!);
  });

  it('renders drafts with a DRAFT watermark line and cancelled invoices with their kept number', async () => {
    const drafts = await listInvoices('?status=draft');
    const draftPdf = await fetchPdf(drafts[0]!.id);
    expect(draftPdf.status).toBe(200);
    expect(draftPdf.body.toString('latin1')).toContain('NOT A VALID INVOICE');

    const cancelled = await listInvoices('?status=cancelled');
    const cancelledPdf = await fetchPdf(cancelled[0]!.id);
    expect(cancelledPdf.body.toString('latin1')).toContain('CANCELLED');
    expect(cancelledPdf.body.toString('latin1')).toContain(cancelled[0]!.number!);
  });

  it('is 404 for a missing invoice and 401 without a session', async () => {
    const missing = await request(app).get('/api/invoices/99999/pdf').set('Cookie', cookie);
    expect(missing.status).toBe(404);
    const unauth = await request(app).get('/api/invoices/1/pdf');
    expect(unauth.status).toBe(401);
  });
});
