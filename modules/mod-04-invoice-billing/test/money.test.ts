import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import { issueCreditNote } from '../server/credit-notes.js';
import { createDraft, finalizeInvoice, invoiceDetail, DomainError } from '../server/invoices.js';
import { importTransfer } from '../server/transfer-import.js';
import { renderCii } from '../shared/einvoice.js';
import { fitsQuantityDecimals, lineNetCents } from '../shared/money.js';
import { TRANSFER_VERSION, transferLineNet, transferTotals, type DocumentTransfer, type TransferLine } from '../shared/transfer.js';
import { BASE } from './einvoice-cases.js';

/**
 * Line amounts are rounded decimally — review finding M3 in
 * docs/E-RECHNUNG-REVIEW.md. Binary floating point rounded about one decimal
 * quantity in a thousand a cent low (0.29 × 0.50 € → 0.14 €; 159 of the
 * 160,000 cases below), and the XML stated a
 * line amount the recipient could not recompute. Held to an independent
 * computation, not to the formula under test: the quantity's decimal digits,
 * as an e-invoice writes them, multiplied in BigInt.
 */
function exact(quantity: string, priceCents: number): number {
  const [whole, fraction = ''] = quantity.split('.');
  expect(fraction.length).toBeLessThanOrEqual(4);
  const tenThousandths = BigInt(whole! + fraction.padEnd(4, '0'));
  return Number((tenThousandths * BigInt(priceCents) + 5_000n) / 10_000n);
}

const PRICES = [1, 5, 10, 33, 50, 99, 100, 150, 199, 250, 499, 999, 1_999, 4_999, 9_999, 99_999];
const line = (quantity: number, unit_price_cents: number) => ({ quantity, unit_price_cents, vat_rate: 19 });

describe('decimal line rounding', () => {
  it('rounds half up on the stated quantity, for every quantity from 0.001 to 10 at sixteen prices', () => {
    let floatOff = 0;
    for (let k = 1; k <= 10_000; k++) {
      const quantity = k / 1000;
      for (const price of PRICES) {
        const expected = exact(String(quantity), price);
        expect(lineNetCents(line(quantity, price), 'decimal')).toBe(expected);
        if (lineNetCents(line(quantity, price), 'float') !== expected) floatOff++;
      }
    }
    // The defect it replaces, and why issued invoices keep their own rule.
    expect(floatOff).toBeGreaterThan(0);
    expect(lineNetCents(line(0.29, 50), 'float')).toBe(14);
    expect(lineNetCents(line(0.29, 50), 'decimal')).toBe(15);
  });

  it('stays exact at the limits the API allows', () => {
    expect(lineNetCents(line(1_000_000, 100_000_000), 'decimal')).toBe(100_000_000_000_000);
    expect(lineNetCents(line(999_999.9999, 99_999_999), 'decimal')).toBe(exact('999999.9999', 99_999_999));
    expect(lineNetCents(line(0.0001, 5_000), 'decimal')).toBe(1); // half a cent, up
    expect(lineNetCents(line(0.0001, 4_999), 'decimal')).toBe(0);
  });

  it('takes four decimals and no fifth, binary noise aside', () => {
    expect(fitsQuantityDecimals(0.1 + 0.2)).toBe(true);
    expect(fitsQuantityDecimals(1.0001)).toBe(true);
    expect(fitsQuantityDecimals(0.33333)).toBe(false);
    expect(fitsQuantityDecimals(1 / 3)).toBe(false);
  });

  it('is what the XML states and what its quantity recomputes to', () => {
    const model = { ...BASE, lines: [{ position: 1, description: 'Kabel', quantity: 0.29, unit_price_cents: 50, vat_rate: 0 }] };
    const xml = renderCii(model, 'zugferd');
    expect(xml).toContain('<ram:BilledQuantity unitCode="C62">0.29</ram:BilledQuantity>');
    expect(xml).toContain('<ram:LineTotalAmount>0.15</ram:LineTotalAmount>');
  });
});

// ── Through the module ───────────────────────────────────────────────────

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 's'.repeat(32), ttlHours: 1, secureCookie: false };
const seller: SellerConfig = {
  name: 'Beispiel GmbH', addressLines: ['Hauptstraße 1', '80331 München'], vatId: 'DE123456789', iban: 'DE02120300000000202051', bic: '',
};

let db: Database.Database;
let app: Express;
let cookie: string;

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, auth, seller });
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'pw' });
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
});

const customerId = (database: Database.Database): number =>
  Number(database.prepare("INSERT INTO customers (name, created_at) VALUES ('Kunde AG', '2026-10-01T00:00:00Z')").run().lastInsertRowid);
const cable = { description: 'Kabel', quantity: 0.29, unitPriceCents: 50, vatRate: 19 };
const reportLine = (database: Database.Database, number: string) =>
  (database.prepare('SELECT line_net_cents FROM report_invoice_lines WHERE invoice_number = ?').get(number) as { line_net_cents: number })
    .line_net_cents;

