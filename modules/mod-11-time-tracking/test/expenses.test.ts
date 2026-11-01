import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import { noopPlatform, type PlatformHooks } from '../server/platform.js';

/**
 * Expenses (server/expenses.ts): trips, drives and receipts recorded by the
 * person, claimed together, decided by the office — never by the person
 * themselves — and paid with the salary or by the invoicing module.
 *
 * The money is derived throughout; what a claim was submitted at is what it
 * is decided and paid at, whatever happens to the rates afterwards.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 'test-secret', ttlHours: 1, secureCookie: false };
const SERVICE = 'service-token-for-tests';
let db: Database.Database;
let app: Express;
let anna: number;
let bob: number;
let sent: { to: string; subject: string; body: string; idempotencyKey: string }[];

const as = (access: AccessLevel, actor: string) => `${COOKIE_NAME}=${createToken(auth, actor, Date.now(), access)}`;
const ANNA = as('edit', 'anna@0815software.example');
const BOB = as('edit', 'bob@0815software.example');
const BOSS = as('manage', 'david@0815software.example');
const VIEWER = as('view', 'auditor@0815software.example');

const post = (cookie: string, path: string, values: Record<string, unknown> = {}) => request(app).post(path).set('Cookie', cookie).send(values);
const put = (cookie: string, path: string, values: Record<string, unknown>) => request(app).put(path).set('Cookie', cookie).send(values);
const get = (cookie: string, path: string) => request(app).get(path).set('Cookie', cookie);
const machine = (method: 'get' | 'post', path: string, values?: Record<string, unknown>) => {
  const r = request(app)[method](path).set('X-Service-Token', SERVICE);
  return values ? r.send(values) : r;
};

const TRIP = { purpose: 'Workshop at Donaufracht', destination: 'Linz', start_local: '2026-10-05T07:00', end_local: '2026-10-06T19:00', meals: [0, 1], nights_flat: 1 };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a photographed receipt')]);
const SIG = 'k2lVUXZ6/9WC/YIM3gl1n3z2YljGcJKuvufYvCUiiYdpCo8LWGdNdPMIhQP4D4bt+oGDdRwwrFjYzPMfxYTK8g==';
const till = (no: string, normal = '23,40', reduced = '0,00', at = '2026-10-05T12:31:05', turnover = 'lHZnU+ICvLM=') =>
  `_R1-AT1_GASTHAUS-1_${no}_${at}_${normal}_${reduced}_0,00_0,00_0,00_${turnover}_-3667961875706356849_cg8hNU5ihto=_${SIG}`;

const upload = (cookie: string, id: number, data: Buffer) =>
  request(app).put(`/api/expenses/receipts/${id}/file`).set('Cookie', cookie).set('Content-Type', 'application/octet-stream').send(data);

/** Anna's trip, drive and pictured receipt, ready to claim. */
async function annasItems() {
  const trip = (await post(ANNA, '/api/expenses/trips', TRIP).expect(201)).body;
  const drive = (await post(ANNA, '/api/expenses/mileage', { travel_date: '2026-10-05', from_place: 'Wien', to_place: 'Linz', purpose: 'Workshop', km_tenths: 1850, vehicle: 'car', passengers: 1 }).expect(201)).body;
  const receipt = (await post(ANNA, '/api/expenses/receipts', { merchant: 'Parkgarage Linz', category: 'parking', receipt_date: '2026-10-05', gross_cents: 1200, vat_lines: [{ rate_bp: 2000, gross_cents: 1200 }] }).expect(201)).body;
  await upload(ANNA, receipt.id, JPEG).expect(200);
  return { trip, drive, receipt };
}

async function annasClaim(extra: Record<string, unknown> = {}) {
  const { trip, drive, receipt } = await annasItems();
  const res = await post(ANNA, '/api/expenses/claims', { trip_ids: [trip.id], mileage_ids: [drive.id], receipt_ids: [receipt.id], ...extra }).expect(201);
  return { trip, drive, receipt, detail: res.body };
}

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
  // The seed brings example expenses; these tests count from empty.
  db.exec(
    'DELETE FROM expense_claim_events; DELETE FROM expense_claim_items; DELETE FROM expense_claims; DELETE FROM expense_files; DELETE FROM expense_receipts; DELETE FROM expense_mileage; DELETE FROM expense_trips; DELETE FROM expense_bank_accounts;',
  );
  const id = (email: string) => (db.prepare('SELECT id FROM employees WHERE email = ?').get(email) as { id: number }).id;
  anna = id('anna@0815software.example');
  bob = id('bob@0815software.example');
  sent = [];
  const platform: PlatformHooks = {
    ...noopPlatform,
    notificationConfigured: true,
    async notify(m) {
      sent.push(m);
    },
  };
  app = createApp({ db, auth, platform, serviceToken: SERVICE });
});

