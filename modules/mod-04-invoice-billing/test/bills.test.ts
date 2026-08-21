import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { todayIso } from '../server/invoices.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import type { BillRow, Creditor, PaymentConfig, PaymentRunDetail } from '../shared/types.js';

/**
 * PAYABLES — the bills, and the bank file that pays them.
 *
 * The properties under test are the ones with money behind them:
 *
 *  - a bill can be in at most one live payment run, so it cannot be paid twice
 *  - a produced file never changes, even when the creditor behind it does
 *  - an unusable own IBAN stops a run before it exists, rather than producing
 *    a file the bank rejects
 *  - the file's control sum is the sum of the bills that went into it
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

/** A configured installation: our own IBAN, and it passes its check digits. */
const seller: SellerConfig = {
  name: '0815software GmbH',
  addressLines: ['Beispielgasse 8/15', '1010 Wien', 'Austria'],
  vatId: 'ATU00000000',
  iban: 'AT61 1904 3002 3457 3201',
  bic: 'GIBAATWWXXX',
};

/** What every module ships with until someone configures it. */
const unconfiguredSeller: SellerConfig = { ...seller, iban: 'AT00 0000 0000 0000 0000', bic: 'EXAMPLEX' };

const CREDITOR_AT = 'AT96 2011 1822 0212 0077';
const CREDITOR_DE = 'DE89370400440532013000';

let db: Database.Database;
let app: Express;
let cookie: string;