describe('quantities are limited to four decimals', () => {
  it('refuses a fifth at the API and keeps 0.1 + 0.2 as 0.3', async () => {
    const c = customerId(db);
    const bad = await request(app).post('/api/invoices').set('Cookie', cookie)
      .send({ customer_id: c, lines: [{ description: 'x', quantity: 0.33333, unit_price_cents: 99_999, vat_rate: 19 }] });
    expect(bad.status).toBe(422);
    expect(bad.body.details).toEqual([{ field: 'lines[0].quantity', message: 'Quantity has at most 4 decimal places' }]);
    const ok = await request(app).post('/api/invoices').set('Cookie', cookie)
      .send({ customer_id: c, lines: [{ description: 'x', quantity: 0.1 + 0.2, unit_price_cents: 100, vat_rate: 19 }] });
    expect(ok.status).toBe(201);
    expect(ok.body.lines[0].quantity).toBe(0.3);
  });

  it('refuses to issue a draft saved with more, before a number is drawn', () => {
    const id = createDraft(db, { customerId: customerId(db), paymentTermsDays: 14, note: null, lines: [{ ...cable, quantity: 0.33333 }] });
    expect(() => finalizeInvoice(db, id, '2026-10-21')).toThrow(DomainError);
    try {
      finalizeInvoice(db, id, '2026-10-21');
    } catch (err) {
      expect((err as DomainError).details.map((d) => d.field)).toEqual(['lines[0].quantity']);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM invoice_counters').get()).toEqual({ n: 0 });
    expect(invoiceDetail(db, id).status).toBe('draft');
  });
});

describe('an invoice keeps the rounding it was issued with', () => {
  it('stamps the decimal rule at finalize: detail, report view and e-invoice agree', async () => {
    const id = createDraft(db, { customerId: customerId(db), paymentTermsDays: 14, note: null, lines: [cable] });
    expect(invoiceDetail(db, id).line_rounding).toBe('decimal');
    const { number } = finalizeInvoice(db, id, '2026-10-21');
    const detail = invoiceDetail(db, id);
    expect(detail.line_rounding).toBe('decimal');
    expect(detail.lines[0]!.net_cents).toBe(15);
    expect(reportLine(db, number)).toBe(15);
  });

  it('marks invoices issued before the upgrade float, so their amounts stay as sent, paid and booked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mod04-rounding-'));
    try {
      const file = join(dir, 'invoices.db');
      let database = openDb(file);
      const customer = customerId(database);
      const issued = createDraft(database, { customerId: customer, paymentTermsDays: 14, note: null, lines: [cable] });
      const { number } = finalizeInvoice(database, issued, '2026-10-21');
      const draft = createDraft(database, { customerId: customer, paymentTermsDays: 14, note: null, lines: [cable] });
      database.close();

      // The database as the previous release left it: no rounding column.
      const raw = new Database(file);
      for (const view of ['report_receivables_aging', 'report_payments', 'report_invoice_lines', 'report_invoices', 'report_credit_notes']) {
        raw.exec(`DROP VIEW ${view}`);
      }
      raw.exec('ALTER TABLE invoices DROP COLUMN line_rounding');
      raw.close();

      database = openDb(file);
      // 0.29 × 0.50 € was 0.14 € on the invoice that went out, and stays it.
      expect(invoiceDetail(database, issued).line_rounding).toBe('float');
      expect(invoiceDetail(database, issued).net_cents).toBe(14);
      expect(reportLine(database, number)).toBe(14);
      // A draft was never sent: it is computed, and will be issued, exactly.
      expect(invoiceDetail(database, draft).line_rounding).toBe('decimal');
      expect(invoiceDetail(database, draft).net_cents).toBe(15);

      // A credit note of the old invoice is rounded as the invoice was: crediting
      // the line returns exactly what was charged, not a cent more.
      const note = issueCreditNote(
        database,
        issued,
        { reason: 'Retoure', issueDate: '2026-10-22', lines: [{ description: 'Kabel', quantity: 0.29, unitPriceCents: 50, vatRate: 19 }] },
        'admin',
        '2026-10-22',
      );
      expect(note.net_cents).toBe(14);
      expect(invoiceDetail(database, issued).creditable).toEqual([{ rate: 19, base_cents: 0, vat_cents: 0 }]);
      database.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('an imported document stays cent-exact', () => {
  it('folds a line the source rounded differently into one at the source net', () => {
    const lines: TransferLine[] = [
      { description: 'Kabel', quantity: 0.29, unit_price_cents: 50, discount_percent: 0, vat_rate: 20, net_cents: transferLineNet({ quantity: 0.29, unit_price_cents: 50 }) },
      { description: 'Montage', quantity: 2, unit_price_cents: 9_000, discount_percent: 0, vat_rate: 20, net_cents: 18_000 },
    ];
    const transfer: DocumentTransfer = {
      transfer_version: TRANSFER_VERSION,
      origin: { kind: 'offer', module: 'mod-13-offers', reference: 'AN-2026-0042', issued_at: '2026-10-01', accepted_at: '2026-10-02T10:00:00Z' },
      currency: 'EUR',
      customer: { name: 'Kunde AG', contact_person: null, email: 'ap@kunde.at', vat_id: null, address_lines: ['Ring 5', '1010 Wien'], party_id: null, source: 'mod-13-offers', external_id: '1' },
      lines,
      totals: transferTotals(lines),
      note: null,
    };
    const { invoiceId } = importTransfer(db, transfer);
    const detail = invoiceDetail(db, invoiceId);
    expect(detail.lines.map((l) => [l.description, l.quantity, l.unit_price_cents])).toEqual([
      ['Kabel (0.29 × 0,50 €)', 1, 14],
      ['Montage', 2, 9_000],
    ]);
    expect(detail.gross_cents).toBe(transfer.totals.gross_cents);
  });
});
