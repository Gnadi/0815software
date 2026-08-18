import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { createDeal, moveStage, reopenDeal } from '../server/deals.js';
import { createCompany } from '../server/companies.js';
import type { AuthConfig } from '../server/auth.js';
import { TRANSFER_VERSION, validateTransfer, type DocumentTransfer } from '../shared/transfer.js';

/**
 * Handing a deal to whatever quotes it.
 *
 * The mirror of MOD-13's `/api/offers/:number/transfer`: same neutral shape,
 * same machine-token guard, opposite direction. What this file pins down is
 * the part a CRM can get wrong in an expensive way — WHICH deals leave, and
 * what the numbers on them are allowed to claim.
 *
 * A deal is a guess about money. The transfer says so (`kind: 'deal'`,
 * `accepted_at: null`, `vat_rate: 0`), and the modules downstream act on that:
 * MOD-13 quotes it, MOD-04 refuses to bill it.
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

const TOKEN = 'test-machine-token';

let db: Database.Database;
let app: Express;
let cookie: string;

beforeEach(async () => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, auth, serviceToken: TOKEN });
  const login = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
});

/** The id of a seeded deal in the given stage. */
function dealIn(stage: string): number {
  const row = db.prepare('SELECT id FROM deals WHERE stage = ? ORDER BY id LIMIT 1').get(stage) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`the seed has no ${stage} deal`);
  return row.id;
}

function transfer(id: number): request.Test {
  return request(app).get(`/api/deals/${id}/transfer`).set('X-Service-Token', TOKEN);
}

describe('GET /api/deals/:id/transfer — auth', () => {
  it('requires the machine token, and a staff session is not one', async () => {
    const id = dealIn('qualified');
    await request(app).get(`/api/deals/${id}/transfer`).expect(401);
    // The caller this endpoint exists for is another service in the stack, not
    // a person — so the person's own cookie is deliberately not a way in.
    await request(app).get(`/api/deals/${id}/transfer`).set('Cookie', cookie).expect(401);
    await request(app).get(`/api/deals/${id}/transfer`).set('X-Service-Token', 'wrong').expect(401);
    await transfer(id).expect(200);
  });

  it('is closed when the stack has no machine token', async () => {
    // The standalone default. Nothing is configured, so nothing can be handed
    // over — not even by a caller that guessed the empty string.
    const standalone = createApp({ db, auth });
    await request(standalone).get(`/api/deals/${dealIn('qualified')}/transfer`).expect(401);
    await request(standalone)
      .get(`/api/deals/${dealIn('qualified')}/transfer`)
      .set('X-Service-Token', '')
      .expect(401);
  });
});

