import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { bookingsFor } from '../server/accounting-export.js';
import { businessDate, businessDaySql, DEFAULT_BUSINESS_TIMEZONE, setBusinessTimeZone, utcOffsetMinutes } from '../server/business-date.js';
import { configFromEnv, type SellerConfig } from '../server/config.js';
import { openDb } from '../server/db.js';
import { eInvoiceModel } from '../server/einvoice-data.js';
import { cancelInvoice, createDraft, customerLedger, finalizeInvoice, invoiceDetail, todayIso } from '../server/invoices.js';

/**
 * Business dates are days in the business time zone, not in UTC — review
 * finding N1 in docs/E-RECHNUNG-REVIEW.md: until 01:00 (CET) or 02:00 (CEST)
 * UTC still has yesterday, so an invoice issued or cancelled at 00:30 was
 * dated the day before, and on New Year's night numbered in the old year.
 */

afterEach(() => {
  vi.useRealTimers();
  setBusinessTimeZone(DEFAULT_BUSINESS_TIMEZONE);
});

/** The clock stands at `iso`. Only Date is faked: nothing else waits on a timer. */
const clockAt = (iso: string): void => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};

describe('the business date', () => {
  it('is the day in Berlin, not in UTC, after midnight in summer and in winter', () => {
    expect(businessDate(new Date('2026-10-24T22:30:00Z'))).toBe('2026-10-25'); // 00:30 CEST
    expect(businessDate(new Date('2026-10-24T21:59:59Z'))).toBe('2026-10-24');
    expect(businessDate(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01'); // 00:30 CET
    expect(businessDate(new Date('2026-12-31T22:59:59Z'))).toBe('2026-12-31');
    expect(businessDate(new Date('2026-12-31T23:30:00Z'), 'UTC')).toBe('2026-12-31');
  });

  it('knows the offsets of the zone, to the second of the clock change', () => {
    expect(utcOffsetMinutes('Europe/Berlin', new Date('2026-03-29T00:59:59Z'))).toBe(60);
    expect(utcOffsetMinutes('Europe/Berlin', new Date('2026-03-29T01:00:00Z'))).toBe(120);
    expect(utcOffsetMinutes('Europe/Vienna', new Date('2026-10-25T00:59:59Z'))).toBe(120);
    expect(utcOffsetMinutes('Europe/Vienna', new Date('2026-10-25T01:00:00Z'))).toBe(60);
    expect(utcOffsetMinutes('America/St_Johns', new Date('2026-01-15T12:00:00Z'))).toBe(-210);
  });

  it('comes from BUSINESS_TIMEZONE, Europe/Berlin when unset, and a zone Intl does not know stops the start', () => {
    expect(configFromEnv({}).businessTimeZone).toBe('Europe/Berlin');
    expect(configFromEnv({ BUSINESS_TIMEZONE: ' Europe/Vienna ' }).businessTimeZone).toBe('Europe/Vienna');
    expect(() => configFromEnv({ BUSINESS_TIMEZONE: 'Europe/Berlinn' })).toThrow(
      'BUSINESS_TIMEZONE: "Europe/Berlinn" is not an IANA time zone such as Europe/Berlin or Europe/Vienna',
    );
    expect(() => setBusinessTimeZone('Mars/Olympus_Mons')).toThrow(/^BUSINESS_TIMEZONE: /);
  });
});

describe('the report views count in the same zone', () => {
  // Days with a clock change in 2026: Europe in March and October; Chile and
  // Cuba change at local midnight, where a wrong boundary moves the date;
  // Lord Howe by half an hour. Kolkata and UTC never change.
  const days = ['2026-03-07', '2026-03-08', '2026-03-28', '2026-03-29', '2026-04-04', '2026-04-05', '2026-09-05', '2026-09-06',
    '2026-10-03', '2026-10-04', '2026-10-24', '2026-10-25', '2026-10-31', '2026-11-01', '2026-12-31'];
  const zones = ['Europe/Berlin', 'Europe/Vienna', 'America/Santiago', 'America/Havana', 'Australia/Lord_Howe', 'Asia/Kolkata', 'UTC'];

  it('as businessDate does, every five minutes and a second before, across the clock changes', () => {
    const db = new Database(':memory:');
    const instants: Date[] = [];
    for (const day of days) {
      for (let t = Date.parse(`${day}T00:00:00Z`); t < Date.parse(`${day}T00:00:00Z`) + 86_400_000; t += 300_000) {
        instants.push(new Date(t), new Date(t - 1000));
      }
    }
    for (const zone of zones) {
      const query = db.prepare(`SELECT ${businessDaySql('@now', zone, 2026)} AS day`);
      for (const instant of instants) {
        const now = instant.toISOString().replace('T', ' ').slice(0, 19);
        expect((query.get({ now }) as { day: string }).day, `${zone} at ${now} UTC`).toBe(businessDate(instant, zone));
      }
    }
    db.close();
  });

  it('read the zone they were built with', () => {
    expect(businessDaySql("'now'", 'UTC', 2026)).toBe("date('now')");
    expect(businessDaySql("'now'", 'Asia/Kolkata', 2026)).toBe("date('now', '+330 minutes')");
    expect(businessDaySql("'now'", 'Europe/Berlin', 2026)).toContain("WHEN CAST(strftime('%s', 'now') AS INTEGER) < 1774746000 THEN '+60 minutes'");
  });
});

describe('a document dated at night', () => {
  const lines = [{ description: 'Beratung', quantity: 1, unitPriceCents: 10_000, vatRate: 19 }];
  const seller: SellerConfig = {
    name: 'Beispiel GmbH',
    addressLines: ['Hauptstraße 1', '80331 München', 'Deutschland'],
    vatId: 'DE123456789',
    iban: 'DE02 1203 0000 0000 2020 51',
    bic: 'BYLADEM1001',
  };
  const draftIn = (db: Database.Database): number => {
    const customerId = Number(db.prepare("INSERT INTO customers (name, address, created_at) VALUES ('Kunde AG', 'Kundenweg 5\n10115 Berlin', '2026-01-01T00:00:00Z')").run().lastInsertRowid);
    return createDraft(db, { customerId, paymentTermsDays: 14, note: null, lines });
  };

  it('issued at 00:30 on New Year’s Day belongs to the new year, its number included', () => {
    const db = openDb(':memory:');
    const draft = draftIn(db);
    clockAt('2026-12-31T23:30:00Z');
    expect(todayIso()).toBe('2027-01-01');
    // The screen sends no date: finalizing takes today's.
    expect(finalizeInvoice(db, draft).number).toBe('INV-2027-0001');
    expect(invoiceDetail(db, draft)).toMatchObject({ issue_date: '2027-01-01', due_date: '2027-01-15' });
  });

  it('cancelled at 00:30 is cancelled that day: the cancellation document, the ledger and the export say so', () => {
    const db = openDb(':memory:');
    const id = draftIn(db);
    finalizeInvoice(db, id, '2026-10-20');
    cancelInvoice(db, id, 'doppelt', '2026-10-24T22:30:00Z');
    const detail = invoiceDetail(db, id);
    expect(detail).toMatchObject({ cancelled_at: '2026-10-24T22:30:00Z', cancelled_on: '2026-10-25' });
    expect(eInvoiceModel(db, id, seller, 'cancellation').issue_date).toBe('2026-10-25');
    expect(customerLedger(db, detail.customer_id).entries.find((e) => e.type === 'cancellation')?.date).toBe('2026-10-25');
    expect(bookingsFor(db, { from: '2026-10-25', to: '2026-10-25' }).map((b) => [b.kind, b.date])).toEqual([['cancellation', '2026-10-25']]);
    expect(bookingsFor(db, { from: '2026-10-24', to: '2026-10-24' })).toEqual([]);
    expect((db.prepare('SELECT cancelled_on FROM report_invoices').get() as { cancelled_on: string }).cancelled_on).toBe('2026-10-25');
  });

  it('keeps the UTC day on cancellations from before the column, the day they have always shown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mod04-cancelled-on-'));
    try {
      const file = join(dir, 'invoices.db');
      let db = openDb(file);
      const id = draftIn(db);
      finalizeInvoice(db, id, '2026-10-20');
      cancelInvoice(db, id, 'doppelt', '2026-10-24T22:30:00Z');
      db.close();

      // The database as the previous release left it: no cancelled_on.
      const raw = new Database(file);
      for (const view of ['report_receivables_aging', 'report_payments', 'report_invoice_lines', 'report_invoices', 'report_credit_notes']) {
        raw.exec(`DROP VIEW ${view}`);
      }
      raw.exec('ALTER TABLE invoices DROP COLUMN cancelled_on');
      raw.close();

      db = openDb(file);
      expect(invoiceDetail(db, id).cancelled_on).toBe('2026-10-24');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
