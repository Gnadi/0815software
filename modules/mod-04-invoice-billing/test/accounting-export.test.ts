import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { cancelInvoice, createDraft, finalizeInvoice, recordPayment } from '../server/invoices.js';
import {
  bmdDocumentNumber,
  bmdExport,
  datevExport,
  defaultSettings,
  fiscalYear,
  readSettings,
  writeSettings,
} from '../server/accounting-export.js';
import { BUCHUNGSSTAPEL_COLUMNS } from '../shared/datev-columns.js';

/**
 * The DATEV and BMD exports.
 *
 * The DATEV golden file (test/fixtures/datev/) was checked outside this
 * repository with an independent EXTF validator (@seamless-engineering/
 * datev-extf 0.1.0, whose column list and rules are taken from DATEV's own
 * sample files) and came back with no findings. The test pins it byte for
 * byte, so a change to the writer must be re-checked before the file is
 * regenerated.
 */

let db: Database.Database;

/** Decode Windows-1252 the way DATEV does (Node's TextDecoder treats it as Latin-1 before v22). */
function cp1252Text(buffer: Buffer): string {
  return new TextDecoder('windows-1252').decode(buffer);
}

function scenario(): void {
  db = openDb(':memory:');
  const c1 = Number(
    db.prepare("INSERT INTO customers (name, vat_id, created_at) VALUES ('Müller & Söhne \"KG\"', 'DE987654321', 'x')").run()
      .lastInsertRowid,
  );
  const c2 = Number(
    db.prepare("INSERT INTO customers (name, vat_id, created_at) VALUES ('=Wien GmbH', 'ATU12345678', 'x')").run().lastInsertRowid,
  );
  const a = createDraft(db, {
    customerId: c1,
    paymentTermsDays: 14,
    note: null,
    deliveryDate: '2026-03-10',
    lines: [
      { description: 'x', quantity: 3, unitPriceCents: 33, vatRate: 19 },
      { description: 'y', quantity: 2, unitPriceCents: 1999, vatRate: 7 },
    ],
  });
  finalizeInvoice(db, a, '2026-03-15');
  const b = createDraft(db, {
    customerId: c2,
    paymentTermsDays: 30,
    note: null,
    taxExemptionCategory: 'AE',
    lines: [{ description: 'z', quantity: 1, unitPriceCents: 50000, vatRate: 0 }],
  });
  finalizeInvoice(db, b, '2026-03-20');
  cancelInvoice(db, b, 'falsch', '2026-03-25T10:00:00Z');
  recordPayment(db, a, { date: '2026-03-28', amountCents: 1000, note: null });
  // A draft and an invoice outside the period must not appear.
  createDraft(db, { customerId: c1, paymentTermsDays: 14, note: null, lines: [{ description: 'd', quantity: 1, unitPriceCents: 1, vatRate: 19 }] });
  const april = createDraft(db, { customerId: c1, paymentTermsDays: 14, note: null, lines: [{ description: 'q', quantity: 1, unitPriceCents: 5, vatRate: 19 }] });
  finalizeInvoice(db, april, '2026-04-02');
}

function configureDatev(overrides: Record<string, unknown> = {}): void {
  const s = defaultSettings();
  writeSettings(db, { ...s, datev: { ...s.datev, consultant_number: 1234567, client_number: 12345, bank_account: 1200, ...overrides } });
}

const MARCH = { from: '2026-03-01', to: '2026-03-31' };
const NOW = new Date('2026-04-02T08:09:10.123Z');

