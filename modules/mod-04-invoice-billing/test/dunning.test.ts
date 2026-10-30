import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import { noopPlatform, type DunningNoticeInfo } from '../server/platform.js';
import { addDays, todayIso } from '../server/invoices.js';
import {
  defaultDunningSettings,
  dunningOverview,
  interestCents,
  issueDunningNotice,
  validateDunningSettings,
  writeDunningSettings,
} from '../server/dunning.js';

/**
 * Mahnwesen (server/dunning.ts): where an overdue invoice stands is derived on
 * every read; a notice that went out is a stored, append-only fact.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 's', ttlHours: 1, secureCookie: false };
const seller: SellerConfig = {
  name: 'Muster GmbH',
  addressLines: ['Lassallestraße 5', '1020 Wien'],
  vatId: 'ATU12345678',
  iban: 'AT611904300234573201',
  bic: 'BKAUATWW',
  registration: 'FN 123456a',
  legalInformation: 'Sitz Wien · Firmenbuchgericht Handelsgericht Wien',
};

let db: Database.Database;
let app: Express;
let sent: DunningNoticeInfo[];

const as = (access: AccessLevel) => `${COOKIE_NAME}=${createToken(auth, `${access}@example`, Date.now(), access)}`;
const today = todayIso();

beforeEach(() => {
  db = openDb(':memory:');
  sent = [];
  app = createApp({ db, auth, seller, platform: { ...noopPlatform, dunningNoticeIssued: async (info) => void sent.push(info) } });
});

/** An issued invoice of €120.00 gross (100 + 20 % VAT), due `overdue` days ago. */
async function overdueInvoice(overdue: number): Promise<number> {
  const customer = await request(app)
    .post('/api/customers')
    .set('Cookie', as('manage'))
    .send({ name: 'Kunde GmbH', email: 'ap@kunde.at', address: 'Hauptplatz 1\n8010 Graz' })
    .expect(201);
  const draft = await request(app)
    .post('/api/invoices')
    .set('Cookie', as('manage'))
    .send({ customer_id: customer.body.id, payment_terms_days: 14, lines: [{ description: 'Wartung', quantity: 1, unit_price_cents: 10000, vat_rate: 20 }] })
    .expect(201);
  await request(app)
    .post(`/api/invoices/${draft.body.id}/finalize`)
    .set('Cookie', as('manage'))
    .send({ issue_date: addDays(today, -(overdue + 14)) })
    .expect(200);
  return draft.body.id as number;
}

describe('where an invoice stands is derived', () => {
  it('a fresh overdue invoice is due for the first level once its days have passed', async () => {
    const early = await overdueInvoice(3);
    const late = await overdueInvoice(60);
    const rows = dunningOverview(db, today);
    const byId = new Map(rows.map((r) => [r.invoice_id, r]));
    expect(byId.get(late)).toMatchObject({ days_overdue: 60, next_level: 1, next_level_name: 'Zahlungserinnerung', due_now: true, open_cents: 12000 });
    // Overdue, but the first reminder goes out 7 days after the due date.
    expect(byId.get(early)).toMatchObject({ days_overdue: 3, next_level: 1, due_now: false, next_on: addDays(today, 4) });
    expect(rows[0]!.invoice_id).toBe(late); // due ones first
  });

  it('goes level by level, waiting min_days_between, even when far overdue', async () => {
    const id = await overdueInvoice(60);
    expect(issueDunningNotice(db, id, 'ada', today).level).toBe(1);
    // 60 days late is past every level, but not three letters in one day.
    expect(() => issueDunningNotice(db, id, 'ada', today)).toThrow(/next notice .* is due on/);
    const later = addDays(today, 10);
    expect(issueDunningNotice(db, id, 'ada', later).level).toBe(2);
    expect(issueDunningNotice(db, id, 'ada', addDays(later, 10)).level).toBe(3);
    expect(() => issueDunningNotice(db, id, 'ada', addDays(later, 30))).toThrow(/every dunning level/);
  });

  it('a payment takes the invoice off the list — nothing to reset', async () => {
    const id = await overdueInvoice(30);
    issueDunningNotice(db, id, 'ada', today);
    await request(app).post(`/api/invoices/${id}/payments`).set('Cookie', as('edit')).send({ amount_cents: 12000 }).expect(201);
    expect(dunningOverview(db, today).find((r) => r.invoice_id === id)).toBeUndefined();
    expect(() => issueDunningNotice(db, id, 'ada', addDays(today, 30))).toThrow(/not overdue with an open amount/);
  });

  it('a part payment lowers what the next notice claims', async () => {
    const id = await overdueInvoice(30);
    await request(app).post(`/api/invoices/${id}/payments`).set('Cookie', as('edit')).send({ amount_cents: 2000 }).expect(201);
    expect(issueDunningNotice(db, id, 'ada', today).open_cents).toBe(10000);
  });
});