describe('GET /api/deals/:id/transfer — what leaves', () => {
  it('produces a transfer an importer will accept', async () => {
    const res = await transfer(dealIn('negotiation')).expect(200);
    // The same validator MOD-13 and MOD-04 run before they act on it. A shape
    // mistake here is a refused import there, so it is asserted at the source.
    expect(validateTransfer(res.body)).toEqual([]);

    const body = res.body as DocumentTransfer;
    expect(body.transfer_version).toBe(TRANSFER_VERSION);
    expect(body.origin.kind).toBe('deal');
    expect(body.origin.module).toBe('mod-10-crm-lite');
    expect(body.currency).toBe('EUR');
  });

  it('says the deal was never agreed to, because it was not', async () => {
    const body = (await transfer(dealIn('negotiation')).expect(200)).body as DocumentTransfer;
    // This null is the whole reason MOD-04 can refuse the transfer without
    // guessing: a deal has no acceptance, and the shape states that rather
    // than leaving the field off.
    expect(body.origin.accepted_at).toBeNull();
  });

  it('carries the deal value as one line and expresses no opinion on VAT', async () => {
    const id = dealIn('negotiation');
    const value = (db.prepare('SELECT value_cents FROM deals WHERE id = ?').get(id) as { value_cents: number })
      .value_cents;

    const body = (await transfer(id).expect(200)).body as DocumentTransfer;
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]!.quantity).toBe(1);
    expect(body.lines[0]!.unit_price_cents).toBe(value);
    expect(body.lines[0]!.net_cents).toBe(value);
    expect(body.lines[0]!.discount_percent).toBe(0);
    // A CRM has no VAT concept and must not acquire one. Zero says "this
    // module did not decide"; the quoting module applies its own rate.
    expect(body.lines[0]!.vat_rate).toBe(0);
    expect(body.totals).toEqual({ net_cents: value, vat_cents: 0, gross_cents: value });
  });

  it('references the deal by an id that is never reused', async () => {
    const id = dealIn('lead');
    const body = (await transfer(id).expect(200)).body as DocumentTransfer;
    // Deals have no number of their own, and the reference is the idempotency
    // key of every import downstream — so it is derived from the primary key
    // rather than from the title, which anyone may edit at any time.
    expect(body.origin.reference).toBe(`DEAL-${id}`);
  });

  it('carries the company and its primary contact, and admits what a CRM does not know', async () => {
    const id = dealIn('lead');
    const body = (await transfer(id).expect(200)).body as DocumentTransfer;
    expect(body.customer.name).toBe('Helios Renewables GmbH');
    expect(body.customer.contact_person).toBe('Ingrid Sauer');
    expect(body.customer.email).toBe('i.sauer@helios-energy.example.at');
    // A CRM records who to call, not who to invoice. These are genuinely
    // unknown here, and saying so lets the importer ask rather than invent.
    expect(body.customer.vat_id).toBeNull();
    expect(body.customer.address_lines).toEqual([]);
    expect(body.customer.source).toBe('mod-10-crm-lite');
  });

  it('passes on the PS-11 party the company was resolved to', async () => {
    const id = dealIn('lead');
    const companyId = (db.prepare('SELECT company_id FROM deals WHERE id = ?').get(id) as { company_id: number })
      .company_id;
    db.prepare('UPDATE companies SET party_id = ? WHERE id = ?').run(4711, companyId);

    const body = (await transfer(id).expect(200)).body as DocumentTransfer;
    // With PS-11 wired, both ends already agree on an id for this customer.
    // Carrying it means the importer matches on identity rather than on a
    // name it would otherwise have to spell exactly the same way.
    expect(body.customer.party_id).toBe(4711);
  });
});

describe('GET /api/deals/:id/transfer — what does not leave', () => {
  it('refuses a won deal, with the stage in the message', async () => {
    const res = await transfer(dealIn('won')).expect(409);
    // A won deal was generally won BY a quote. Producing a second one is a
    // duplicate offer for work already sold.
    expect(String(res.body.error)).toContain('still in play');
    expect(String(res.body.error)).toContain('won');
  });

  it('refuses a lost deal', async () => {
    // Quoting something the customer already said no to is worse than useless.
    const res = await transfer(dealIn('lost')).expect(409);
    expect(String(res.body.error)).toContain('lost');
  });

  it('quotes a deal that was lost and then reopened', async () => {
    // `terminal` is read from the CURRENT stage, not from the deal's history.
    // A reopened deal is back in play and must be quotable, or the reopen
    // feature would leave a deal permanently unquotable.
    const id = createDeal(db, { title: 'Second run', companyId: 1, primaryContactId: null, valueCents: 100_00, note: null });
    moveStage(db, id, 'lost', null);
    reopenDeal(db, id, 'qualified', null);
    await transfer(id).expect(200);
  });

  it('refuses a deal nobody has priced', async () => {
    const companyId = createCompany(db, { name: 'Unpriced GmbH', domain: null, notes: null });
    const id = createDeal(db, { title: 'Scope unknown', companyId, primaryContactId: null, valueCents: 0, note: null });
    // A zero-value transfer would fail `validateTransfer` on the importer's
    // side as a malformed line. Refusing it here says the true thing instead:
    // the deal is fine, it just has no price yet.
    const res = await transfer(id).expect(422);
    expect(String(res.body.error)).toContain('no value yet');
  });

  it('404s for a deal that does not exist', async () => {
    await transfer(999_999).expect(404);
    await request(app).get('/api/deals/not-a-number/transfer').set('X-Service-Token', TOKEN).expect(404);
  });

  it('changes nothing about the deal it exported', async () => {
    const id = dealIn('qualified');
    const before = db.prepare('SELECT * FROM deals WHERE id = ?').get(id);
    const eventsBefore = db.prepare('SELECT COUNT(*) AS n FROM deal_stage_events WHERE deal_id = ?').get(id);

    await transfer(id).expect(200);

    // Exporting is a read. Where a deal sits in the pipeline is the
    // salesperson's call, made in this module's own UI — a shell asking for
    // the numbers must never move it.
    expect(db.prepare('SELECT * FROM deals WHERE id = ?').get(id)).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM deal_stage_events WHERE deal_id = ?').get(id)).toEqual(eventsBefore);
  });
});
