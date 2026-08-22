import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { noopPlatform, type BankOrderResult, type PaymentRunSubmission, type PlatformHooks } from '../server/platform.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import type { BillRow, Creditor, PaymentRunDetail } from '../shared/types.js';

/**
 * "Send via EBICS" — the payables run handed to PS-12 Banking instead of to a
 * human with a browser.
 *
 * Three properties, in the order they matter:
 *
 * 1. **The download never goes away.** With `BANKING_URL` unset this module
 *    behaves exactly as it did before, including refusing the submit route
 *    with a message that says what to do instead.
 * 2. **The bytes sent are the bytes downloaded.** Both come from
 *    `paymentRunXml`, rebuilt from the same frozen snapshot, so "what did I
 *    send?" and "what can I download?" cannot diverge.
 * 3. **A refusal releases the bills; a broken conversation does not.** The
 *    bank saying no means nobody acted on the file. The connection dropping
 *    means nobody KNOWS, and releasing bills whose file may be in a bank's
 *    queue is how the same invoice gets paid twice.
 */

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
  iban: 'AT61 1904 3002 3457 3201',
  bic: 'GIBAATWWXXX',
};

/** A stand-in for PS-12 that records what it was asked to send. */
function stubBanking(reply: (run: PaymentRunSubmission) => BankOrderResult): {
  hooks: PlatformHooks;
  sent: PaymentRunSubmission[];
  orders: Map<string, BankOrderResult>;
} {
  const sent: PaymentRunSubmission[] = [];
  const orders = new Map<string, BankOrderResult>();
  const hooks: PlatformHooks = {
    ...noopPlatform,
    async submitPaymentRun(run) {
      sent.push(run);
      const result = reply(run);
      if (result !== null) orders.set(result.orderId, result);
      return result;
    },
    async bankOrderStatus(orderId) {
      return orders.get(orderId) ?? null;
    },
  };
  return { hooks, sent, orders };
}

const accepted = (): BankOrderResult => ({ orderId: 'ord_abc', status: 'accepted', message: null });

let db: Database.Database;
let app: Express;
let cookie: string;