describe('DATEV Buchungsstapel', () => {
  beforeEach(scenario);

  it('reproduces the externally validated golden file byte for byte', () => {
    configureDatev();
    const file = datevExport(db, MARCH, { payments: true, now: NOW });
    expect(file.bookings).toBe(5);
    expect(file.filename).toBe('EXTF_Buchungsstapel_20260301_20260331.csv');
    expect(Buffer.compare(file.content, readFileSync(join(import.meta.dirname, 'fixtures', 'datev', 'march-2026.csv')))).toBe(0);
  });

  it('has the EXTF header, the 125 DATEV columns, Windows-1252 and CRLF', () => {
    configureDatev();
    const { content } = datevExport(db, MARCH, { now: NOW });
    expect(content.includes(Buffer.from('ü', 'utf8'))).toBe(false);
    expect(content.includes(Buffer.from([0xfc]))).toBe(true); // ü in Windows-1252
    const lines = cp1252Text(content).split('\r\n');
    expect(lines.at(-1)).toBe('');
    const header = lines[0]!.split(';');
    expect(header).toHaveLength(31);
    expect(header.slice(0, 6)).toEqual(['"EXTF"', '700', '21', '"Buchungsstapel"', '13', '20260402080910123']);
    expect(header.slice(10, 16)).toEqual(['1234567', '12345', '20260101', '4', '20260301', '20260331']);
    expect(header[26]).toBe('"03"');
    expect(lines[1]!.split(';')).toEqual([...BUCHUNGSSTAPEL_COLUMNS]);
    for (const row of lines.slice(2, -1)) expect(row.split(';')).toHaveLength(125);
  });

  it('books each VAT rate gross on its automatic account, and the cancellation as the reverse side', () => {
    configureDatev();
    const rows = cp1252Text(datevExport(db, MARCH, { now: NOW }).content)
      .split('\r\n')
      .slice(2, -1)
      .map((r) => r.split(';'));
    const pick = (r: string[]): string[] => [r[0]!, r[1]!, r[6]!, r[7]!, r[9]!, r[10]!];
    expect(rows.map(pick)).toEqual([
      // 2 × 19.99 at 7 % → 39.98 + 2.80 VAT
      ['42,78', '"S"', '10001', '8300', '1503', '"INV-2026-0001"'],
      // 3 × 0.33 at 19 % → 0.99 + 0.19 VAT
      ['1,18', '"S"', '10001', '8400', '1503', '"INV-2026-0001"'],
      ['500,00', '"S"', '10002', '8336', '2003', '"INV-2026-0002"'],
      ['500,00', '"H"', '10002', '8336', '2503', '"INV-2026-0002-ST"'],
    ]);
    // Reverse charge carries the buyer's VAT id; nothing invents a BU key for an automatic account.
    expect(rows[2]![39]).toBe('"ATU12345678"');
    expect(rows.every((r) => r[8] === '')).toBe(true);
    // A customer name cannot turn into a spreadsheet formula.
    expect(rows[2]![13]).toBe('"\'=Wien GmbH"');
    expect(rows[0]![13]).toBe('"Müller & Söhne ""KG"""');
  });

  it('exports payments only when asked, against the bank account', () => {
    configureDatev();
    expect(datevExport(db, MARCH, { now: NOW }).bookings).toBe(4);
    const rows = cp1252Text(datevExport(db, MARCH, { payments: true, now: NOW }).content).split('\r\n');
    const payment = rows.find((r) => r.includes('Zahlung'))!.split(';');
    expect([payment[0], payment[1], payment[6], payment[7], payment[10]]).toEqual(['10,00', '"S"', '1200', '10001', '"INV-2026-0001"']);
  });

  it('refuses instead of guessing: no consultant number, no account, a period across fiscal years', () => {
    expect(() => datevExport(db, MARCH)).toThrow(/settings are incomplete/);
    try {
      datevExport(db, MARCH);
    } catch (err) {
      expect((err as { details: { field: string }[] }).details.map((d) => d.field)).toEqual([
        'datev.consultant_number',
        'datev.client_number',
      ]);
    }

    const s = defaultSettings();
    writeSettings(db, {
      ...s,
      datev: { ...s.datev, consultant_number: 1234567, client_number: 1, revenue: { ...s.datev.revenue, AE: { account: null } } },
    });
    expect(() => datevExport(db, MARCH)).toThrow();
    try {
      datevExport(db, MARCH);
    } catch (err) {
      expect((err as { details: { field: string }[] }).details.map((d) => d.field)).toEqual(['datev.revenue.AE']);
    }

    configureDatev({ fiscal_year_start: '07-01' });
    expect(() => datevExport(db, { from: '2026-06-01', to: '2026-07-31' })).toThrow();
    expect(datevExport(db, { from: '2025-07-01', to: '2026-06-30' }).bookings).toBeGreaterThan(0);
  });

  it('checks personal account length against the account length, naming every customer', () => {
    configureDatev({ account_length: 5 });
    expect(() => datevExport(db, MARCH)).toThrow();
    try {
      datevExport(db, MARCH);
    } catch (err) {
      // Two customers with a bad account are two problems, not one.
      const messages = (err as { details: { field: string; message: string }[] }).details.map((d) => d.message);
      expect(messages).toEqual([
        'Debtor account 10001 (Müller & Söhne "KG") must have 6 digits for account length 5',
        'Debtor account 10002 (=Wien GmbH) must have 6 digits for account length 5',
      ]);
    }
    db.prepare('UPDATE customers SET debtor_account = 100000 + id').run();
    expect(datevExport(db, MARCH).bookings).toBe(4);
  });

  it('refuses a fiscal-year start that does not exist every year', () => {
    for (const bad of ['02-29', '02-30', '04-31', '06-31', '13-01', '00-10', '1-1']) {
      expect(() => writeSettings(db, { datev: { fiscal_year_start: bad } }), bad).toThrow();
    }
    for (const good of ['01-01', '02-28', '03-31', '07-01', '12-31']) {
      expect(writeSettings(db, { datev: { fiscal_year_start: good } }).settings.datev.fiscal_year_start).toBe(good);
    }
  });

  it('computes the fiscal year from its start', () => {
    expect(fiscalYear('2026-03-15', '01-01')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(fiscalYear('2026-03-15', '07-01')).toEqual({ from: '2025-07-01', to: '2026-06-30' });
    expect(fiscalYear('2026-07-01', '07-01')).toEqual({ from: '2026-07-01', to: '2027-06-30' });
  });
});

describe('BMD NTCS booking import', () => {
  beforeEach(scenario);

  it('refuses German rates until accounts and tax codes are set, then books gross with the VAT opposite', () => {
    expect(() => bmdExport(db, MARCH)).toThrow();
    const s = defaultSettings();
    writeSettings(db, {
      ...s,
      bmd: {
        ...s.bmd,
        revenue: {
          ...s.bmd.revenue,
          S19: { account: 4000, tax_code: '1' },
          S7: { account: 4005, tax_code: '1' },
          AE: { account: 4060, tax_code: '9' },
        },
      },
    });
    const lines = cp1252Text(bmdExport(db, MARCH).content).split('\r\n');
    expect(lines[0]).toBe('satzart;konto;gkonto;belegnr;belegdat;buchsymbol;buchcode;prozent;steuercode;betrag;steuer;text;extbelegnr;zziel');
    expect(lines.slice(1, -1)).toEqual([
      '0;200001;4005;20260001;15.03.2026;AR;1;7;1;42,78;-2,80;"Müller & Söhne ""KG""";"INV-2026-0001";14',
      '0;200001;4000;20260001;15.03.2026;AR;1;19;1;1,18;-0,19;"Müller & Söhne ""KG""";"INV-2026-0001";14',
      '0;200002;4060;20260002;20.03.2026;AR;1;0;9;500,00;0,00;"\'=Wien GmbH";"INV-2026-0002";30',
      '0;200002;4060;20260002;25.03.2026;AR;1;0;9;-500,00;0,00;"Storno INV-2026-0002 =Wien GmbH";"INV-2026-0002-ST";30',
    ]);
  });

  it('writes the compact date when configured', () => {
    const s = defaultSettings();
    writeSettings(db, {
      ...s,
      bmd: {
        ...s.bmd,
        date_format: 'yyyymmdd',
        revenue: { ...s.bmd.revenue, S19: { account: 4000, tax_code: '1' }, S7: { account: 4005, tax_code: '1' }, AE: { account: 4060, tax_code: '9' } },
      },
    });
    expect(cp1252Text(bmdExport(db, MARCH).content)).toContain(';20260315;AR;');
  });

  it('derives the numeric BMD document number from the invoice number', () => {
    expect(bmdDocumentNumber('INV-2026-0001')).toBe('20260001');
    expect(bmdDocumentNumber('RE/2026/000123456')).toBe('000123456');
  });
});

describe('settings', () => {
  beforeEach(scenario);

  it('start from the suggestions and keep what was stored', () => {
    expect(readSettings(db).datev.revenue.S19.account).toBe(8400);
    configureDatev({ chart: 'SKR04' });
    expect(readSettings(db).datev).toMatchObject({ chart: 'SKR04', consultant_number: 1234567 });
  });

  it('reject malformed values with field names', () => {
    expect(() =>
      writeSettings(db, { datev: { consultant_number: 12, fiscal_year_start: '13-01', revenue: { S19: { account: 'x', bu_key: 'ab' } } } }),
    ).toThrow();
    try {
      writeSettings(db, { datev: { consultant_number: 12, fiscal_year_start: '13-01', revenue: { S19: { account: 'x', bu_key: 'ab' } } } });
    } catch (err) {
      expect((err as { details: { field: string }[] }).details.map((d) => d.field)).toEqual([
        'datev.fiscal_year_start',
        'datev.consultant_number',
        'datev.revenue.S19.account',
        'datev.revenue.S19.bu_key',
      ]);
    }
  });

  it('are reachable over the API, and the exports are downloads', async () => {
    const auth = { username: 'a', password: 'p', secret: 's'.repeat(32), ttlHours: 1, secureCookie: false };
    const app = createApp({ db, auth, seller: { name: 'S', addressLines: [], vatId: 'DE1', iban: 'DE0', bic: '' } });
    const login = await request(app).post('/api/login').send({ username: 'a', password: 'p' });
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;

    expect((await request(app).get('/api/exports/datev.csv?from=2026-03-01&to=2026-03-31')).status).toBe(401);
    expect((await request(app).get('/api/exports/datev.csv').set('Cookie', cookie)).status).toBe(422);
    expect((await request(app).get('/api/exports/datev.csv?from=2026-03-01&to=2026-03-31').set('Cookie', cookie)).status).toBe(422);

    const current = (await request(app).get('/api/accounting-settings').set('Cookie', cookie)).body;
    const put = await request(app)
      .put('/api/accounting-settings')
      .set('Cookie', cookie)
      .send({ ...current.settings, datev: { ...current.settings.datev, consultant_number: 1001, client_number: 1 } });
    expect(put.status).toBe(200);

    const res = await request(app).get('/api/exports/datev.csv?from=2026-03-01&to=2026-03-31').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('windows-1252');
    expect(res.headers['content-disposition']).toContain('EXTF_Buchungsstapel_20260301_20260331.csv');
    expect(res.headers['x-booking-count']).toBe('4');
  });
});
