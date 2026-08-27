/**
 * Acceptance run of docs/TEST-PLAN-PS-12.md — the MOD-04 L cases.
 * Drives the module's own HTTP routes with PS-12 stubbed, the way the plan says.
 */
import { createHash } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { noopPlatform, type BankOrderResult, type PlatformHooks } from '../server/platform.js';
import type { BankBooking } from '../shared/matching.js';

const auth = { username: 'admin', password: 'pw', secret: 'test-secret', ttlHours: 1, secureCookie: false };
const seller = { name: '0815software GmbH', addressLines: ['Beispielgasse 8/15', '1010 Wien'],
  vatId: 'ATU00000000', iban: 'AT61 1904 3002 3457 3201', bic: 'GIBAATWWXXX' };

const results: { id: string; ok: boolean }[] = [];
function record(id: string, title: string, ok: boolean, note: string) {
  results.push({ id, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${title}${note ? ' — ' + note : ''}`);
}

async function boot(hooks?: PlatformHooks, configured?: boolean) {
  const db = openDb(':memory:');
  const app = createApp({ db, auth: auth as never, seller: seller as never,
    platform: hooks ?? noopPlatform, bankingConfigured: configured ?? hooks !== undefined });
  const login = await request(app).post('/api/login').send({ username: 'admin', password: 'pw' });
  const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
  return { db, app, cookie };
}

type Rig = Awaited<ReturnType<typeof boot>>;

async function makeRun(r: Rig) {
  const creditor = (await request(r.app).post('/api/creditors').set('Cookie', r.cookie)
    .send({ name: 'Stadtwerke Wien Energie GmbH', iban: 'AT96 2011 1822 0212 0077', bic: 'GIBAATWWXXX' })).body;
  const bill = (await request(r.app).post('/api/bills').set('Cookie', r.cookie).send({
    creditor_id: creditor.id, reference: `SW-${Math.random().toString(36).slice(2, 8)}`,
    amount_cents: 384_20, issue_date: '2026-06-02', due_date: '2026-06-16' })).body;
  const run = (await request(r.app).post('/api/payment-runs').set('Cookie', r.cookie)
    .send({ bill_ids: [bill.id] })).body;
  return { bill, run };
}

function stub(reply: () => BankOrderResult): PlatformHooks {
  return { ...noopPlatform, async submitPaymentRun() { return reply(); },
    async bankOrderStatus() { return reply(); } };
}

async function main() {
  console.log('\n5 · Status, and the money path');

  // E1 — a settlement then a return: contested must release nothing.
  {
    const r = await boot(stub(() => ({ orderId: 'ord_both', status: 'contested',
      message: 'a settlement and a refusal for the same order' })));
    const { bill, run } = await makeRun(r);
    const res = await request(r.app).post(`/api/payment-runs/${run.id}/submit`).set('Cookie', r.cookie).send({});
    const after = (await request(r.app).get(`/api/bills/${bill.id}`).set('Cookie', r.cookie)).body;
    const detail = (await request(r.app).get(`/api/payment-runs/${run.id}`).set('Cookie', r.cookie)).body;
    record('E1', 'a contested order releases no bills and executes nothing',
      res.status === 200 && res.body.bank_status === 'contested' && after.status === 'scheduled'
        && detail.status !== 'executed' && detail.executed_at == null,
      `bank_status "${res.body.bank_status}", bill "${after.status}", run "${detail.status}"`);
    r.db.close();
  }

  // E4 — a refusal releases the bills, and the next run gets a new MsgId.
  {
    const r = await boot(stub(() => ({ orderId: 'ord_no', status: 'rejected', message: 'the bank refused' })));
    const { bill, run } = await makeRun(r);
    await request(r.app).post(`/api/payment-runs/${run.id}/submit`).set('Cookie', r.cookie).send({});
    const after = (await request(r.app).get(`/api/bills/${bill.id}`).set('Cookie', r.cookie)).body;
    const second = await request(r.app).post('/api/payment-runs').set('Cookie', r.cookie)
      .send({ bill_ids: [bill.id] });
    record('E4', 'a refusal releases the bills, and a corrected run gets a new MsgId',
      after.status === 'open' && second.status === 201 && second.body.message_id !== run.message_id,
      `bill "${after.status}", new MsgId differs: ${second.body.message_id !== run.message_id}`);
    r.db.close();
  }

  // I2 — a booking applied twice is refused the second time.
  {
    const booking = { key: 'bk-i2', booked_at: '2026-06-20', amount_text: '384.20', amount_cents: 384_20,
      currency: 'EUR', credit: true, reversal: false, batch_count: 1, end_to_end_id: null,
      counterparty_name: 'Kunde Zwei', counterparty_iban: 'AT96 2011 1822 0212 0077',
      remittance: null, creditor_reference: null };
    const hooks: PlatformHooks = { ...noopPlatform, async fetchBankBookings() { return [booking] as never; } };
    const r = await boot(hooks);
    const customer = (await request(r.app).post('/api/customers').set('Cookie', r.cookie)
      .send({ name: 'Kunde Zwei', email: 'k2@example.at' })).body;
    const invoice = (await request(r.app).post('/api/invoices').set('Cookie', r.cookie).send({
      customer_id: customer.id, issue_date: '2026-06-01', due_date: '2026-06-15',
      lines: [{ description: 'Arbeit', quantity: 1, unit_price_cents: 320_17, vat_rate: 20 }] })).body;
    await request(r.app).post(`/api/invoices/${invoice.id}/finalize`).set('Cookie', r.cookie).send({});

    // The route takes a BATCH of applications, keyed by the booking's key.
    const apply = () => request(r.app).post('/api/receivables/apply').set('Cookie', r.cookie)
      .send({ applications: [{ booking_key: booking.key, invoice_id: invoice.id, amount_cents: 384_20 }] });
    const first = await apply();
    const second = await apply();
    const sug = await request(r.app).get('/api/receivables/suggestions?from=2026-06-01&to=2026-06-30')
      .set('Cookie', r.cookie);
    const why = ((sug.body.unmatched ?? []) as { booking: { key: string }; why: string }[])
      .find((u) => u.booking.key === 'bk-i2')?.why;
    // The route takes a batch, so the refusal is per application rather than
    // on the HTTP status. What actually matters is the money: one payment row,
    // and the invoice paid once.
    const outcome = (o: typeof first) => (o.body.outcomes ?? [])[0]?.status;
    const detail = (await request(r.app).get(`/api/invoices/${invoice.id}`).set('Cookie', r.cookie)).body;
    const payments = (r.db.prepare('SELECT COUNT(*) AS n FROM payments WHERE external_ref = ?')
      .get('bk-i2') as { n: number }).n;
    record('I2', 'a booking already applied is refused, and the money is booked once',
      outcome(first) === 'recorded' && outcome(second) === 'already_applied'
        && payments === 1 && detail.paid_cents === 384_20 && why === 'already_applied',
      `outcomes "${outcome(first)}" then "${outcome(second)}", ${payments} payment row, ` +
      `paid ${detail.paid_cents}, listed as "${why}"`);
    r.db.close();
  }

  console.log('\n8 · Payables');

  // H3 — the downloaded XML is byte-identical to what was handed to the bank.
  {
    let sentSha = '';
    const hooks: PlatformHooks = { ...noopPlatform,
      async submitPaymentRun(run) {
        sentSha = createHash('sha256').update(run.xml).digest('hex');
        return { orderId: 'ord_ok', status: 'accepted', message: null };
      },
      async bankOrderStatus() { return { orderId: 'ord_ok', status: 'accepted', message: null }; } };
    const r = await boot(hooks);
    const { run } = await makeRun(r);
    await request(r.app).post(`/api/payment-runs/${run.id}/submit`).set('Cookie', r.cookie).send({});
    const xml = await request(r.app).get(`/api/payment-runs/${run.id}/sepa.xml`).set('Cookie', r.cookie);
    const downloadedSha = createHash('sha256').update(xml.text).digest('hex');
    record('H3', 'the download is byte-identical to what was transmitted',
      sentSha !== '' && sentSha === downloadedSha, `sha256 ${sentSha.slice(0, 16)}… on both sides`);
    r.db.close();
  }

  console.log('\n9 · Receivables');

  // I1 — standalone: with no BANKING_URL the module behaves as before.
  {
    const r = await boot(undefined, false);
    const { run } = await makeRun(r);
    const cfg = await request(r.app).get('/api/payment-config').set('Cookie', r.cookie);
    const submit = await request(r.app).post(`/api/payment-runs/${run.id}/submit`).set('Cookie', r.cookie).send({});
    const xml = await request(r.app).get(`/api/payment-runs/${run.id}/sepa.xml`).set('Cookie', r.cookie);
    const suggestions = await request(r.app).get('/api/receivables/suggestions').set('Cookie', r.cookie);
    // 501 is the honest answer here, and the message names the alternative —
    // that IS degrading honestly, rather than erroring or pretending.
    record('I1', 'with no bank configured the module still works, and says why the button is gone',
      cfg.body.banking_configured === false && cfg.body.ready === true && submit.status === 409
        && xml.status === 200 && xml.text.includes('CstmrCdtTrfInitn')
        && suggestions.status === 501 && /BANKING_URL is unset/.test(String(suggestions.body.error))
        && /record incoming payments on the invoice itself/.test(String(suggestions.body.error)),
      `submit ${submit.status}, download ${xml.status}, suggestions ${suggestions.status} naming the alternative`);
    r.db.close();
  }

  // D6 + I2 — a collective credit is refused; an applied booking is not applied twice.
  {
    const bookings: BankBooking[] = [
      { key: 'bk-single', booked_at: '2026-06-20', amount_text: '384.20', amount_cents: 384_20,
        currency: 'EUR', credit: true, reversal: false, batch_count: 1, end_to_end_id: null,
        counterparty_name: 'Kunde Eins', counterparty_iban: 'AT96 2011 1822 0212 0077',
        remittance: null, creditor_reference: null } as never,
      { key: 'bk-collective', booked_at: '2026-06-20', amount_text: '10000.00', amount_cents: 10_000_00,
        currency: 'EUR', credit: true, reversal: false, batch_count: 3, end_to_end_id: null,
        counterparty_name: null, counterparty_iban: null,
        remittance: null, creditor_reference: null } as never,
    ];
    const hooks: PlatformHooks = { ...noopPlatform, async fetchBankBookings() { return bookings; } };
    const r = await boot(hooks);
    // An invoice the single booking could settle.
    const customer = (await request(r.app).post('/api/customers').set('Cookie', r.cookie)
      .send({ name: 'Kunde Eins', email: 'k1@example.at' })).body;
    const invoice = (await request(r.app).post('/api/invoices').set('Cookie', r.cookie).send({
      customer_id: customer.id, issue_date: '2026-06-01', due_date: '2026-06-15',
      lines: [{ description: 'Arbeit', quantity: 1, unit_price_cents: 320_17, vat_rate: 20 }] })).body;
    const finalised = await request(r.app).post(`/api/invoices/${invoice.id}/finalize`)
      .set('Cookie', r.cookie).send({});
    if (finalised.status !== 200) throw new Error(`could not finalise the invoice: ${finalised.status}`);

    const sug = await request(r.app).get('/api/receivables/suggestions?from=2026-06-01&to=2026-06-30')
      .set('Cookie', r.cookie);
    const unmatched = (sug.body.unmatched ?? []) as { booking: { key: string }; why: string }[];
    const proposals = (sug.body.proposals ?? []) as { booking: { key: string } }[];
    const collective = unmatched.find((u) => u.booking.key === 'bk-collective');
    // Positive control: the ordinary single credit must still be proposable,
    // or "refuses the collective one" would be true of a matcher that
    // proposes nothing at all.
    const singleProposed = proposals.some((p) => p.booking.key === 'bk-single');
    record('D6', 'a collective credit is refused by name while an ordinary one still matches',
      sug.status === 200 && collective?.why === 'collective'
        && !proposals.some((p) => p.booking.key === 'bk-collective') && singleProposed,
      `collective "${collective?.why}", single credit proposed: ${singleProposed}`);
    r.db.close();
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length} cases run, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) { console.log('FAILED: ' + failed.map((f) => f.id).join(', ')); process.exitCode = 1; }
}
await main();
