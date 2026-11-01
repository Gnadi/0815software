import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import { buildPlatform, noopPlatform, OfferFetchError, type PlatformHooks } from '../server/platform.js';
import type { ExpenseClaimTransfer } from '../shared/expense-transfer.js';

/**
 * An employee's approved expense claim from MOD-11, paid by transfer
 * (server/expense-claims.ts): taken over once as a bill, handed over before
 * the bill exists, paid through the ordinary payment run, reported back.
 *
 * MOD-11 is a fake here that answers as its transfer routes do; its own
 * suite (modules/mod-11-time-tracking/test/expenses.test.ts) pins the other
 * side of shared/expense-transfer.ts, which both modules carry byte for byte.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 'test-secret', ttlHours: 1, secureCookie: false };
const seller: SellerConfig = {
  name: '0815software GmbH',
  addressLines: ['Beispielgasse 8/15', '1010 Wien', 'Austria'],
  vatId: 'ATU00000000',
  iban: 'AT72 3200 0000 0123 4567',
  bic: 'RLNWATWWXXX',
};
const as = (access: AccessLevel, actor: string) => `${COOKIE_NAME}=${createToken(auth, actor, Date.now(), access)}`;
const CLERK = as('edit', 'buchhaltung@0815software.example');
const BOSS = as('manage', 'david@0815software.example');

const claim = (over: Partial<ExpenseClaimTransfer> = {}): ExpenseClaimTransfer => ({
  version: 1,
  source: 'mod-11-time-tracking',
  number: 'SP-2026-0001',
  title: 'Linz workshop',
  employee: { name: 'Anna Berger', email: 'anna@0815software.example' },
  payee: { holder: 'Anna Berger', iban: 'AT611904300234573201', bic: null },
  approved_at: '2026-10-20T09:12:00Z',
  approved_by: 'david@0815software.example',
  currency: 'EUR',
  totals: { per_diem_cents: 4500, nights_cents: 1700, mileage_cents: 12025, receipts_cents: 1400, total_cents: 19625 },
  lines: [
    { kind: 'per_diem', date: '2026-10-13', description: 'Tagesgeld Linz', amount_cents: 4500, vat_lines: [] },
    { kind: 'nights', date: '2026-10-13', description: 'Nächtigungsgeld Linz, 1 × 17.00', amount_cents: 1700, vat_lines: [] },
    { kind: 'mileage', date: '2026-10-13', description: 'Kilometergeld Wien – Linz, 185.0 km', amount_cents: 12025, vat_lines: [] },
    { kind: 'receipt', date: '2026-10-13', description: 'Parkgarage Hauptplatz', amount_cents: 1400, vat_lines: [{ rate_bp: 2000, gross_cents: 1400 }] },
  ],
  handed_over_ref: null,
  ...over,
});

let db: Database.Database;
let app: Express;
let calls: string[];
let transfer: ExpenseClaimTransfer;
let refusePaid: boolean;

function fakeTimeTracking(): PlatformHooks {
  return {
    ...noopPlatform,
    expenseClaimsConfigured: true,
    async listExpenseClaims() {
      calls.push('list');
      return { claims: [{ number: transfer.number, title: transfer.title, employee_name: 'Anna Berger', total_cents: transfer.totals.total_cents, has_bank_account: true }] };
    },
    async fetchExpenseClaim(number) {
      calls.push(`fetch ${number}`);
      if (number !== transfer.number) throw new OfferFetchError(404, 'Claim not found');
      return transfer;
    },
    async expenseClaimHandedOver(info) {
      calls.push(`handed-over ${info.number} ${info.reference} ${info.actor}`);
      // The bill must not exist yet: MOD-11 locks first.
      expect((db.prepare('SELECT COUNT(*) AS n FROM bills WHERE expense_claim = ?').get(info.number) as { n: number }).n).toBe(0);
    },
    async expenseClaimPaid(info) {
      calls.push(`paid ${info.number} ${info.bill} ${info.reference}`);
      if (refusePaid) throw new OfferFetchError(502, 'The time tracking module is unreachable');
    },
  };
}

const importClaim = (cookie: string, number = 'SP-2026-0001') => request(app).post('/api/bills/import-expense-claim').set('Cookie', cookie).send({ claim_number: number });

beforeEach(() => {
  db = openDb(':memory:');
  calls = [];
  transfer = claim();
  refusePaid = false;
  app = createApp({ db, auth, seller, platform: fakeTimeTracking() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('standalone', () => {
  it('without TIME_TRACKING_URL there are no expense claims, and the import says why', async () => {
    app = createApp({ db, auth, seller });
    expect((await request(app).get('/api/expense-claims').set('Cookie', CLERK).expect(200)).body).toMatchObject({ configured: false, waiting: [] });
    expect((await importClaim(CLERK).expect(501)).body.error).toBe('No time tracking is configured — set TIME_TRACKING_URL to pay expense claims');
  });
});

describe('taking a claim over', () => {
  it('becomes one bill to the employee, with a creditor found or made by the IBAN', async () => {
    const res = await importClaim(CLERK).expect(201);
    expect(calls).toEqual(['fetch SP-2026-0001', 'handed-over SP-2026-0001 MOD-04:SP-2026-0001 buchhaltung@0815software.example']);
    expect(res.body).toMatchObject({
      reference: 'SP-2026-0001',
      expense_claim: 'SP-2026-0001',
      amount_cents: 19625,
      issue_date: '2026-10-20',
      creditor_name: 'Anna Berger',
      creditor_iban: 'AT611904300234573201',
      status: 'open',
      payment_reference: 'Spesen SP-2026-0001 Linz workshop',
    });
    // Allowances as they are; a receipt as its net at its rate.
    expect(res.body.lines.map((l: { net_cents: number; vat_rate: number | null }) => [l.net_cents, l.vat_rate])).toEqual([
      [4500, null],
      [1700, null],
      [12025, null],
      [1167, 20],
    ]);
    // Once: a second import is the first bill, and MOD-11 is not asked again.
    const again = await importClaim(CLERK).expect(200);
    expect(again.body.id).toBe(res.body.id);
    expect(calls).toHaveLength(2);
    // A second claim of the same person pays the same creditor.
    transfer = claim({ number: 'SP-2026-0007', title: 'Graz' });
    const second = await importClaim(CLERK, 'SP-2026-0007').expect(201);
    expect(second.body.creditor_id).toBe(res.body.creditor_id);
  });

  it('refuses a transfer that does not add up — before MOD-11 is told anything', async () => {
    transfer = claim({ totals: { ...claim().totals, total_cents: 19626 } });
    expect((await importClaim(CLERK).expect(422)).body.error).toBe('Expense claim SP-2026-0001 cannot be paid: The lines add up to 19625 cents, the claim to 19626');
    transfer = claim({ payee: { holder: 'Anna Berger', iban: 'AT611904300234573202', bic: null } });
    expect((await importClaim(CLERK).expect(422)).body.error).toMatch(/check digits/);
    expect(calls.filter((c) => c.startsWith('handed-over'))).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM bills').get() as { n: number }).n).toBe(0);
  });

  it('passes on what MOD-11 says, and does not take over a claim another instance holds', async () => {
    expect((await importClaim(CLERK, 'SP-2026-0099').expect(404)).body.error).toBe('Claim not found');
    transfer = claim({ handed_over_ref: 'MOD-04-other:SP-2026-0001' });
    expect((await importClaim(CLERK).expect(409)).body.error).toBe('Expense claim SP-2026-0001 is already being paid as MOD-04-other:SP-2026-0001');
    expect((await importClaim(CLERK, 'nonsense').expect(422)).body.details[0].field).toBe('claim_number');
  });

  it('the claim\'s bill keeps the claim\'s amount and payee, and is paid — not cancelled or deleted', async () => {
    const bill = (await importClaim(CLERK).expect(201)).body;
    const edit = await request(app)
      .put(`/api/bills/${bill.id}`)
      .set('Cookie', CLERK)
      .send({ creditor_id: bill.creditor_id, reference: bill.reference, amount_cents: 99999, due_date: bill.due_date });
    expect(edit.status).toBe(409);
    expect(edit.body.error).toBe('Cannot change the amount, reference or payee of this bill: it pays expense claim SP-2026-0001 as approved in time tracking');
    // The due date may move.
    await request(app).put(`/api/bills/${bill.id}`).set('Cookie', CLERK).send({ creditor_id: bill.creditor_id, reference: bill.reference, amount_cents: bill.amount_cents, due_date: '2026-12-01' }).expect(200);
    await request(app).post(`/api/bills/${bill.id}/cancel`).set('Cookie', CLERK).expect(409);
    await request(app).delete(`/api/bills/${bill.id}`).set('Cookie', CLERK).expect(409);
  });
});

describe('paid, and MOD-11 hears it', () => {
  it('through the payment run: the run\'s message id is the reference', async () => {
    const bill = (await importClaim(CLERK).expect(201)).body;
    const run = await request(app).post('/api/payment-runs').set('Cookie', BOSS).send({ bill_ids: [bill.id] });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    await request(app).post(`/api/payment-runs/${run.body.id}/mark-executed`).set('Cookie', BOSS).expect(200);
    expect(calls.at(-1)).toBe(`paid SP-2026-0001 MOD-04:SP-2026-0001 payment run ${run.body.message_id}`);
    expect((await request(app).get(`/api/bills/${bill.id}`).set('Cookie', CLERK)).body.expense_reported_at).not.toBeNull();
  });

  it('a report that does not get through is sent again when the claims are next opened', async () => {
    const bill = (await importClaim(CLERK).expect(201)).body;
    refusePaid = true;
    await request(app).post(`/api/bills/${bill.id}/mark-paid`).set('Cookie', CLERK).expect(200);
    expect(calls.at(-1)).toBe(`paid SP-2026-0001 MOD-04:SP-2026-0001 bill ${bill.id}, paid outside a payment run`);
    const failed = await request(app).get('/api/expense-claims').set('Cookie', CLERK).expect(200);
    expect(failed.body.unreported).toEqual(['SP-2026-0001']);
    refusePaid = false;
    const ok = await request(app).get('/api/expense-claims').set('Cookie', CLERK).expect(200);
    expect(ok.body).toMatchObject({ configured: true, unreported: [], unreachable: null });
    expect(ok.body.bills[0]).toMatchObject({ expense_claim: 'SP-2026-0001', status: 'paid' });
    expect(ok.body.waiting).toHaveLength(1);
    // Reported once, then never again.
    const before = calls.length;
    await request(app).get('/api/expense-claims').set('Cookie', CLERK).expect(200);
    expect(calls.slice(before)).toEqual(['list']);
  });
});

describe('the wire', () => {
  it('asks MOD-11 at its transfer routes with the machine token', async () => {
    const seen: { url: string; method: string; token: string | null; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      seen.push({ url, method: init.method ?? 'GET', token: headers.get('X-Service-Token'), body: init.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith('/transfer/expense-claims/SP-2026-0001')) return new Response(JSON.stringify(claim()), { status: 200 });
      if (url.endsWith('/handed-over') || url.endsWith('/paid')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ error: 'Claim not found' }), { status: 404 });
    });
    app = createApp({ db, auth, seller, platform: buildPlatform({ timeTrackingUrl: 'http://time-tracking:3011/', serviceToken: 'svc' }) });
    const bill = (await importClaim(CLERK).expect(201)).body;
    await request(app).post(`/api/bills/${bill.id}/mark-paid`).set('Cookie', CLERK).expect(200);
    expect(seen).toEqual([
      { url: 'http://time-tracking:3011/api/transfer/expense-claims/SP-2026-0001', method: 'GET', token: 'svc', body: null },
      { url: 'http://time-tracking:3011/api/transfer/expense-claims/SP-2026-0001/handed-over', method: 'POST', token: 'svc', body: { reference: 'MOD-04:SP-2026-0001', actor: 'buchhaltung@0815software.example' } },
      {
        url: 'http://time-tracking:3011/api/transfer/expense-claims/SP-2026-0001/paid',
        method: 'POST',
        token: 'svc',
        body: { bill: 'MOD-04:SP-2026-0001', reference: `bill ${bill.id}, paid outside a payment run`, actor: 'buchhaltung@0815software.example' },
      },
    ]);
  });
});