describe('the rates ship with the law, and are versioned', () => {
  it('domestic rates from EStG and RGV, foreign ones from the Auslandsreisesätze', async () => {
    const res = (await get(VIEWER, '/api/expenses/rates/in-force?date=2026-10-01').expect(200)).body;
    const domestic = Object.fromEntries(res.domestic.map((r: { kind: string; amount_cents: number }) => [r.kind, r.amount_cents]));
    expect(domestic).toEqual({
      per_diem_domestic: 3000,
      night_domestic: 1700,
      meal_reduction_domestic: 1500,
      mileage_car: 50,
      mileage_motorbike: 25,
      mileage_bicycle: 25,
      mileage_passenger: 15,
    });
    expect(res.countries.find((c: { country: string }) => c.country === 'Deutschland')).toEqual({ country: 'Deutschland', day_cents: 3530, night_cents: 2790 });
    expect(res.countries.find((c: { country: string }) => c.country === 'USA: New York/Washington')).toEqual({ country: 'USA: New York/Washington', day_cents: 6540, night_cents: 5100 });
    expect(res.countries).toHaveLength(173);
    // Kilometergeld in this wording of § 10 RGV holds from 1 July 2025; before, the office enters it.
    const june = (await get(VIEWER, '/api/expenses/rates/in-force?date=2025-06-30').expect(200)).body;
    expect(june.domestic.find((r: { kind: string }) => r.kind === 'mileage_car').amount_cents).toBeNull();
    const drive = await post(ANNA, '/api/expenses/mileage', { travel_date: '2025-06-30', from_place: 'Wien', to_place: 'Graz', purpose: 'Kunde', km_tenths: 2000 }).expect(201);
    expect(drive.body.rate_problem).toMatch(/^No mileage, car \(kilometergeld\) is in force on 2025-06-30/);
  });

  it('presets are written once, however often the module starts', async () => {
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM expense_rates').get() as { n: number }).n;
    const before = count();
    const { installExpensePresets } = await import('../server/expense-presets.js');
    installExpensePresets(db);
    expect(count()).toBe(before);
    expect(before).toBe(7 + 2 * 173);
  });

  it('a new rate is a new row from a date; the newest row for a date wins; only manage adds one', async () => {
    await post(ANNA, '/api/expenses/rates', { kind: 'per_diem_domestic', valid_from: '2026-01-01', amount_cents: 3300 }).expect(403);
    const rate = await post(BOSS, '/api/expenses/rates', { kind: 'per_diem_domestic', valid_from: '2026-01-01', amount_cents: 3300, basis: 'KV Handel' }).expect(201);
    expect(rate.body).toMatchObject({ actor: 'david@0815software.example', preset: false });
    await post(BOSS, '/api/expenses/rates', { kind: 'per_diem_domestic', valid_from: '2026-01-01', amount_cents: 3200 }).expect(201);
    const at = async (date: string) => (await get(VIEWER, `/api/expenses/rates/in-force?date=${date}`)).body.domestic.find((r: { kind: string }) => r.kind === 'per_diem_domestic').amount_cents;
    expect(await at('2025-12-31')).toBe(3000);
    expect(await at('2026-10-01')).toBe(3200);
    // Nothing is overwritten: the history holds all three.
    expect((await get(VIEWER, '/api/expenses/rates?kind=per_diem_domestic')).body.rates).toHaveLength(3);
    expect((await post(BOSS, '/api/expenses/rates', { kind: 'per_diem_abroad', valid_from: '2026-01-01', amount_cents: 4000 })).body.details[0].field).toBe('country');
  });
});