describe('a notice is a stored fact', () => {
  it('records what was claimed, with fee and interest as configured at the time', async () => {
    const settings = defaultDunningSettings();
    settings.levels[0]!.fee_cents = 500;
    settings.interest_rate_percent = 9.2;
    writeDunningSettings(db, settings, 'boss');
    const id = await overdueInvoice(40);
    const notice = issueDunningNotice(db, id, 'ada', today);
    expect(notice).toMatchObject({ level: 1, open_cents: 12000, fee_cents: 500, interest_rate_percent: 9.2, days_overdue: 40, actor: 'ada' });
    expect(notice.interest_cents).toBe(interestCents(12000, 9.2, 40));
    expect(notice.interest_cents).toBe(121); // 120 € × 9.2 % × 40/365

    // A later change to the settings does not rewrite what went out.
    writeDunningSettings(db, defaultDunningSettings(), 'boss');
    const again = await request(app).get('/api/dunning').set('Cookie', as('view'));
    const stored = again.body.rows.find((r: { invoice_id: number }) => r.invoice_id === id).notices[0];
    expect(stored).toMatchObject({ fee_cents: 500, interest_cents: 121 });
  });

  it('cannot be issued twice for the same level, even past the application rules', async () => {
    const id = await overdueInvoice(40);
    issueDunningNotice(db, id, 'ada', today);
    expect(() =>
      db
        .prepare(`INSERT INTO dunning_notices (invoice_id, level, level_name, issued_on, days_overdue, open_cents, text, actor, created_at)
                  VALUES (?, 1, 'x', ?, 1, 1, 'x', 'x', 'x')`)
        .run(id, today),
    ).toThrow(/UNIQUE/);
  });

  it('renders the same letter on every download, naming the level and the claim', async () => {
    const id = await overdueInvoice(40);
    const issued = await request(app).post(`/api/invoices/${id}/dunning-notices`).set('Cookie', as('edit')).expect(201);
    const first = await request(app).get(`/api/dunning-notices/${issued.body.id}/pdf`).set('Cookie', as('view')).buffer(true).expect(200);
    const second = await request(app).get(`/api/dunning-notices/${issued.body.id}/pdf`).set('Cookie', as('view')).buffer(true).expect(200);
    expect(first.headers['content-type']).toBe('application/pdf');
    expect(Buffer.compare(first.body as Buffer, second.body as Buffer)).toBe(0);
    const text = (first.body as Buffer).toString('latin1');
    expect(text).toContain('ZAHLUNGSERINNERUNG');
    expect(text).toContain('Offener Gesamtbetrag');
    // A business letter names the company as the law asks (§ 35a GmbHG), as the invoice does.
    expect(text).toContain('(Sitz Wien \\267 Firmenbuchgericht Handelsgericht Wien) Tj'); // · is WinAnsi 0xB7
    expect(text).toContain('(FN 123456a) Tj');
  });
});

describe('through the API, by level', () => {
  it('anyone may read the list; issuing a notice is edit work and tells the customer', async () => {
    const id = await overdueInvoice(40);
    await request(app).get('/api/dunning').set('Cookie', as('view')).expect(200);
    await request(app).post(`/api/invoices/${id}/dunning-notices`).set('Cookie', as('view')).expect(403);
    await request(app).post(`/api/invoices/${id}/dunning-notices`).set('Cookie', as('edit')).expect(201);
    expect(sent).toEqual([
      expect.objectContaining({ levelName: 'Zahlungserinnerung', customerEmail: 'ap@kunde.at', claimedFormatted: '120,00 €', actor: 'edit@example' }),
    ]);
    await request(app).post(`/api/invoices/${id}/dunning-notices`).set('Cookie', as('edit')).expect(409);
  });

  it('a run over every due invoice, and the settings, are manage', async () => {
    await overdueInvoice(40);
    await overdueInvoice(50);
    await overdueInvoice(2);
    await request(app).post('/api/dunning/run').set('Cookie', as('edit')).expect(403);
    const run = await request(app).post('/api/dunning/run').set('Cookie', as('manage')).expect(200);
    expect(run.body.issued).toHaveLength(2);
    // Run again: nothing is due yet.
    expect((await request(app).post('/api/dunning/run').set('Cookie', as('manage')).expect(200)).body.issued).toEqual([]);

    const body = { ...defaultDunningSettings(), min_days_between: 5 };
    await request(app).put('/api/dunning-settings').set('Cookie', as('edit')).send(body).expect(403);
    const saved = await request(app).put('/api/dunning-settings').set('Cookie', as('manage')).send(body).expect(200);
    expect(saved.body).toMatchObject({ settings: { min_days_between: 5 }, updated_by: 'manage@example' });
  });
});

describe('settings', () => {
  it('refuses levels out of order, too many levels and a nonsense rate — all at once', () => {
    const base = defaultDunningSettings();
    try {
      validateDunningSettings({
        levels: [base.levels[1], base.levels[0], base.levels[2], base.levels[2], base.levels[2]],
        min_days_between: -1,
        interest_rate_percent: 99,
      });
      throw new Error('accepted');
    } catch (err) {
      const fields = (err as { details: { field: string }[] }).details.map((d) => d.field);
      expect(fields).toEqual(expect.arrayContaining(['levels', 'levels[1].days_after_due', 'min_days_between', 'interest_rate_percent']));
    }
  });

  it('ships sensible defaults: three levels, no fee, no interest', () => {
    const settings = defaultDunningSettings();
    expect(validateDunningSettings(settings)).toEqual(settings);
    expect(settings.levels.map((l) => l.days_after_due)).toEqual([7, 21, 35]);
  });
});