async function login(target: Express): Promise<string> {
  const res = await request(target).post('/api/login').send({ username: 'admin', password: 'test-password' });
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

async function addCreditor(values: Record<string, unknown> = {}): Promise<Creditor> {
  const res = await request(app)
    .post('/api/creditors')
    .set('Cookie', cookie)
    .send({ name: 'Stadtwerke Wien Energie GmbH', iban: CREDITOR_AT, bic: 'GIBAATWWXXX', ...values });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Creditor;
}

async function addBill(creditorId: number, values: Record<string, unknown> = {}): Promise<BillRow> {
  const res = await request(app)
    .post('/api/bills')
    .set('Cookie', cookie)
    .send({
      creditor_id: creditorId,
      reference: 'SW-2026-004512',
      amount_cents: 384_20,
      issue_date: '2026-06-02',
      due_date: '2026-06-16',
      ...values,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as BillRow;
}

async function makeRun(billIds: number[], values: Record<string, unknown> = {}): Promise<request.Response> {
  return request(app)
    .post('/api/payment-runs')
    .set('Cookie', cookie)
    .send({ bill_ids: billIds, ...values });
}

/** A run of one bill, asserted to have been created. */
async function runOf(billIds: number[], values: Record<string, unknown> = {}): Promise<PaymentRunDetail> {
  const res = await makeRun(billIds, values);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as PaymentRunDetail;
}

async function bill(id: number): Promise<BillRow> {
  const res = await request(app).get(`/api/bills/${id}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as BillRow;
}

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, auth, seller });
  cookie = await login(app);
});

describe('auth', () => {
  it('closes every payables route without a session', async () => {
    for (const path of ['/api/creditors', '/api/bills', '/api/payment-runs', '/api/payment-config']) {
      expect((await request(app).get(path)).status, path).toBe(401);
    }
    expect((await request(app).post('/api/payment-runs').send({ bill_ids: [1] })).status).toBe(401);
  });
});

describe('creditors', () => {
  it('stores the IBAN normalized, whatever spacing it was typed in', async () => {
    const creditor = await addCreditor({ iban: 'at96 2011 1822 0212 0077' });
    expect(creditor.iban).toBe('AT962011182202120077');
  });

  it('refuses an IBAN that fails its check digits, naming the field', async () => {
    const res = await request(app)
      .post('/api/creditors')
      .set('Cookie', cookie)
      .send({ name: 'Typo GmbH', iban: 'AT96 2011 1822 0212 0078' });
    expect(res.status).toBe(422);
    expect(res.body.details).toEqual([
      { field: 'iban', message: 'IBAN check digits do not match — check for a typo' },
    ]);
  });

  it('refuses an account outside the SEPA area and a malformed BIC', async () => {
    const outside = await request(app)
      .post('/api/creditors')
      .set('Cookie', cookie)
      .send({ name: 'Overseas Inc', iban: 'US64SVBKUS6S3300958879' });
    expect(outside.status).toBe(422);
    expect(outside.body.details[0].message).toContain('not a SEPA scheme country');

    const badBic = await request(app)
      .post('/api/creditors')
      .set('Cookie', cookie)
      .send({ name: 'Bank Typo GmbH', iban: CREDITOR_AT, bic: 'NOPE' });
    expect(badBic.status).toBe(422);
    expect(badBic.body.details[0].field).toBe('bic');
  });

  it('counts what is still owed, and refuses to delete a creditor with bills', async () => {
    const creditor = await addCreditor();
    await addBill(creditor.id);
    await addBill(creditor.id, { reference: 'SW-2026-004600', amount_cents: 100_00 });

    const list = await request(app).get('/api/creditors').set('Cookie', cookie);
    expect(list.body.creditors[0]).toMatchObject({ bill_count: 2, open_cents: 484_20 });

    const del = await request(app).delete(`/api/creditors/${creditor.id}`).set('Cookie', cookie);
    expect(del.status).toBe(409);
  });
});

describe('bills', () => {
  it('derives open / overdue from the due date, and never stores either', async () => {
    const creditor = await addCreditor();
    const overdue = await addBill(creditor.id, { due_date: '2020-01-31' });
    const later = await addBill(creditor.id, { reference: 'SW-2026-9999', due_date: '2999-12-31' });

    expect((await bill(overdue.id)).status).toBe('open');
    expect((await bill(overdue.id)).overdue).toBe(true);
    expect((await bill(later.id)).overdue).toBe(false);

    const columns = (db.prepare('PRAGMA table_info(bills)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain('status');
    expect(columns).not.toContain('overdue');
  });

  it('refuses the same supplier invoice twice — the cheapest way to pay it twice', async () => {
    const creditor = await addCreditor();
    await addBill(creditor.id);
    const again = await request(app)
      .post('/api/bills')
      .set('Cookie', cookie)
      .send({ creditor_id: creditor.id, reference: 'SW-2026-004512', amount_cents: 1_00, due_date: '2026-06-16' });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain('already has a bill with reference');
  });

  it('validates the amount as positive integer cents within the scheme limit', async () => {
    const creditor = await addCreditor();
    for (const amount of [0, -1, 12.5, 100_000_000_000]) {
      const res = await request(app)
        .post('/api/bills')
        .set('Cookie', cookie)
        .send({ creditor_id: creditor.id, reference: `R-${amount}`, amount_cents: amount, due_date: '2026-06-16' });
      expect(res.status, String(amount)).toBe(422);
      expect(res.body.details[0].field).toBe('amount_cents');
    }
  });

  it('requires a due date — a payable with no deadline is a note, not a bill', async () => {
    const creditor = await addCreditor();
    const res = await request(app)
      .post('/api/bills')
      .set('Cookie', cookie)
      .send({ creditor_id: creditor.id, reference: 'R-1', amount_cents: 100 });
    expect(res.status).toBe(422);
    expect(res.body.details.map((d: { field: string }) => d.field)).toContain('due_date');
  });

  it('uses the reference as the payment purpose unless one was given', async () => {
    const creditor = await addCreditor();
    const plain = await addBill(creditor.id);
    expect(plain.payment_reference).toBe('SW-2026-004512');
    const custom = await addBill(creditor.id, {
      reference: 'SW-2026-004999',
      remittance: 'Strom Juli 2026, Kundennummer 4711',
    });
    expect(custom.payment_reference).toBe('Strom Juli 2026, Kundennummer 4711');
  });

  it('settles a bill paid outside the app, and refuses to settle it twice', async () => {
    const creditor = await addCreditor();
    const target = await addBill(creditor.id);
    const paid = await request(app).post(`/api/bills/${target.id}/mark-paid`).set('Cookie', cookie);
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('paid');
    expect((await request(app).post(`/api/bills/${target.id}/mark-paid`).set('Cookie', cookie)).status).toBe(409);
  });

  it('keeps a cancelled bill instead of deleting it', async () => {
    const creditor = await addCreditor();
    const target = await addBill(creditor.id);
    expect((await request(app).post(`/api/bills/${target.id}/cancel`).set('Cookie', cookie)).body.status).toBe(
      'cancelled',
    );
    const list = await request(app).get('/api/bills?status=cancelled').set('Cookie', cookie);
    expect(list.body.bills).toHaveLength(1);
  });

  it('filters by derived status and reports the totals the list adds up to', async () => {
    const creditor = await addCreditor();
    await addBill(creditor.id, { due_date: '2020-01-31' });
    await addBill(creditor.id, { reference: 'B-2', amount_cents: 15_80, due_date: '2999-12-31' });
    const settled = await addBill(creditor.id, { reference: 'B-3', amount_cents: 900_00 });
    await request(app).post(`/api/bills/${settled.id}/mark-paid`).set('Cookie', cookie);

    const res = await request(app).get('/api/bills').set('Cookie', cookie);
    expect(res.body.totals).toMatchObject({
      open_count: 2,
      open_cents: 400_00,
      overdue_count: 1,
      overdue_cents: 384_20,
      scheduled_count: 0,
    });
    const open = await request(app).get('/api/bills?status=open').set('Cookie', cookie);
    expect(open.body.bills).toHaveLength(2);
    const overdue = await request(app).get('/api/bills?overdue=1').set('Cookie', cookie);
    expect(overdue.body.bills.map((b: BillRow) => b.reference)).toEqual(['SW-2026-004512']);
  });

  it('rejects an unknown status filter rather than silently ignoring it', async () => {
    const res = await request(app).get('/api/bills?status=whatever').set('Cookie', cookie);
    expect(res.status).toBe(422);
  });
});

describe('the debtor account', () => {
  it('reports the placeholder IBAN as not ready, naming the variable to set', async () => {
    const unconfigured = createApp({ db: openDb(':memory:'), auth, seller: unconfiguredSeller });
    const res = await request(unconfigured).get('/api/payment-config').set('Cookie', await login(unconfigured));
    const config = res.body as PaymentConfig;
    expect(config.ready).toBe(false);
    expect(config.problem).toContain('SELLER_IBAN');
    expect(config.pain_version).toBe('pain.001.001.03');
  });

  it('refuses to build a run at all while it is unusable', async () => {
    const other = openDb(':memory:');
    const unconfigured = createApp({ db: other, auth, seller: unconfiguredSeller });
    const otherCookie = await login(unconfigured);
    const creditor = await request(unconfigured)
      .post('/api/creditors')
      .set('Cookie', otherCookie)
      .send({ name: 'Stadtwerke', iban: CREDITOR_AT });
    const created = await request(unconfigured)
      .post('/api/bills')
      .set('Cookie', otherCookie)
      .send({ creditor_id: creditor.body.id, reference: 'R-1', amount_cents: 100_00, due_date: '2026-06-16' });

    const res = await request(unconfigured)
      .post('/api/payment-runs')
      .set('Cookie', otherCookie)
      .send({ bill_ids: [created.body.id] });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('SELLER_IBAN');
    // Nothing was written: the bill is still payable once the IBAN is fixed.
    expect((other.prepare('SELECT COUNT(*) AS n FROM payment_runs').get() as { n: number }).n).toBe(0);
  });

  it('reports a configured account as ready', async () => {
    const res = await request(app).get('/api/payment-config').set('Cookie', cookie);
    expect(res.body).toMatchObject({
      ready: true,
      problem: null,
      debtor_iban: 'AT61 1904 3002 3457 3201',
      debtor_bic: 'GIBAATWWXXX',
    });
  });
});

describe('payment runs', () => {
  it('turns bills into one file and hands back what is in it', async () => {
    const energy = await addCreditor();
    const hosting = await addCreditor({ name: 'Hosting Nord GmbH', iban: CREDITOR_DE, bic: null });
    const first = await addBill(energy.id);
    const second = await addBill(hosting.id, { reference: 'RE-2026-0881', amount_cents: 1_188_00 });

    const run = await runOf([first.id, second.id]);
    expect(run.status).toBe('created');
    expect(run.item_count).toBe(2);
    expect(run.total_cents).toBe(384_20 + 1_188_00);
    expect(run.message_id).toMatch(/^MOD04-\d{8}-[0-9A-F]{8}$/);
    expect(run.created_by).toBe('admin');
    expect(run.items.map((i) => i.end_to_end_id)).toEqual([
      `B${first.id}-SW-2026-004512`,
      `B${second.id}-RE-2026-0881`,
    ]);

    // Both bills are now scheduled — the file says they are being paid.
    expect((await bill(first.id)).status).toBe('scheduled');
    expect((await bill(first.id)).payment_run_id).toBe(run.id);
  });

  it('downloads as a pain.001 attachment whose control sum is the bills', async () => {
    const creditor = await addCreditor();
    const first = await addBill(creditor.id);
    const second = await addBill(creditor.id, { reference: 'SW-2026-004600', amount_cents: 15_80 });
    const run = await runOf([first.id, second.id]);

    const res = await request(app).get(`/api/payment-runs/${run.id}/sepa.xml`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="sepa-${run.message_id.toLowerCase()}.xml"`,
    );
    expect(res.text).toContain('urn:iso:std:iso:20022:tech:xsd:pain.001.001.03');
    expect(res.text).toContain(`<MsgId>${run.message_id}</MsgId>`);
    expect(res.text).toContain('<CtrlSum>400.00</CtrlSum>');
    expect(res.text).toContain('<IBAN>AT611904300234573201</IBAN>'); // us, the debtor
    expect(res.text.match(/<CdtTrfTxInf>/g)).toHaveLength(2);
  });

  it('produces the same bytes every time it is downloaded', async () => {
    const creditor = await addCreditor();
    const target = await addBill(creditor.id);
    const run = await runOf([target.id]);

    const first = await request(app).get(`/api/payment-runs/${run.id}/sepa.xml`).set('Cookie', cookie);
    const second = await request(app).get(`/api/payment-runs/${run.id}/sepa.xml`).set('Cookie', cookie);
    expect(second.text).toBe(first.text);
  });

  it('freezes the creditor: correcting an IBAN changes the next run, not the sent one', async () => {
    const creditor = await addCreditor();
    const target = await addBill(creditor.id);
    const run = await runOf([target.id]);
    const before = await request(app).get(`/api/payment-runs/${run.id}/sepa.xml`).set('Cookie', cookie);

    const renamed = await request(app)
      .put(`/api/creditors/${creditor.id}`)
      .set('Cookie', cookie)
      .send({ name: 'Wien Energie GmbH', iban: CREDITOR_DE });
    expect(renamed.status).toBe(200);

    const after = await request(app).get(`/api/payment-runs/${run.id}/sepa.xml`).set('Cookie', cookie);
    expect(after.text).toBe(before.text);
    expect(after.text).toContain('<IBAN>AT962011182202120077</IBAN>');
  });

  it('REFUSES TO PAY A BILL TWICE', async () => {
    const creditor = await addCreditor();
    const target = await addBill(creditor.id);
    await runOf([target.id]);

    const second = await makeRun([target.id]);
    expect(second.status).toBe(409);
    expect(second.body.error).toContain('scheduled');
    expect((db.prepare('SELECT COUNT(*) AS n FROM payment_runs').get() as { n: number }).n).toBe(1);
  });

  it('has a database that refuses it too, whatever the code above does', async () => {
    const creditor = await addCreditor();
    const target = await addBill(creditor.id);
    const run = await runOf([target.id]);
    expect(() =>
      db
        .prepare(
          `INSERT INTO payment_run_items
             (run_id, bill_id, position, end_to_end_id, amount_cents, creditor_name, creditor_iban, remittance, active)
           VALUES (?, ?, 1, 'X', 1, 'X', 'AT962011182202120077', 'X', 1)`,
        )
        .run(run.id + 1, target.id),
    ).toThrow(/idx_run_items_live_bill|UNIQUE/);
  });

  it('leaves a scheduled bill alone: no edit, no delete, no cancel, no manual settle', async () => {
    const creditor = await addCreditor();
    const target = await addBill(creditor.id);
    await runOf([target.id]);

    const edit = await request(app)
      .put(`/api/bills/${target.id}`)
      .set('Cookie', cookie)
      .send({ creditor_id: creditor.id, reference: 'CHANGED', amount_cents: 1_00, due_date: '2026-06-16' });
    expect(edit.status).toBe(409);
    expect(edit.body.error).toContain('discard that run first');
    expect((await request(app).delete(`/api/bills/${target.id}`).set('Cookie', cookie)).status).toBe(409);
    expect((await request(app).post(`/api/bills/${target.id}/cancel`).set('Cookie', cookie)).status).toBe(409);
    expect((await request(app).post(`/api/bills/${target.id}/mark-paid`).set('Cookie', cookie)).status).toBe(409);
  });

  it('refuses a paid or cancelled bill, and an empty selection', async () => {
    const creditor = await addCreditor();
    const paid = await addBill(creditor.id);
    await request(app).post(`/api/bills/${paid.id}/mark-paid`).set('Cookie', cookie);
    expect((await makeRun([paid.id])).status).toBe(409);

    const cancelled = await addBill(creditor.id, { reference: 'B-2' });
    await request(app).post(`/api/bills/${cancelled.id}/cancel`).set('Cookie', cookie);
    expect((await makeRun([cancelled.id])).status).toBe(409);

    expect((await makeRun([])).status).toBe(422);
  });

  it('refuses an execution date in the past — a bank cannot execute backwards', async () => {
    const creditor = await addCreditor();
    const target = await addBill(creditor.id);
    const res = await makeRun([target.id], { execution_date: '2020-01-01' });
    expect(res.status).toBe(422);
    expect(res.body.details[0]).toMatchObject({ field: 'execution_date' });
  });

  it('defaults the execution date to today and accepts a future one', async () => {
    const creditor = await addCreditor();
    const first = await addBill(creditor.id);
    expect((await runOf([first.id])).execution_date).toBe(todayIso());

    const second = await addBill(creditor.id, { reference: 'B-2' });
    expect((await runOf([second.id], { execution_date: '2999-01-31' })).execution_date).toBe('2999-01-31');
  });

  it('pays a bill once even when it is selected twice', async () => {
    const creditor = await addCreditor();
    const target = await addBill(creditor.id);
    const run = await runOf([target.id, target.id]);
    expect(run.item_count).toBe(1);
  });

  it('settles every bill in the run when the bank has executed it', async () => {
    const creditor = await addCreditor();
    const first = await addBill(creditor.id);
    const second = await addBill(creditor.id, { reference: 'B-2', amount_cents: 20_00 });
    const run = await runOf([first.id, second.id]);

    const executed = await request(app).post(`/api/payment-runs/${run.id}/mark-executed`).set('Cookie', cookie);
    expect(executed.status).toBe(200);
    expect(executed.body.status).toBe('executed');
    expect((await bill(first.id)).status).toBe('paid');
    expect((await bill(second.id)).status).toBe('paid');

    // And it stays executed: a second confirmation is a mistake, not a no-op.
    expect((await request(app).post(`/api/payment-runs/${run.id}/mark-executed`).set('Cookie', cookie)).status).toBe(
      409,
    );
    expect((await request(app).post(`/api/payment-runs/${run.id}/discard`).set('Cookie', cookie)).status).toBe(409);
  });

  it('releases the bills when a run is discarded, and never reuses its MsgId', async () => {
    const creditor = await addCreditor();
    const target = await addBill(creditor.id);
    const first = await runOf([target.id]);

    const discarded = await request(app).post(`/api/payment-runs/${first.id}/discard`).set('Cookie', cookie);
    expect(discarded.status).toBe(200);
    expect(discarded.body.status).toBe('discarded');
    expect((await bill(target.id)).status).toBe('open');

    const second = await runOf([target.id]);
    expect(second.message_id).not.toBe(first.message_id);
    // The discarded run is kept: "we made this file and did not use it" is
    // exactly what someone needs to see when a payment goes missing.
    const list = await request(app).get('/api/payment-runs').set('Cookie', cookie);
    expect(list.body.runs.map((r: { status: string }) => r.status).sort()).toEqual(['created', 'discarded']);
  });

  it('keeps a bill that was ever in a run, even a discarded one', async () => {
    const creditor = await addCreditor();
    const target = await addBill(creditor.id);
    const run = await runOf([target.id]);
    await request(app).post(`/api/payment-runs/${run.id}/discard`).set('Cookie', cookie);

    const res = await request(app).delete(`/api/bills/${target.id}`).set('Cookie', cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('cancel it instead');
  });

  it('names the bill, not an array index, when a creditor is unpayable', async () => {
    const creditor = await addCreditor();
    const target = await addBill(creditor.id);
    // Only reachable by editing the database — the API validates on entry —
    // and exactly what an imported or hand-fixed row could look like.
    db.prepare('UPDATE creditors SET iban = ? WHERE id = ?').run('AT962011182202120078', creditor.id);

    const res = await makeRun([target.id]);
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe(`bill:${target.id}.creditor_iban`);
    expect(res.body.details[0].message).toContain('SW-2026-004512');
  });

  it('404s on a run that does not exist', async () => {
    expect((await request(app).get('/api/payment-runs/999').set('Cookie', cookie)).status).toBe(404);
    expect((await request(app).get('/api/payment-runs/999/sepa.xml').set('Cookie', cookie)).status).toBe(404);
  });
});