describe('a trip', () => {
  it('is priced from its times, meals and nights', async () => {
    const res = await post(ANNA, '/api/expenses/trips', TRIP).expect(201);
    // 36 hours in 24-hour blocks: a full day, then 12 hours less one paid meal; one night at the flat rate.
    expect(res.body).toMatchObject({
      employee_id: anna,
      employee_name: 'Anna Berger',
      nights_max: 1,
      per_diem_cents: 3000 + 1500,
      night_rate_cents: 1700,
      nights_cents: 1700,
      total_cents: 6200,
      rate_problem: null,
      locked: false,
      created_by: 'anna@0815software.example',
    });
    expect(res.body.periods.map((p: { minutes: number; amount_cents: number }) => [p.minutes, p.amount_cents])).toEqual([
      [1440, 3000],
      [720, 1500],
    ]);
  });

  it('by calendar day when the office accounts that way', async () => {
    await put(BOSS, '/api/expenses/settings', { per_diem_mode: 'calendar' }).expect(200);
    const res = await post(ANNA, '/api/expenses/trips', { ...TRIP, meals: [], nights_flat: 0 }).expect(201);
    // 07:00–24:00 is 17 hours, then 19 hours: two full days.
    expect(res.body.periods.map((p: { minutes: number }) => p.minutes)).toEqual([1020, 1140]);
    expect(res.body.per_diem_cents).toBe(6000);
  });

  it('abroad: the country\'s rate between the borders, the domestic time before and after added up', async () => {
    const res = await post(ANNA, '/api/expenses/trips', {
      purpose: 'Messe',
      destination: 'München',
      country: 'Deutschland',
      start_local: '2026-10-07T06:00',
      end_local: '2026-10-07T22:00',
      border_out: '2026-10-07T08:00',
      border_in: '2026-10-07T20:00',
    }).expect(201);
    expect(res.body.periods.map((p: { abroad: boolean; amount_cents: number }) => [p.abroad, p.amount_cents])).toEqual([
      [false, 1000],
      [true, 3530],
    ]);
  });

  it('says what does not add up', async () => {
    const bad = async (values: Record<string, unknown>) => (await post(ANNA, '/api/expenses/trips', { ...TRIP, ...values }).expect(422)).body.details;
    expect(await bad({ meals: [0, 0, 1] })).toEqual([{ field: 'meals', message: 'The trip has 2 period(s); meals were given for 3' }]);
    expect(await bad({ nights_flat: 2 })).toEqual([{ field: 'nights_flat', message: 'The trip spans 1 night(s)' }]);
    expect(await bad({ end_local: '2026-10-05T06:00' })).toEqual([{ field: 'end_local', message: 'The trip ends before it starts' }]);
    expect((await bad({ country: 'Atlantis' }))[0].message).toMatch(/No foreign rate is kept for "Atlantis"/);
    expect((await bad({ border_out: '2026-10-05T08:00', border_in: '2026-10-05T18:00' }))[0].message).toBe('Border crossings belong to a trip abroad');
  });
});

describe('capturing offline: the same item sent twice is one item', () => {
  it('a retry with the same client_id answers with the first row', async () => {
    const values = { ...TRIP, client_id: '3f2b8c1e-9d4a-4b7e-a1c2-5e6f7a8b9c0d' };
    const first = await post(ANNA, '/api/expenses/trips', values).expect(201);
    const again = await post(ANNA, '/api/expenses/trips', values).expect(200);
    expect(again.body.id).toBe(first.body.id);
    expect((db.prepare('SELECT COUNT(*) AS n FROM expense_trips').get() as { n: number }).n).toBe(1);
    // Another person's app may mint the same id; it is theirs, not Anna's.
    expect((await post(BOB, '/api/expenses/trips', values).expect(201)).body.id).not.toBe(first.body.id);
  });

  it('receipts and claims likewise', async () => {
    const r = { merchant: 'Café', receipt_date: '2026-10-05', gross_cents: 450, client_id: 'receipt-0001-offline' };
    const first = (await post(ANNA, '/api/expenses/receipts', r).expect(201)).body;
    expect((await post(ANNA, '/api/expenses/receipts', r).expect(200)).body.id).toBe(first.id);
    await upload(ANNA, first.id, JPEG).expect(200);
    const c = { receipt_ids: [first.id], client_id: 'claim-0001-offline' };
    const claim = (await post(ANNA, '/api/expenses/claims', c).expect(201)).body;
    expect((await post(ANNA, '/api/expenses/claims', c).expect(200)).body.claim.number).toBe(claim.claim.number);
  });
});