async function login(target: Express): Promise<string> {
  const res = await request(target).post('/api/login').send({ username: 'admin', password: 'test-password' });
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

/** Build an app with a given banking posture, and log in against it. */
async function boot(options: {
  hooks?: PlatformHooks;
  configured?: boolean;
  austrianRemittance?: { TAXS: RegExp | null; CPPP: RegExp | null };
} = {}): Promise<void> {
  db = openDb(':memory:');
  app = createApp({
    db,
    auth,
    seller,
    platform: options.hooks ?? noopPlatform,
    bankingConfigured: options.configured ?? options.hooks !== undefined,
    ...(options.austrianRemittance === undefined ? {} : { austrianRemittance: options.austrianRemittance }),
  });
  cookie = await login(app);
}

async function addBill(values: Record<string, unknown> = {}): Promise<BillRow> {
  const creditor = (
    await request(app)
      .post('/api/creditors')
      .set('Cookie', cookie)
      .send({ name: 'Stadtwerke Wien Energie GmbH', iban: 'AT96 2011 1822 0212 0077', bic: 'GIBAATWWXXX' })
  ).body as Creditor;
  const res = await request(app)
    .post('/api/bills')
    .set('Cookie', cookie)
    .send({
      creditor_id: creditor.id,
      reference: `SW-${Math.random().toString(36).slice(2, 8)}`,
      amount_cents: 384_20,
      issue_date: '2026-06-02',
      due_date: '2026-06-16',
      ...values,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as BillRow;
}

async function makeRun(): Promise<PaymentRunDetail> {
  const created = await addBill();
  const res = await request(app)
    .post('/api/payment-runs')
    .set('Cookie', cookie)
    .send({ bill_ids: [created.id] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as PaymentRunDetail;
}

const submit = (id: number) => request(app).post(`/api/payment-runs/${id}/submit`).set('Cookie', cookie).send({});
const runDetail = async (id: number): Promise<PaymentRunDetail> =>
  (await request(app).get(`/api/payment-runs/${id}`).set('Cookie', cookie).expect(200)).body as PaymentRunDetail;
const billRow = async (id: number): Promise<BillRow> =>
  (await request(app).get(`/api/bills/${id}`).set('Cookie', cookie).expect(200)).body as BillRow;

// ── Standalone: nothing changes ───────────────────────────────────────

describe('with no bank connection configured', () => {
  beforeEach(async () => {
    await boot();
  });

  it('says so on the payables config, so the UI offers no button', async () => {
    const res = await request(app).get('/api/payment-config').set('Cookie', cookie).expect(200);
    expect(res.body.banking_configured).toBe(false);
    expect(res.body.ready).toBe(true);
  });

  it('refuses the submit route and names the alternative', async () => {
    const run = await makeRun();
    const res = await submit(run.id).expect(409);
    expect(res.body.error).toMatch(/download the file/i);
    // Nothing changed: the run is still exactly as downloadable as it was.
    expect((await runDetail(run.id)).status).toBe('created');
  });

  it('still downloads the file, unchanged', async () => {
    const run = await makeRun();
    const res = await request(app).get(`/api/payment-runs/${run.id}/sepa.xml`).set('Cookie', cookie).expect(200);
    expect(res.text).toContain(`<MsgId>${run.message_id}</MsgId>`);
  });
});

// ── The happy path ────────────────────────────────────────────────────

describe('sending a run to the bank', () => {
  it('sends the file, and the run becomes `submitted`', async () => {
    const stub = stubBanking(accepted);
    await boot({ hooks: stub.hooks });
    const run = await makeRun();

    const res = await submit(run.id).expect(200);
    expect(res.body.status).toBe('submitted');
    expect(res.body.banking_order_id).toBe('ord_abc');
    expect(res.body.bank_status).toBe('accepted');
    expect(res.body.submitted_at).not.toBeNull();
    expect(stub.sent).toHaveLength(1);
  });

  it('sends exactly the bytes the download serves', async () => {
    const stub = stubBanking(accepted);
    await boot({ hooks: stub.hooks });
    const run = await makeRun();

    const downloaded = await request(app)
      .get(`/api/payment-runs/${run.id}/sepa.xml`)
      .set('Cookie', cookie)
      .expect(200);
    await submit(run.id).expect(200);

    // Byte-identical. An operator who has to fall back to uploading by hand
    // must be uploading the same file the bank already saw.
    expect(stub.sent[0]!.xml).toBe(downloaded.text);
    expect(stub.sent[0]!.messageId).toBe(run.message_id);
  });

  it('leaves the bills scheduled — a file taken is not a bill paid', async () => {
    const stub = stubBanking(accepted);
    await boot({ hooks: stub.hooks });
    const run = await makeRun();
    const billId = run.items[0]!.bill_id;

    await submit(run.id).expect(200);

    expect((await billRow(billId)).status).toBe('scheduled');
    expect((await billRow(billId)).paid_at).toBeNull();
  });

  it('can still be marked executed once the bank has actually paid it', async () => {
    const stub = stubBanking(accepted);
    await boot({ hooks: stub.hooks });
    const run = await makeRun();
    const billId = run.items[0]!.bill_id;
    await submit(run.id).expect(200);

    const res = await request(app)
      .post(`/api/payment-runs/${run.id}/mark-executed`)
      .set('Cookie', cookie)
      .send({})
      .expect(200);
    expect(res.body.status).toBe('executed');
    expect((await billRow(billId)).status).toBe('paid');
  });

  it('refuses a second submission of the same run', async () => {
    const stub = stubBanking(accepted);
    await boot({ hooks: stub.hooks });
    const run = await makeRun();
    await submit(run.id).expect(200);

    const res = await submit(run.id).expect(409);
    expect(res.body.error).toMatch(/already sent/i);
    // The local refusal is the point: PS-12 would deduplicate anyway, but the
    // run must not even reach the service that would sign it.
    expect(stub.sent).toHaveLength(1);
  });

  it('cannot be discarded once it is with the bank', async () => {
    const stub = stubBanking(accepted);
    await boot({ hooks: stub.hooks });
    const run = await makeRun();
    const billId = run.items[0]!.bill_id;
    await submit(run.id).expect(200);

    // Discarding releases the bills, and releasing bills whose file is in a
    // bank's queue is how the same invoice gets paid twice.
    await request(app).post(`/api/payment-runs/${run.id}/discard`).set('Cookie', cookie).send({}).expect(409);
    expect((await billRow(billId)).status).toBe('scheduled');
  });

  it('carries the run’s MsgId as the idempotency key, end to end', async () => {
    let seenKey = '';
    const stub = stubBanking((run) => {
      seenKey = run.messageId;
      return accepted();
    });
    await boot({ hooks: stub.hooks });
    const run = await makeRun();
    await submit(run.id).expect(200);
    // The service turns this into `payment-run:<MsgId>`; what matters here is
    // that the value the bank keys its own duplicate check on is what travels.
    expect(seenKey).toBe(run.message_id);
  });
});

// ── When the bank says no ─────────────────────────────────────────────

describe('when the bank refuses the file', () => {
  it('marks the run rejected and releases its bills', async () => {
    const stub = stubBanking(() => ({ orderId: 'ord_no', status: 'rejected', message: 'the bank refused this order' }));
    await boot({ hooks: stub.hooks });
    const run = await makeRun();
    const billId = run.items[0]!.bill_id;

    const res = await submit(run.id).expect(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.bank_message).toMatch(/refused/);

    // Nobody acted on the file, so the bills are payable again — and a new run
    // gets a new MsgId, which is what the bank's duplicate check requires.
    expect((await billRow(billId)).status).toBe('open');
  });

  it('lets a corrected run be built from the released bills', async () => {
    const stub = stubBanking((run) =>
      run.messageId.endsWith('X')
        ? accepted()
        : { orderId: `ord_${stub.sent.length}`, status: 'rejected', message: 'wrong debtor' },
    );
    await boot({ hooks: stub.hooks });
    const first = await makeRun();
    const billId = first.items[0]!.bill_id;
    await submit(first.id).expect(200);

    const second = await request(app)
      .post('/api/payment-runs')
      .set('Cookie', cookie)
      .send({ bill_ids: [billId] })
      .expect(201);
    expect(second.body.message_id).not.toBe(first.message_id);
  });
});

// ── When the conversation breaks ──────────────────────────────────────

describe('when the conversation with the bank breaks', () => {
  it('keeps the bills scheduled, because the outcome is unknown', async () => {
    const stub = stubBanking(() => ({
      orderId: 'ord_?',
      status: 'failed',
      message: 'the bank’s response could not be verified',
    }));
    await boot({ hooks: stub.hooks });
    const run = await makeRun();
    const billId = run.items[0]!.bill_id;

    const res = await submit(run.id).expect(200);
    // `submitted`, not `rejected`: we handed it over and do not know what
    // happened. The stored bank_status is what makes the screen say so.
    expect(res.body.status).toBe('submitted');
    expect(res.body.bank_status).toBe('failed');
    expect((await billRow(billId)).status).toBe('scheduled');
  });

  it('surfaces a thrown error rather than swallowing it', async () => {
    const hooks: PlatformHooks = {
      ...noopPlatform,
      async submitPaymentRun() {
        throw new Error('connect ECONNREFUSED');
      },
    };
    await boot({ hooks, configured: true });
    const run = await makeRun();

    // Every other platform hook is best-effort. This one IS the operation: an
    // error swallowed into a warning would leave an operator believing a
    // payment was sent.
    const res = await submit(run.id);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await runDetail(run.id)).status).toBe('created');
  });
});

// ── Refreshing ────────────────────────────────────────────────────────

describe('refreshing a run’s bank status', () => {
  it('settles the run and its bills when the bank reports the money moved', async () => {
    const stub = stubBanking(accepted);
    await boot({ hooks: stub.hooks });
    const run = await makeRun();
    const billId = run.items[0]!.bill_id;
    await submit(run.id).expect(200);
    expect((await billRow(billId)).status).toBe('scheduled');

    // A pain.002 with ACSC arrived at PS-12 — the whole point of the download
    // half. Nobody has to come back and press "mark executed".
    stub.orders.set('ord_abc', { orderId: 'ord_abc', status: 'settled', message: null });
    const res = await request(app)
      .post(`/api/payment-runs/${run.id}/refresh`)
      .set('Cookie', cookie)
      .send({})
      .expect(200);

    expect(res.body.status).toBe('executed');
    expect(res.body.bank_status).toBe('settled');
    expect((await billRow(billId)).status).toBe('paid');
  });

  it('does not re-settle a run someone already marked executed', async () => {
    const stub = stubBanking(accepted);
    await boot({ hooks: stub.hooks });
    const run = await makeRun();
    await submit(run.id).expect(200);
    const marked = await request(app)
      .post(`/api/payment-runs/${run.id}/mark-executed`)
      .set('Cookie', cookie)
      .send({})
      .expect(200);

    stub.orders.set('ord_abc', { orderId: 'ord_abc', status: 'settled', message: null });
    const res = await request(app)
      .post(`/api/payment-runs/${run.id}/refresh`)
      .set('Cookie', cookie)
      .send({})
      .expect(200);

    // Same timestamp: the settlement is recorded, the execution is not redone.
    expect(res.body.status).toBe('executed');
    expect(res.body.executed_at).toBe(marked.body.executed_at);
  });

  it('folds a later rejection in, and releases the bills', async () => {
    const stub = stubBanking(accepted);
    await boot({ hooks: stub.hooks });
    const run = await makeRun();
    const billId = run.items[0]!.bill_id;
    await submit(run.id).expect(200);
    expect((await billRow(billId)).status).toBe('scheduled');

    // The bank changed its mind — which is what a pain.002 status report is
    // for, and phase 6 will deliver automatically.
    stub.orders.set('ord_abc', { orderId: 'ord_abc', status: 'rejected', message: 'account closed' });
    const res = await request(app)
      .post(`/api/payment-runs/${run.id}/refresh`)
      .set('Cookie', cookie)
      .send({})
      .expect(200);

    expect(res.body.status).toBe('rejected');
    expect((await billRow(billId)).status).toBe('open');
  });

  it('refuses to refresh a run that was never sent', async () => {
    const stub = stubBanking(accepted);
    await boot({ hooks: stub.hooks });
    const run = await makeRun();
    const res = await request(app)
      .post(`/api/payment-runs/${run.id}/refresh`)
      .set('Cookie', cookie)
      .send({})
      .expect(409);
    expect(res.body.error).toMatch(/never sent/i);
  });
});

// ── Auth ──────────────────────────────────────────────────────────────

describe('auth', () => {
  it('closes the new routes without a session', async () => {
    const stub = stubBanking(accepted);
    await boot({ hooks: stub.hooks });
    const run = await makeRun();
    expect((await request(app).post(`/api/payment-runs/${run.id}/submit`).send({})).status).toBe(401);
    expect((await request(app).post(`/api/payment-runs/${run.id}/refresh`).send({})).status).toBe(401);
    expect(stub.sent).toEqual([]);
  });
});

// ── The two Austrian special transfers, end to end ────────────────────

describe('Finanzamtszahlung and Postbarzahlung', () => {
  // The specification's own worked example: 11/08 wage tax, employer
  // contribution and surcharge; a 10/08 VAT credit. `269135729` is its
  // documented tax account number, check digit and all.
  const TAX_REMITTANCE = '0811+676850L+176800DB+23601DZ0810-563910U';
  const TAX_ACCOUNT = '269135729';
  const CPPP_REMITTANCE = 'K3?1234?Hirschdorf?Karl-Christian Lorenzpl.12?Heizkostenzuschuss';

  async function runWith(purpose: string, reference: string, remittance: string): Promise<PaymentRunDetail> {
    const created = await addBill({ reference, remittance });
    const res = await request(app)
      .post('/api/payment-runs')
      .set('Cookie', cookie)
      .send({ bill_ids: [created.id], category_purpose: purpose });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as PaymentRunDetail;
  }

  it('marks a tax payment per transaction, where the specification puts it', async () => {
    // "Eine Kodierung auf Bestandsebene … ist nicht vorgesehen" — even when
    // every payment in the batch is a tax payment. So the run-wide flag is an
    // operator convenience and the code still lands on each CdtTrfTxInf.
    await boot({});
    const run = await runWith('TAXS', TAX_ACCOUNT, TAX_REMITTANCE);
    expect(run.category_purpose).toBe('TAXS');

    const xml = (await request(app).get(`/api/payment-runs/${run.id}/sepa.xml`).set('Cookie', cookie).expect(200))
      .text;
    expect(xml).toContain('<Purp>');
    expect(xml).toContain('<Cd>TAXS</Cd>');
    expect(xml).not.toContain('<CtgyPurp>');
  });

  it('sends the tax account number as EndToEndId, unprefixed', async () => {
    // The tax office books the payment against it, so the usual "B<id>-" bill
    // prefix would misfile the money.
    await boot({});
    const run = await runWith('TAXS', TAX_ACCOUNT, TAX_REMITTANCE);
    const xml = (await request(app).get(`/api/payment-runs/${run.id}/sepa.xml`).set('Cookie', cookie).expect(200))
      .text;
    expect(xml).toContain(`<EndToEndId>${TAX_ACCOUNT}</EndToEndId>`);
  });

  it('refuses a tax account number whose check digit is wrong', async () => {
    await boot({});
    const created = await addBill({ reference: '269135720', remittance: TAX_REMITTANCE });
    const res = await request(app)
      .post('/api/payment-runs')
      .set('Cookie', cookie)
      .send({ bill_ids: [created.id], category_purpose: 'TAXS' });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('check digit should be 9');
  });

  it('refuses a remittance line that is not in the Finanzamt format', async () => {
    await boot({});
    const created = await addBill({ reference: TAX_ACCOUNT, remittance: 'Rechnung 2026-0815' });
    const res = await request(app)
      .post('/api/payment-runs')
      .set('Cookie', cookie)
      .send({ bill_ids: [created.id], category_purpose: 'TAXS' });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('Finanzamt remittance');
  });

  it('marks a Postbarzahlung with Prtry, because CPPP is not an ISO code', async () => {
    // A bank handed <Cd>CPPP</Cd> is handed a code that appears in no ISO
    // ExternalCategoryPurpose list.
    await boot({});
    const run = await runWith('CPPP', 'CPP-1', CPPP_REMITTANCE);
    const xml = (await request(app).get(`/api/payment-runs/${run.id}/sepa.xml`).set('Cookie', cookie).expect(200))
      .text;
    expect(xml).toContain('<CtgyPurp>');
    expect(xml).toContain('<Prtry>CPPP</Prtry>');
    expect(xml).not.toContain('<Cd>CPPP</Cd>');
  });

  it('says the format WAS checked — the patterns are published and shipped', async () => {
    await boot({});
    const run = await runWith('TAXS', TAX_ACCOUNT, TAX_REMITTANCE);
    expect(run.remittance_format_checked).toBe(true);
  });

  it('lets an operator tighten the pattern without loosening it', async () => {
    // A bank may be stricter than PSA. It may not be more permissive: the
    // override replaces the format check, not the length or the empty check.
    await boot({ austrianRemittance: { TAXS: /^0811\+676850L.*$/, CPPP: null } });
    const created = await addBill({ reference: TAX_ACCOUNT, remittance: '0810-563910U' });
    const res = await request(app)
      .post('/api/payment-runs')
      .set('Cookie', cookie)
      .send({ bill_ids: [created.id], category_purpose: 'TAXS' });
    expect(res.status).toBe(422);
  });

  it('leaves an ordinary run with no purpose and nothing to check', async () => {
    await boot({});
    const run = await makeRun();
    expect(run.category_purpose).toBeNull();
    // Null, not false: there is no Austrian format to check on an ordinary
    // transfer, and "unchecked" would read as a warning where none applies.
    expect(run.remittance_format_checked).toBeNull();
  });

  it('refuses a purpose that is not one of the two', async () => {
    await boot({});
    const created = await addBill();
    const res = await request(app)
      .post('/api/payment-runs')
      .set('Cookie', cookie)
      .send({ bill_ids: [created.id], category_purpose: 'TAX' });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('category_purpose');
  });
});
