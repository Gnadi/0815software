import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import { getInvoice, invoiceDetail } from '../server/invoices.js';
import {
  addMonths,
  createTemplate,
  generateAll,
  generateDrafts,
  getTemplate,
  MAX_CATCH_UP,
  periodOf,
  type TemplateInput,
} from '../server/recurring.js';

/**
 * Wiederkehrende Rechnungen (server/recurring.ts): a template turns each
 * period that has begun into a draft — at most once per period, with the
 * periods derived from the start date rather than chained.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 's', ttlHours: 1, secureCookie: false };
const seller: SellerConfig = {
  name: 'Muster GmbH',
  addressLines: ['Lassallestraße 5', '1020 Wien'],
  vatId: 'ATU12345678',
  iban: 'AT611904300234573201',
  bic: 'BKAUATWW',
};

let db: Database.Database;
let app: Express;
let customerId: number;

const as = (access: AccessLevel) => `${COOKIE_NAME}=${createToken(auth, `${access}@example`, Date.now(), access)}`;

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, auth, seller });
  const customer = await request(app)
    .post('/api/customers')
    .set('Cookie', as('manage'))
    .send({ name: 'Kunde GmbH', address: 'Hauptplatz 1\n8010 Graz', country_code: 'AT' })
    .expect(201);
  customerId = customer.body.id as number;
});

function template(overrides: Partial<TemplateInput> = {}): number {
  return createTemplate(
    db,
    {
      name: 'Wartung',
      customerId,
      interval: 'monthly',
      startDate: '2026-01-31',
      endDate: null,
      active: true,
      draft: {
        paymentTermsDays: 14,
        note: 'Wartungsvertrag',
        lines: [{ description: 'Wartungspauschale', quantity: 1, unitPriceCents: 10000, vatRate: 20 }],
      },
      ...overrides,
    },
    'ada',
  );
}

const body = {
  name: 'Hosting',
  customer_id: 0,
  interval: 'quarterly',
  start_date: '2026-01-01',
  lines: [{ description: 'Hosting', quantity: 1, unit_price_cents: 3000, vat_rate: 20 }],
};

describe('periods are derived from the start date', () => {
  it('clamps the day to the month without drifting: 31 Jan → 28 Feb → 31 Mar', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
    expect(periodOf('2026-01-31', 'monthly', 1)).toEqual({ start: '2026-02-28', end: '2026-03-30' });
    expect(periodOf('2026-01-01', 'quarterly', 3)).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(periodOf('2026-03-01', 'yearly', 0)).toEqual({ start: '2026-03-01', end: '2027-02-28' });
  });
});

describe('generating', () => {
  it('turns each begun period into a draft dated to the period, with the period in the note', () => {
    const id = template();
    const created = generateDrafts(db, id, 'ada', '2026-03-31');
    expect(created.map((c) => c.period_start)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    const first = invoiceDetail(db, created[0]!.invoice_id);
    expect(first).toMatchObject({ status: 'draft', number: null, delivery_date: '2026-01-31', payment_terms_days: 14 });
    expect(first.note).toBe('Wartungsvertrag\nLeistungszeitraum 31.01.2026 – 27.02.2026');
    expect(first.lines).toEqual([expect.objectContaining({ description: 'Wartungspauschale', unit_price_cents: 10000 })]);
  });

  it('creates at most one draft per period, however often it runs', () => {
    const id = template();
    expect(generateDrafts(db, id, 'ada', '2026-02-28')).toHaveLength(2);
    expect(generateDrafts(db, id, 'bob', '2026-02-28')).toEqual([]);
    expect(generateAll(db, 'bob', '2026-02-28')).toEqual([]);
    // The database refuses a second claim on the same period outright.
    expect(() =>
      db
        .prepare(`INSERT INTO recurring_runs (template_id, period_start, period_end, created_at, actor) VALUES (?, '2026-01-31', 'x', 'x', 'x')`)
        .run(id),
    ).toThrow(/UNIQUE/);
    expect(getTemplate(db, id, '2026-02-28')).toMatchObject({ due_periods: 0, next_period_start: '2026-03-31' });
  });

  it('a deleted draft leaves its period done — it is not silently regenerated', async () => {
    const id = template();
    const [created] = generateDrafts(db, id, 'ada', '2026-01-31');
    await request(app).delete(`/api/invoices/${created!.invoice_id}`).set('Cookie', as('edit')).expect(200);
    expect(generateDrafts(db, id, 'ada', '2026-01-31')).toEqual([]);
    expect(getTemplate(db, id, '2026-01-31').recent[0]).toMatchObject({ period_start: '2026-01-31', invoice_id: null });
  });

  it('catches up missed periods in bounded batches', () => {
    const id = template({ startDate: '2020-01-01' });
    expect(generateDrafts(db, id, 'ada', '2026-01-01')).toHaveLength(MAX_CATCH_UP);
    expect(getTemplate(db, id, '2026-01-01').due_periods).toBe(73 - MAX_CATCH_UP);
  });

  it('stops at the end date and skips paused templates', () => {
    const ended = template({ endDate: '2026-02-28' });
    const paused = template({ active: false });
    expect(generateDrafts(db, ended, 'ada', '2026-12-31')).toHaveLength(2);
    expect(getTemplate(db, ended, '2026-12-31').next_period_start).toBeNull();
    expect(generateAll(db, 'ada', '2026-12-31')).toEqual([]);
    expect(getTemplate(db, paused, '2026-12-31')).toMatchObject({ due_periods: 0, next_period_start: null });
  });

  it('a template change reaches future drafts only', () => {
    const id = template();
    const [first] = generateDrafts(db, id, 'ada', '2026-01-31');
    db.prepare('UPDATE recurring_invoices SET draft = json_set(draft, \'$.lines[0].unitPriceCents\', 12000) WHERE id = ?').run(id);
    const [second] = generateDrafts(db, id, 'ada', '2026-02-28');
    expect(invoiceDetail(db, first!.invoice_id).lines[0]!.unit_price_cents).toBe(10000);
    expect(invoiceDetail(db, second!.invoice_id).lines[0]!.unit_price_cents).toBe(12000);
  });
});

describe('through the API', () => {
  it('validates the schedule and the lines together', async () => {
    const res = await request(app)
      .post('/api/recurring')
      .set('Cookie', as('edit'))
      .send({ ...body, customer_id: customerId, interval: 'weekly', start_date: '', end_date: '2025-01-01', lines: [] })
      .expect(422);
    const fields = (res.body.details as { field: string }[]).map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['interval', 'start_date', 'lines']));
  });

  it("refuses a VAT rate the seller's country does not charge", async () => {
    await request(app)
      .post('/api/recurring')
      .set('Cookie', as('edit'))
      .send({ ...body, customer_id: customerId, lines: [{ ...body.lines[0], vat_rate: 19 }] })
      .expect(422);
  });

  it('create, generate and edit are edit work; the run over every template is manage', async () => {
    await request(app).post('/api/recurring').set('Cookie', as('view')).send({ ...body, customer_id: customerId }).expect(403);
    const created = await request(app).post('/api/recurring').set('Cookie', as('edit')).send({ ...body, customer_id: customerId }).expect(201);
    expect(created.body).toMatchObject({ name: 'Hosting', interval: 'quarterly', created_by: 'edit@example', active: true });
    const list = await request(app).get('/api/recurring').set('Cookie', as('view')).expect(200);
    expect(list.body.templates).toHaveLength(1);

    await request(app).post(`/api/recurring/${created.body.id}/generate`).set('Cookie', as('view')).expect(403);
    const generated = await request(app).post(`/api/recurring/${created.body.id}/generate`).set('Cookie', as('edit')).expect(200);
    expect(generated.body.created.length).toBeGreaterThan(0);
    expect(getInvoice(db, generated.body.created[0].invoice_id).status).toBe('draft');

    await request(app).post('/api/recurring/run').set('Cookie', as('edit')).expect(403);
    await request(app).post('/api/recurring/run').set('Cookie', as('manage')).expect(200);
  });

  it('locks the start date and refuses deletion once a period is invoiced', async () => {
    const created = await request(app).post('/api/recurring').set('Cookie', as('edit')).send({ ...body, customer_id: customerId }).expect(201);
    const id = created.body.id as number;
    await request(app).put(`/api/recurring/${id}`).set('Cookie', as('edit')).send({ ...body, customer_id: customerId, start_date: '2026-02-01' }).expect(200);
    await request(app).post(`/api/recurring/${id}/generate`).set('Cookie', as('edit')).expect(200);

    await request(app).put(`/api/recurring/${id}`).set('Cookie', as('edit')).send({ ...body, customer_id: customerId, start_date: '2026-03-01' }).expect(409);
    const paused = await request(app)
      .put(`/api/recurring/${id}`)
      .set('Cookie', as('edit'))
      .send({ ...body, customer_id: customerId, start_date: '2026-02-01', active: false })
      .expect(200);
    expect(paused.body).toMatchObject({ active: false, due_periods: 0 });
    await request(app).delete(`/api/recurring/${id}`).set('Cookie', as('edit')).expect(409);

    const unused = await request(app).post('/api/recurring').set('Cookie', as('edit')).send({ ...body, customer_id: customerId, start_date: '2099-01-01' }).expect(201);
    await request(app).delete(`/api/recurring/${unused.body.id}`).set('Cookie', as('edit')).expect(200);
    await request(app).post(`/api/recurring/${unused.body.id}/generate`).set('Cookie', as('edit')).expect(404);
  });
});