describe('whose expenses', () => {
  it('an editor records and sees only their own; manage sees everyone\'s', async () => {
    const trip = (await post(ANNA, '/api/expenses/trips', TRIP).expect(201)).body;
    expect((await post(BOB, '/api/expenses/trips', { ...TRIP, employee_id: anna }).expect(403)).body.error).toBe('You can only record your own expenses');
    // Someone else's item answers like none at all.
    expect((await get(BOB, `/api/expenses/trips/${trip.id}`).expect(404)).body.error).toBe('Trip not found');
    await put(BOB, `/api/expenses/trips/${trip.id}`, { purpose: 'x' }).expect(404);
    expect((await get(BOB, '/api/expenses/trips')).body.trips).toEqual([]);
    expect((await get(BOB, `/api/expenses/trips?employee_id=${anna}`)).status).toBe(403);
    expect((await get(BOSS, '/api/expenses/trips')).body.trips.map((t: { id: number }) => t.id)).toEqual([trip.id]);
    // The office records for someone, and the row names who did.
    const forBob = await post(BOSS, '/api/expenses/trips', { ...TRIP, employee_id: bob }).expect(201);
    expect(forBob.body).toMatchObject({ employee_id: bob, created_by: 'david@0815software.example' });
  });

  it('view, without an employee record, sees nothing and writes nothing', async () => {
    await post(ANNA, '/api/expenses/trips', TRIP).expect(201);
    expect((await get(VIEWER, '/api/expenses/trips')).body.trips).toEqual([]);
    expect((await get(VIEWER, '/api/expenses/claims')).body.claims).toEqual([]);
    await post(VIEWER, '/api/expenses/trips', TRIP).expect(403);
  });
});

describe('a receipt', () => {
  it('typed in: the VAT lines add up to the amount; net and VAT are derived', async () => {
    const res = await post(ANNA, '/api/expenses/receipts', {
      merchant: 'Hotel am Domplatz',
      category: 'accommodation',
      receipt_date: '2026-10-05',
      gross_cents: 11800,
      vat_lines: [
        { rate_bp: 1000, gross_cents: 9900 },
        { rate_bp: 2000, gross_cents: 1900 },
      ],
    }).expect(201);
    // 9900 / 1,10 = 9000; 1900 / 1,20 = 1583,33 → 1583.
    expect(res.body).toMatchObject({ net_cents: 10583, vat_cents: 1217, reimbursable_cents: 11800, source: 'manual', file_missing: true });
    const off = await post(ANNA, '/api/expenses/receipts', { merchant: 'X', receipt_date: '2026-10-05', gross_cents: 1000, vat_lines: [{ rate_bp: 2000, gross_cents: 900 }] }).expect(422);
    expect(off.body.details).toEqual([{ field: 'vat_lines', message: 'The VAT lines add up to a different amount than the receipt' }]);
    const future = await post(ANNA, '/api/expenses/receipts', { merchant: 'X', receipt_date: '2999-01-01', gross_cents: 1000 }).expect(422);
    expect(future.body.details[0].message).toBe('A receipt is dated on or before today');
  });

  it('scanned: the till code decides the date, the amount and the rates — the server reads it again', async () => {
    const res = await post(ANNA, '/api/expenses/receipts', {
      merchant: 'Gasthaus Zur Post',
      category: 'meals',
      rksv_code: till('1001', '23,40', '4,80'),
      // What the app thought is not what counts.
      gross_cents: 1,
      receipt_date: '2026-01-01',
    }).expect(201);
    expect(res.body).toMatchObject({
      source: 'rksv',
      receipt_date: '2026-10-05',
      gross_cents: 2820,
      vat_lines: [
        { rate_bp: 2000, gross_cents: 2340 },
        { rate_bp: 1000, gross_cents: 480 },
      ],
      rksv: { cashbox_id: 'GASTHAUS-1', receipt_id: '1001', issued_at: '2026-10-05T12:31:05', signature_failed: false },
    });
  });

  it('the same till receipt is not claimed twice — by the same person or by a colleague', async () => {
    await post(ANNA, '/api/expenses/receipts', { merchant: 'Gasthaus', rksv_code: till('2002') }).expect(201);
    const again = await post(BOB, '/api/expenses/receipts', { merchant: 'Gasthaus', rksv_code: till('2002') }).expect(409);
    // Without saying whose it is.
    expect(again.body.error).toBe('This till receipt is already recorded — the same receipt cannot be claimed twice');
    await post(BOB, '/api/expenses/receipts', { merchant: 'Gasthaus', rksv_code: till('2003') }).expect(201);
  });

  it('a training or cancellation receipt is no purchase; from July 2026 the special rate needs saying', async () => {
    const training = await post(ANNA, '/api/expenses/receipts', { merchant: 'X', rksv_code: till('3001', '23,40', '0,00', '2026-10-05T12:31:05', 'VFJB') }).expect(422);
    expect(training.body.details).toEqual([{ field: 'rksv_code', message: 'A training receipt is not a purchase' }]);
    const special = `_R1-AT1_BOX_3002_2026-10-05T09:00:00_0,00_0,00_0,00_0,00_5,24_lHZnU+ICvLM=_1_cg8hNU5ihto=_${SIG}`;
    const ask = await post(ANNA, '/api/expenses/receipts', { merchant: 'Bäckerei', rksv_code: special }).expect(422);
    expect(ask.body.details[0].field).toBe('special_rate_bp');
    const ok = await post(ANNA, '/api/expenses/receipts', { merchant: 'Bäckerei', rksv_code: special, special_rate_bp: 490 }).expect(201);
    expect(ok.body.vat_lines).toEqual([{ rate_bp: 490, gross_cents: 524 }]);
  });

  it('its picture: sniffed, not trusted; shown only to the person and the office', async () => {
    const receipt = (await post(ANNA, '/api/expenses/receipts', { merchant: 'Taxi', category: 'taxi', receipt_date: '2026-10-05', gross_cents: 2300 }).expect(201)).body;
    expect((await upload(ANNA, receipt.id, Buffer.from('<script>alert(1)</script>')).expect(415)).body.error).toBe('A receipt is a JPEG, PNG or WebP picture, or a PDF');
    const ok = await upload(ANNA, receipt.id, JPEG).expect(200);
    expect(ok.body).toMatchObject({ file: { content_type: 'image/jpeg', size_bytes: JPEG.length }, file_missing: false });
    const file = await get(ANNA, `/api/expenses/receipts/${receipt.id}/file`).buffer(true).expect(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.headers['cache-control']).toBe('private, no-store');
    expect(file.headers['content-security-policy']).toContain('sandbox');
    expect(Buffer.compare(file.body as Buffer, JPEG)).toBe(0);
    await get(BOB, `/api/expenses/receipts/${receipt.id}/file`).expect(404);
    await get(BOSS, `/api/expenses/receipts/${receipt.id}/file`).expect(200);
  });
});

