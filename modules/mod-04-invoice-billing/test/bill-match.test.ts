import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import { noopPlatform, OfferFetchError, type InvoicedLine, type PlatformHooks } from '../server/platform.js';
import type { BillRow, MatchLineVerdict, MatchVerdict } from '../shared/types.js';

/**
 * The three-way match, the paying side (server/bill-match.ts): a bill naming
 * a MOD-06 purchase order is paid only when MOD-06 says what was ordered and
 * received covers what has been invoiced against it so far. Every answer is
 * kept; an outage keeps the last one; a manager may release a held verdict
 * with a reason, and the release covers that verdict only.
 *
 * MOD-06 is a fake here that answers like the real one (its own suite,
 * test/receiving.test.ts, pins the verdicts): 1,000 € received on PO-2026-0007,
 * 2,000 € ordered, no tolerance.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 'test-secret', ttlHours: 1, secureCookie: false };
const seller: SellerConfig = {
  name: '0815software GmbH',
  addressLines: ['Beispielgasse 8/15', '1010 Wien', 'Austria'],
  vatId: 'ATU00000000',
  iban: 'AT61 1904 3002 3457 3201',
  bic: 'GIBAATWWXXX',
};
const as = (access: AccessLevel, actor: string) => `${COOKIE_NAME}=${createToken(auth, actor, Date.now(), access)}`;
const ADMIN = as('manage', 'admin');
const CLERK = as('edit', 'buchhaltung@example.com');

let db: Database.Database;
let app: Express;
let received: number;
let reachable: boolean;
let asked: { po: string; invoiced: number }[];
let askedLines: (InvoicedLine[] | undefined)[];
let lineAnswer: MatchLineVerdict[];
let released: { reason: string }[];

function verdict(po: string, invoiced: number): MatchVerdict {
  const ordered = 200_000;
  const result = invoiced <= received ? 'matched' : invoiced <= ordered ? 'awaiting_receipt' : 'over_invoiced';
  return {
    po_number: po,
    supplier_name: 'Widget GmbH',
    po_status: 'ordered',
    ordered_cents: ordered,
    received_cents: received,
    invoiced_cents: invoiced,
    tolerance_cents: 0,
    result,
    difference_cents: invoiced - received,
    message: `${result} at ${invoiced}`,
  };
}

const procurement: PlatformHooks = {
  ...noopPlatform,
  procurementConfigured: true,
  async matchInvoice(po, invoiced, lines) {
    asked.push({ po, invoiced });
    askedLines.push(lines);
    if (!reachable) throw new OfferFetchError(502, 'The procurement module is unreachable: ECONNREFUSED');
    if (po !== 'PO-2026-0007') throw new OfferFetchError(404, `There is no purchase order ${po}`);
    // An answer that says no line is an issue while one is: this module counts for itself.
    return { ...verdict(po, invoiced), lines: lineAnswer, line_issues: 0 };
  },
  async matchReleased(info) {
    released.push({ reason: info.reason });
  },
};

let creditor: number;
const addBill = (values: Record<string, unknown>, cookie = ADMIN) =>
  request(app)
    .post('/api/bills')
    .set('Cookie', cookie)
    .send({ creditor_id: creditor, amount_cents: 120_000, due_date: '2026-11-30', ...values });
const bill = async (id: number): Promise<BillRow> => (await request(app).get(`/api/bills/${id}`).set('Cookie', ADMIN).expect(200)).body;
const pay = (ids: number[]) => request(app).post('/api/payment-runs').set('Cookie', ADMIN).send({ bill_ids: ids });

beforeEach(async () => {
  db = openDb(':memory:');
  received = 100_000;
  reachable = true;
  asked = [];
  askedLines = [];
  lineAnswer = [];
  released = [];
  app = createApp({ db, auth, seller, platform: procurement });
  creditor = (await request(app).post('/api/creditors').set('Cookie', ADMIN).send({ name: 'Widget GmbH', iban: 'AT96 2011 1822 0212 0077' }).expect(201)).body.id;
});

describe('a bill for a purchase order', () => {
  it('needs its net amount, never above the gross', async () => {
    expect((await addBill({ reference: 'R-1', po_number: 'PO-2026-0007' }).expect(422)).body.details[0].field).toBe('net_cents');
    await addBill({ reference: 'R-1', po_number: 'PO-2026-0007', net_cents: 130_000 }).expect(422);
  });

  it('is checked when entered, with what has been invoiced against the PO so far', async () => {
    const first = (await addBill({ reference: 'R-1', po_number: 'PO-2026-0007', net_cents: 60_000 }, CLERK).expect(201)).body as BillRow;
    expect(first.match).toMatchObject({ state: 'matched', check: { result: 'matched', invoiced_cents: 60_000, received_cents: 100_000, actor: 'buchhaltung@example.com' } });
    const second = (await addBill({ reference: 'R-2', po_number: 'PO-2026-0007', net_cents: 50_000 }).expect(201)).body as BillRow;
    // 60 + 50 = 1,100 € invoiced against 1,000 € received.
    expect(second.match).toMatchObject({ state: 'held', check: { result: 'awaiting_receipt', invoiced_cents: 110_000 } });
    // The second bill does not change the first one's verdict.
    expect(asked).toEqual([
      { po: 'PO-2026-0007', invoiced: 60_000 },
      { po: 'PO-2026-0007', invoiced: 110_000 },
    ]);
  });

  it('a bill without a PO is not matched; an unknown PO is held', async () => {
    const plain = (await addBill({ reference: 'R-0' }).expect(201)).body as BillRow;
    expect(plain.match.state).toBe('not_linked');
    const unknown = (await addBill({ reference: 'R-9', po_number: 'PO-1999-0001', net_cents: 1 }).expect(201)).body as BillRow;
    expect(unknown.match).toMatchObject({ state: 'held', check: { result: 'unknown_po', message: 'MOD-06 has no purchase order PO-1999-0001' } });
  });
});

describe('the payment run', () => {
  it('refuses a held bill, and pays it once the goods have arrived', async () => {
    const held = (await addBill({ reference: 'R-1', po_number: 'PO-2026-0007', net_cents: 150_000, amount_cents: 180_000 }).expect(201)).body as BillRow;
    const refused = await pay([held.id]).expect(409);
    expect(refused.body.error).toContain('Held by the three-way match — R-1 (PO-2026-0007)');
    received = 200_000;
    await pay([held.id]).expect(201);
    expect((await bill(held.id)).status).toBe('scheduled');
  });

  it('asks again before paying: a matched bill whose goods were taken back is held', async () => {
    const matched = (await addBill({ reference: 'R-1', po_number: 'PO-2026-0007', net_cents: 90_000 }).expect(201)).body as BillRow;
    expect(matched.match.state).toBe('matched');
    received = 50_000; // a correction receipt in MOD-06
    await pay([matched.id]).expect(409);
  });

  it('an outage neither pays a held bill nor holds a matched one — the last answer stands', async () => {
    const matched = (await addBill({ reference: 'R-1', po_number: 'PO-2026-0007', net_cents: 90_000 }).expect(201)).body as BillRow;
    reachable = false;
    const neverChecked = (await addBill({ reference: 'R-2', po_number: 'PO-2026-0007', net_cents: 1 }).expect(201)).body as BillRow;
    expect(neverChecked.match).toMatchObject({ state: 'not_checked', check: null, last_error: { result: 'error' } });
    await pay([neverChecked.id]).expect(409);
    const run = await pay([matched.id]).expect(201);
    expect(run.body.item_count).toBe(1);
    const after = await bill(matched.id);
    expect(after.match).toMatchObject({ state: 'matched', last_error: { message: 'The procurement module is unreachable: ECONNREFUSED' } });
  });

  it('without MOD-06 nothing is asked and nothing held', async () => {
    const standalone = createApp({ db: openDb(':memory:'), auth, seller });
    const c = (await request(standalone).post('/api/creditors').set('Cookie', ADMIN).send({ name: 'W', iban: 'AT96 2011 1822 0212 0077' }).expect(201)).body.id;
    const b = (await request(standalone).post('/api/bills').set('Cookie', ADMIN).send({ creditor_id: c, reference: 'R', amount_cents: 1000, net_cents: 900, po_number: 'PO-X', due_date: '2026-11-30' }).expect(201)).body as BillRow;
    expect(b.match.state).toBe('not_checked');
    await request(standalone).post('/api/payment-runs').set('Cookie', ADMIN).send({ bill_ids: [b.id] }).expect(201);
    await request(standalone).post(`/api/bills/${b.id}/check-match`).set('Cookie', ADMIN).send({}).expect(501);
  });
});

describe('releasing a held bill', () => {
  it('a manager releases it with a reason; it covers that verdict only', async () => {
    const held = (await addBill({ reference: 'R-1', po_number: 'PO-2026-0007', net_cents: 150_000, amount_cents: 180_000 }).expect(201)).body as BillRow;
    await request(app).post(`/api/bills/${held.id}/release-match`).set('Cookie', CLERK).send({ reason: 'x' }).expect(403);
    await request(app).post(`/api/bills/${held.id}/release-match`).set('Cookie', ADMIN).send({}).expect(422);
    const after = (await request(app).post(`/api/bills/${held.id}/release-match`).set('Cookie', ADMIN).send({ reason: 'Freight agreed by phone' }).expect(200)).body as BillRow;
    expect(after.match).toMatchObject({ state: 'released', release: { reason: 'Freight agreed by phone', actor: 'admin' } });
    expect(released).toEqual([{ reason: 'Freight agreed by phone' }]);
    // An edit asks again: the release covered the old verdict, not this one.
    const edited = (
      await request(app).put(`/api/bills/${held.id}`).set('Cookie', ADMIN).send({ creditor_id: creditor, reference: 'R-1', amount_cents: 190_000, net_cents: 160_000, po_number: 'PO-2026-0007', due_date: '2026-11-30' }).expect(200)
    ).body as BillRow;
    expect(edited.match.state).toBe('held');
    await pay([held.id]).expect(409);
    await request(app).post(`/api/bills/${held.id}/release-match`).set('Cookie', ADMIN).send({ reason: 'Price increase confirmed' }).expect(200);
    await pay([held.id]).expect(201);
  });

  it('nothing to release on a matched bill; check again after the goods arrived', async () => {
    const matched = (await addBill({ reference: 'R-1', po_number: 'PO-2026-0007', net_cents: 10 }).expect(201)).body as BillRow;
    await request(app).post(`/api/bills/${matched.id}/release-match`).set('Cookie', ADMIN).send({ reason: 'x' }).expect(409);
    const held = (await addBill({ reference: 'R-2', po_number: 'PO-2026-0007', net_cents: 150_000, amount_cents: 180_000 }).expect(201)).body as BillRow;
    received = 200_000;
    const again = (await request(app).post(`/api/bills/${held.id}/check-match`).set('Cookie', CLERK).send({}).expect(200)).body as BillRow;
    expect(again.match.state).toBe('matched');
    expect(db.prepare('SELECT COUNT(*) AS n FROM bill_match_checks WHERE bill_id = ?').get(held.id)).toEqual({ n: 2 });
  });
});

describe('line by line', () => {
  const line = (over: Partial<MatchLineVerdict>): MatchLineVerdict => ({
    item_id: 'W-1',
    description: 'Widget',
    po_position: 1,
    matched_by: 'sku',
    invoiced_quantity: 4,
    received_quantity: 4,
    ordered_quantity: 10,
    invoiced_net_cents: 20_000,
    invoiced_unit_price_cents: 5000,
    ordered_unit_price_cents: 5000,
    result: 'ok',
    issue: false,
    message: 'Widget (W-1): 4 invoiced, 4 received (PO line 1)',
    ...over,
  });
  const withLines = (reference: string, lines: Record<string, unknown>[], net = 20_000) =>
    addBill({ reference, po_number: 'PO-2026-0007', net_cents: net, lines });

  it('sends the lines invoiced on the PO so far — this bill\'s and the earlier ones — and only when this bill has lines', async () => {
    await withLines('R-1', [{ description: 'Widget', item_id: 'W-1', quantity: 2, net_cents: 10_000 }], 10_000).expect(201);
    await withLines('R-2', [{ description: 'Widget', item_id: 'W-1', quantity: 2, net_cents: 10_000 }], 10_000).expect(201);
    await addBill({ reference: 'R-3', po_number: 'PO-2026-0007', net_cents: 1 }).expect(201);
    expect(askedLines[0]).toEqual([{ item_id: 'W-1', description: 'Widget', quantity: 2, net_cents: 10_000 }]);
    expect(askedLines[1]).toHaveLength(2);
    expect(askedLines[2]).toEqual([]);
  });

  it('a line that does not match holds the bill even when the amount matched; a release covers it', async () => {
    lineAnswer = [line({ description: 'Installation', item_id: null, result: 'awaiting_receipt', issue: true, message: 'Installation: 2 invoiced, 0 received so far (PO line 2)' })];
    const held = (await withLines('R-1', [{ description: 'Installation', quantity: 2, net_cents: 20_000 }]).expect(201)).body as BillRow;
    expect(held.match).toMatchObject({ state: 'held', check: { result: 'matched', line_issues: 1 } });
    expect(held.match.check!.lines[0]).toMatchObject({ result: 'awaiting_receipt', issue: true });
    await pay([held.id]).expect(409);
    await request(app).post(`/api/bills/${held.id}/release-match`).set('Cookie', ADMIN).send({ reason: 'Installed, delivery note follows' }).expect(200);
    await pay([held.id]).expect(201);
  });

  it('once the lines match, the bill is matched', async () => {
    lineAnswer = [line({})];
    const ok = (await withLines('R-1', [{ description: 'Widget', item_id: 'W-1', quantity: 4, net_cents: 20_000 }]).expect(201)).body as BillRow;
    expect(ok.match).toMatchObject({ state: 'matched', check: { line_issues: 0 } });
  });
});