describe('a claim', () => {
  it('gathers items and adds them up; a receipt without its picture holds it back', async () => {
    const { trip, drive, receipt } = await annasItems();
    const bare = (await post(ANNA, '/api/expenses/receipts', { merchant: 'Kiosk', receipt_date: '2026-10-05', gross_cents: 350 }).expect(201)).body;
    const refused = await post(ANNA, '/api/expenses/claims', { trip_ids: [trip.id], receipt_ids: [receipt.id, bare.id] }).expect(422);
    expect(refused.body.details).toEqual([{ field: 'receipt_ids[1]', message: 'The receipt from Kiosk needs its picture' }]);
    // The office may waive pictures below an amount.
    await put(BOSS, '/api/expenses/settings', { file_required_from_cents: 1000 }).expect(200);
    const res = await post(ANNA, '/api/expenses/claims', { trip_ids: [trip.id], mileage_ids: [drive.id], receipt_ids: [receipt.id, bare.id] }).expect(201);
    const year = new Date().getUTCFullYear();
    expect(res.body.claim.number).toMatch(new RegExp(`^SP-(${year}|${year + 1})-0001$`));
    // 185 km by car with one passenger: 92,50 € + 27,75 €.
    expect(drive.amount_cents).toBe(9250 + 2775);
    expect(res.body.claim).toMatchObject({
      status: 'submitted',
      title: 'Expenses 2026-10-05',
      totals: { per_diem_cents: 4500, nights_cents: 1700, mileage_cents: 12025, receipts_cents: 1550, total_cents: 4500 + 1700 + 12025 + 1550 },
      counts: { trips: 1, mileage: 1, receipts: 2 },
      can_decide: false,
      can_withdraw: true,
    });
    expect(res.body.events).toEqual([expect.objectContaining({ type: 'submitted', actor: 'anna@0815software.example', total_cents: 19775 })]);
  });

  it('locks its items: no change, no deletion, no second claim', async () => {
    const { trip, receipt } = await annasClaim();
    expect((await put(ANNA, `/api/expenses/trips/${trip.id}`, { purpose: 'Something else' }).expect(409)).body.error).toMatch(/^This is part of claim SP-\d{4}-0001 \(submitted\) and cannot change$/);
    await request(app).delete(`/api/expenses/trips/${trip.id}`).set('Cookie', ANNA).expect(409);
    await upload(ANNA, receipt.id, JPEG).expect(409);
    const twice = await post(ANNA, '/api/expenses/claims', { trip_ids: [trip.id] }).expect(422);
    expect(twice.body.details[0].message).toMatch(/^Already in claim SP-\d{4}-0001$/);
    expect((await get(ANNA, '/api/expenses/trips')).body.trips[0]).toMatchObject({ locked: true });
    expect((await get(ANNA, '/api/expenses/trips?open=1')).body.trips).toEqual([]);
  });

  it('is decided by manage — never by an editor, and never by the person themselves', async () => {
    const { detail } = await annasClaim();
    const id = detail.claim.id as number;
    await post(ANNA, `/api/expenses/claims/${id}/approve`).expect(403);
    // David manages — and still may not approve his own.
    const davidsTrip = (await post(BOSS, '/api/expenses/trips', { ...TRIP, meals: [], nights_flat: 0 }).expect(201)).body;
    const davids = (await post(BOSS, '/api/expenses/claims', { trip_ids: [davidsTrip.id] }).expect(201)).body.claim;
    expect(davids.can_decide).toBe(false);
    expect((await post(BOSS, `/api/expenses/claims/${davids.id}/approve`).expect(403)).body.error).toBe('Nobody decides their own claim');
    const approved = await post(BOSS, `/api/expenses/claims/${id}/approve`).expect(200);
    expect(approved.body.claim).toMatchObject({ status: 'approved', decided_by: 'david@0815software.example', payout_mode: 'payroll', can_mark_paid: true });
    await post(BOSS, `/api/expenses/claims/${id}/approve`).expect(409);
    // Anna hears of it.
    expect(sent).toEqual([expect.objectContaining({ to: 'anna@0815software.example', subject: `Your expense claim ${detail.claim.number} is approved` })]);
    expect(sent[0]!.body).toContain('194,25 €');
  });

  it('keeps the price it was submitted at, whatever the rates do afterwards', async () => {
    const { detail } = await annasClaim();
    await post(BOSS, '/api/expenses/rates', { kind: 'per_diem_domestic', valid_from: '2026-01-01', amount_cents: 6000 }).expect(201);
    await post(BOSS, '/api/expenses/rates', { kind: 'mileage_car', valid_from: '2026-01-01', amount_cents: 100 }).expect(201);
    const after = (await get(ANNA, `/api/expenses/claims/${detail.claim.id}`)).body;
    expect(after.claim.totals).toEqual(detail.claim.totals);
    expect(after.trips[0].per_diem_cents).toBe(4500);
    // A trip not yet claimed is priced with what is known now.
    expect((await post(ANNA, '/api/expenses/trips', { ...TRIP, meals: [], nights_flat: 0 }).expect(201)).body.per_diem_cents).toBe(12000);
  });

  it('returned with a reason: the items are free again, the claim keeps what it asked for', async () => {
    const { trip, detail } = await annasClaim();
    const id = detail.claim.id as number;
    expect((await post(BOSS, `/api/expenses/claims/${id}/reject`).expect(422)).body.details).toEqual([{ field: 'note', message: 'A returned claim says why' }]);
    await post(BOSS, `/api/expenses/claims/${id}/reject`, { note: 'Lunch was paid by the client' }).expect(200);
    expect(sent.at(-1)).toMatchObject({ subject: `Your expense claim ${detail.claim.number} was returned` });
    // Corrected: the lunch is gone, so the second day is a full 30 €.
    const fixed = await put(ANNA, `/api/expenses/trips/${trip.id}`, { meals: [] }).expect(200);
    expect(fixed.body.per_diem_cents).toBe(6000);
    const again = await post(ANNA, '/api/expenses/claims', { trip_ids: [trip.id] }).expect(201);
    expect(again.body.claim.number).toMatch(/-0002$/);
    // The returned claim still lists the trip, and its events still say what it asked for.
    const old = (await get(ANNA, `/api/expenses/claims/${id}`)).body;
    expect(old.claim.status).toBe('rejected');
    expect(old.trips.map((t: { id: number }) => t.id)).toEqual([trip.id]);
    expect(old.events.map((e: { type: string; total_cents: number }) => [e.type, e.total_cents])).toEqual([
      ['submitted', 19425],
      ['rejected', 19425],
    ]);
    // And an item that was ever claimed stays on record.
    await request(app).delete(`/api/expenses/trips/${trip.id}`).set('Cookie', ANNA).expect(409);
  });

  it('can be withdrawn by its person while it waits', async () => {
    const { detail } = await annasClaim();
    await post(BOB, `/api/expenses/claims/${detail.claim.id}/withdraw`).expect(404);
    expect((await post(ANNA, `/api/expenses/claims/${detail.claim.id}/withdraw`).expect(200)).body.claim.status).toBe('withdrawn');
    await post(BOSS, `/api/expenses/claims/${detail.claim.id}/approve`).expect(409);
    expect((await get(ANNA, '/api/expenses/trips?open=1')).body.trips).toHaveLength(1);
  });

  it('tells the office of a new claim when it asks to be told', async () => {
    await put(BOSS, '/api/expenses/settings', { notify_on_submit: ['Office@0815software.example'] }).expect(200);
    const { detail } = await annasClaim();
    expect(sent).toEqual([expect.objectContaining({ to: 'office@0815software.example', subject: `Expense claim ${detail.claim.number} to decide` })]);
  });
});

describe('paid with the salary', () => {
  it('the export lists approved claims split as the payslip shows them; then "paid"', async () => {
    const { detail } = await annasClaim();
    await post(BOSS, `/api/expenses/claims/${detail.claim.id}/approve`).expect(200);
    await get(ANNA, '/api/expenses/export.csv').expect(403);
    const csv = (await get(BOSS, '/api/expenses/export.csv').expect(200)).text;
    const [head, row] = csv.trimEnd().split('\r\n');
    expect(head).toBe('Claim;Employee;Email;Title;Submitted;Approved;Approved by;Per diem;Night allowance;Mileage;Receipts;Total;Status;Paid reference');
    expect(row!.split(';').slice(0, 2)).toEqual([detail.claim.number, 'Anna Berger']);
    expect(row!.split(';').slice(7, 13)).toEqual(['45,00', '17,00', '120,25', '12,00', '194,25', 'approved']);
    const paid = await post(BOSS, `/api/expenses/claims/${detail.claim.id}/paid`, { reference: 'Lohn 10/2026' }).expect(200);
    expect(paid.body.claim).toMatchObject({ status: 'paid', paid_ref: 'Lohn 10/2026' });
    expect((await get(BOSS, '/api/expenses/export.csv')).text.trimEnd().split('\r\n')).toHaveLength(1);
    expect((await get(BOSS, '/api/expenses/export.csv?status=paid')).text).toContain('Lohn 10/2026');
    await post(BOSS, `/api/expenses/claims/${detail.claim.id}/paid`).expect(409);
  });
});

describe('paid by bank transfer, through the invoicing module', () => {
  const IBAN = 'AT61 1904 3002 3457 3201';

  async function approvedForTransfer() {
    await put(BOSS, '/api/expenses/settings', { payout_mode: 'invoicing' }).expect(200);
    const { detail } = await annasClaim();
    await post(BOSS, `/api/expenses/claims/${detail.claim.id}/approve`).expect(200);
    return detail.claim as { id: number; number: string };
  }

  it('the person gives their account; a typo is caught; every change is told to them', async () => {
    const wrong = await put(ANNA, '/api/expenses/bank-account', { holder: 'Anna Berger', iban: 'AT61 1904 3002 3457 3202' }).expect(422);
    expect(wrong.body.details).toEqual([{ field: 'iban', message: 'The check digits do not match — check for a typo' }]);
    await put(BOB, '/api/expenses/bank-account', { employee_id: anna, holder: 'Bob', iban: IBAN }).expect(404);
    const res = await put(ANNA, '/api/expenses/bank-account', { holder: 'Anna Berger', iban: IBAN }).expect(200);
    expect(res.body.account).toMatchObject({ holder: 'Anna Berger', iban: 'AT611904300234573201', actor: 'anna@0815software.example' });
    expect(sent.at(-1)).toMatchObject({ to: 'anna@0815software.example', subject: 'The account your expenses are paid to has changed' });
    expect(sent.at(-1)!.body).toContain('AT61 **** **** **** 3201');
  });

  it('the transfer: only with the machine token, only approved, only with an account, adding up', async () => {
    const claim = await approvedForTransfer();
    await request(app).get(`/api/transfer/expense-claims/${claim.number}`).expect(401);
    expect((await machine('get', `/api/transfer/expense-claims/${claim.number}`).expect(409)).body.error).toMatch(/has no bank account on file/);
    await put(ANNA, '/api/expenses/bank-account', { holder: 'Anna Berger', iban: IBAN }).expect(200);
    expect((await machine('get', '/api/transfer/expense-claims').expect(200)).body.claims).toEqual([
      expect.objectContaining({ number: claim.number, employee_name: 'Anna Berger', total_cents: 19425, has_bank_account: true }),
    ]);
    const t = (await machine('get', `/api/transfer/expense-claims/${claim.number}`).expect(200)).body;
    expect(t).toMatchObject({ version: 1, source: 'mod-11-time-tracking', number: claim.number, currency: 'EUR', payee: { holder: 'Anna Berger', iban: 'AT611904300234573201', bic: null } });
    expect(t.lines.map((l: { kind: string; amount_cents: number }) => [l.kind, l.amount_cents])).toEqual([
      ['per_diem', 4500],
      ['nights', 1700],
      ['mileage', 12025],
      ['receipt', 1200],
    ]);
    expect(t.lines.reduce((a: number, l: { amount_cents: number }) => a + l.amount_cents, 0)).toBe(t.totals.total_cents);
    expect(t.lines[3].vat_lines).toEqual([{ rate_bp: 2000, gross_cents: 1200 }]);
  });

  it('handed over once, paid once — and never also by hand', async () => {
    const claim = await approvedForTransfer();
    await machine('post', `/api/transfer/expense-claims/${claim.number}/handed-over`, { reference: 'ER-2026-0042' }).expect(422);
    await machine('post', `/api/transfer/expense-claims/${claim.number}/handed-over`, { reference: 'ER-2026-0042', actor: 'buchhaltung@0815software.example' }).expect(200);
    await machine('post', `/api/transfer/expense-claims/${claim.number}/handed-over`, { reference: 'ER-2026-0042', actor: 'buchhaltung@0815software.example' }).expect(200);
    await machine('post', `/api/transfer/expense-claims/${claim.number}/handed-over`, { reference: 'ER-2026-0043', actor: 'buchhaltung@0815software.example' }).expect(409);
    expect((await get(BOSS, '/api/expenses/handover')).body.claims).toEqual([]);
    expect((await post(BOSS, `/api/expenses/claims/${claim.id}/paid`).expect(409)).body.error).toBe(`This claim was handed to invoicing as ER-2026-0042 and is marked paid when that bill is`);
    await machine('post', `/api/transfer/expense-claims/${claim.number}/paid`, { bill: 'ER-2026-0099', reference: 'PR-7', actor: 'buchhaltung@0815software.example' }).expect(409);
    const paid = await machine('post', `/api/transfer/expense-claims/${claim.number}/paid`, { bill: 'ER-2026-0042', reference: 'PR-7', actor: 'buchhaltung@0815software.example' }).expect(200);
    expect(paid.body.status).toBe('paid');
    await machine('post', `/api/transfer/expense-claims/${claim.number}/paid`, { bill: 'ER-2026-0042', reference: 'PR-7', actor: 'buchhaltung@0815software.example' }).expect(200);
    const detail = (await get(ANNA, `/api/expenses/claims/${claim.id}`)).body;
    expect(detail.events.map((e: { type: string; actor: string }) => [e.type, e.actor])).toEqual([
      ['submitted', 'anna@0815software.example'],
      ['approved', 'david@0815software.example'],
      ['handed_over', 'buchhaltung@0815software.example'],
      ['paid', 'buchhaltung@0815software.example'],
    ]);
    expect(sent.at(-1)).toMatchObject({ subject: `Your expense claim ${claim.number} is paid` });
    // A claim the office set to payroll is never handed over.
    await put(BOSS, '/api/expenses/settings', { payout_mode: 'payroll' }).expect(200);
    const second = await annasClaim();
    await post(BOSS, `/api/expenses/claims/${second.detail.claim.id}/approve`).expect(200);
    expect((await machine('get', `/api/transfer/expense-claims/${second.detail.claim.number}`).expect(409)).body.error).toMatch(/paid with the salary/);
  });
});

describe('the person stays with their expenses', () => {
  it('an employee with expense records cannot be deleted', async () => {
    await post(ANNA, '/api/expenses/trips', TRIP).expect(201);
    db.exec(`DELETE FROM time_entries WHERE employee_id = ${anna}; DELETE FROM leave_events WHERE request_id IN (SELECT id FROM leave_requests WHERE employee_id = ${anna}); DELETE FROM leave_requests WHERE employee_id = ${anna}; DELETE FROM leave_entitlements WHERE employee_id = ${anna}; DELETE FROM work_schedules WHERE employee_id = ${anna}; DELETE FROM flex_entries WHERE employee_id = ${anna}; DELETE FROM timer_events WHERE employee_id = ${anna}; DELETE FROM timers WHERE employee_id = ${anna}; DELETE FROM reminders_sent WHERE employee_id = ${anna}; UPDATE tasks SET assignee_id = NULL WHERE assignee_id = ${anna}; DELETE FROM timesheet_events WHERE employee_id = ${anna}; DELETE FROM timesheets WHERE employee_id = ${anna};`);
    expect((await request(app).delete(`/api/employees/${anna}`).set('Cookie', BOSS).expect(409)).body.error).toBe('Employee has expense records and cannot be deleted');
  });
});
