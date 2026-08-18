import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { MODULE_ID } from '../server/summary.js';
import { COOKIE_NAME, type AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import { CONTEXT_FILTERS, isModulePath, SUMMARY_VERSION, validateSummary, type ModuleSummary } from '../shared/summary.js';

/**
 * What this module puts on a shell's board, and the one thing the board can do
 * with it that matters: bill an accepted offer without either module's UI.
 *
 * The summary must satisfy `validateSummary` — the shell refuses a peer that
 * fails it — and the context echo must be TRUE, because a board that claims to
 * be filtered to one customer while showing everyone's receivables is worse
 * than one that admits it could not narrow.
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
  email: 'invoices@0815software.example.at',
};

const SERVICE_TOKEN = 'test-machine-token';
const SHELL = 'https://workspace.example';

let db: Database.Database;
let app: Express;
let cookie: string;

function customer(name: string, partyId: number | null = null): number {
  const info = db
    .prepare('INSERT INTO customers (name, email, created_at) VALUES (?, ?, ?)')
    .run(name, `${name.toLowerCase().replace(/\W+/g, '')}@example`, '2026-01-01T00:00:00Z');
  const id = Number(info.lastInsertRowid);
  if (partyId !== null) db.prepare('UPDATE customers SET party_id = ? WHERE id = ?').run(partyId, id);
  return id;
}

/** A draft invoice, optionally finalized (sent) and optionally paid in full. */
async function invoice(
  customerId: number,
  cents: number,
  state: 'draft' | 'sent' | 'paid',
  opts: { issueDate?: string; dueDate?: string } = {},
): Promise<number> {
  const draft = await request(app)
    .post('/api/invoices')
    .set('Cookie', cookie)
    .send({
      customer_id: customerId,
      payment_terms_days: 14,
      lines: [{ description: 'Work', quantity: 1, unit_price_cents: cents, vat_rate: 20 }],
    })
    .expect(201);
  const id = draft.body.id as number;
  if (state === 'draft') return id;

  await request(app).post(`/api/invoices/${id}/finalize`).set('Cookie', cookie).send({}).expect(200);
  if (opts.issueDate) db.prepare('UPDATE invoices SET issue_date = ? WHERE id = ?').run(opts.issueDate, id);
  if (opts.dueDate) db.prepare('UPDATE invoices SET due_date = ? WHERE id = ?').run(opts.dueDate, id);

  if (state === 'paid') {
    const detail = await request(app).get(`/api/invoices/${id}`).set('Cookie', cookie).expect(200);
    await request(app)
      .post(`/api/invoices/${id}/payments`)
      .set('Cookie', cookie)
      .send({ date: '2026-07-01', amount_cents: detail.body.gross_cents })
      .expect(201);
  }
  return id;
}

function summary(query = ''): request.Test {
  return request(app).get(`/api/summary${query}`).set('X-Service-Token', SERVICE_TOKEN);
}

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, auth, seller, serviceToken: SERVICE_TOKEN, shellOrigins: [SHELL] });
  const login = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
});

describe('GET /api/summary — auth', () => {
  it('requires the machine token, and a staff session is not one', async () => {
    // No machine token: this route does not answer at all. It falls through,
    // which is a 404 in most modules and MOD-11's own unrelated /api/summary in
    // that one — so the property asserted is that no shell summary comes back,
    // not a particular status.
    const anonymous = await request(app).get('/api/summary');
    expect(anonymous.body.summary_version).toBeUndefined();

    // A staff session is deliberately not a way in either: the caller this
    // endpoint exists for is another service in the stack, not a person.
    const staff = await request(app).get('/api/summary').set('Cookie', cookie);
    expect(staff.body.summary_version).toBeUndefined();

    // A token that is present but wrong IS refused, rather than falling
    // through — a machine that got the credential wrong deserves to be told.
    await request(app).get('/api/summary').set('X-Service-Token', 'wrong').expect(401);
    await summary().expect(200);
  });

  it('is closed when the stack has no machine token', async () => {
    const standalone = createApp({ db, auth, seller });
    await request(standalone).get('/api/summary').set('X-Service-Token', SERVICE_TOKEN).expect(401);
  });
});

describe('the summary a shell renders', () => {
  it('satisfies the contract every consumer validates against', async () => {
    const acme = customer('Acme');
    await invoice(acme, 100_000, 'sent');
    await invoice(acme, 50_000, 'draft');

    const res = await summary().expect(200);
    expect(validateSummary(res.body)).toEqual([]);
    expect(res.body.summary_version).toBe(SUMMARY_VERSION);
    expect(res.body.module).toBe(MODULE_ID);
  });

  it('counts what is owed, excluding drafts and what is already settled', async () => {
    const acme = customer('Acme');
    await invoice(acme, 100_000, 'sent'); // 1200.00 gross, unpaid
    await invoice(acme, 200_000, 'paid'); // settled, owes nothing
    await invoice(acme, 900_000, 'draft'); // nobody owes money on a draft

    const body = (await summary().expect(200)).body as ModuleSummary;
    const tile = (key: string) => body.tiles.find((t) => t.key === key)!;

    expect(tile('drafts').value).toBe('1');
    expect(tile('paid').value).toBe('1');
    // Only the one unpaid, issued invoice: 1000.00 + 20 % VAT.
    expect(tile('outstanding').value).toContain('1.200');
  });

  it('surfaces overdue invoices, oldest due date first', async () => {
    const acme = customer('Acme');
    await invoice(acme, 100_000, 'sent', { dueDate: '2020-03-01' });
    await invoice(acme, 200_000, 'sent', { dueDate: '2020-01-01' });
    await invoice(acme, 300_000, 'sent', { dueDate: '2099-01-01' }); // not overdue

    const body = (await summary().expect(200)).body as ModuleSummary;
    expect(body.tiles.find((t) => t.key === 'overdue')!.value).toBe('2');
    const list = body.lists.find((l) => l.key === 'overdue_invoices')!;
    expect(list.items.map((i) => i.at)).toEqual(['2020-01-01', '2020-03-01']);
    expect(list.items.every((i) => i.badge === 'OVERDUE')).toBe(true);
  });

  it('hands out only paths, never absolute URLs', async () => {
    const acme = customer('Acme');
    await invoice(acme, 100_000, 'sent');

    const body = (await summary().expect(200)).body as ModuleSummary;
    const hrefs = [
      ...body.tiles.map((t) => t.href),
      ...body.lists.map((l) => l.href),
      ...body.lists.flatMap((l) => l.items.map((i) => i.href)),
    ].filter((h): h is string => h !== null);

    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(isModulePath(href)).toBe(true);
  });
});

describe('the context a shell passes', () => {
  it('narrows to one PS-11 party, and says that it did', async () => {
    const linked = customer('Blaustern', 77);
    const other = customer('Acme', 88);
    await invoice(linked, 100_000, 'sent');
    await invoice(other, 900_000, 'sent');

    const body = (await summary('?party=77').expect(200)).body as ModuleSummary;
    expect(body.context.applied).toEqual(['party']);
    expect(body.tiles.find((t) => t.key === 'outstanding')!.value).toContain('1.200');
  });

  it('narrows to a date range', async () => {
    const acme = customer('Acme');
    await invoice(acme, 100_000, 'sent', { issueDate: '2026-01-15' });
    await invoice(acme, 200_000, 'sent', { issueDate: '2026-07-15' });

    const body = (await summary('?from=2026-07-01&to=2026-07-31').expect(200)).body as ModuleSummary;
    expect(body.context.applied).toEqual(['from', 'to']);
    expect(body.tiles.find((t) => t.key === 'outstanding')!.value).toContain('2.400');
  });

  it('advertises what it supports and applies nothing when asked for nothing', async () => {
    const body = (await summary().expect(200)).body as ModuleSummary;
    expect(body.context.supported).toEqual([...CONTEXT_FILTERS]);
    expect(body.context.applied).toEqual([]);
  });

  it('ignores a malformed context instead of failing the widget', async () => {
    const acme = customer('Acme');
    await invoice(acme, 100_000, 'sent');

    const body = (await summary('?party=nonsense&from=yesterday').expect(200)).body as ModuleSummary;
    expect(body.context.applied).toEqual([]);
    expect(body.tiles.find((t) => t.key === 'outstanding')!.value).toContain('1.200');
  });
});

/**
 * The shell's headline action, end to end at this module's boundary.
 *
 * The point is that the Workspace needs NO new endpoint here. It obtains a
 * session for the person who clicked (`/api/session/issue`) and calls the same
 * import route the module's own IMPORT OFFER button calls — so the invoice is
 * created by that person, and MOD-04 cannot tell the difference between the
 * two callers, which is precisely what makes this safe.
 */
describe('a shell driving the offer → invoice action as the user', () => {
  it('imports through the module’s existing route, attributed to the person', async () => {
    const offerNumber = 'AN-2026-0007';
    const transfer = {
      transfer_version: 1,
      origin: { kind: 'offer', module: 'mod-13-offers', reference: offerNumber, issued_at: '2026-07-01', accepted_at: '2026-07-05' },
      currency: 'EUR',
      customer: {
        name: 'Blaustern Café GmbH',
        contact_person: null,
        email: 'buchhaltung@blaustern.example',
        vat_id: 'ATU12345678',
        address_lines: ['Hauptstraße 12', '5020 Salzburg'],
        party_id: null,
        source: 'mod-13-offers',
        external_id: '1',
      },
      lines: [
        { description: 'Onboarding', quantity: 1, unit_price_cents: 100_000, discount_percent: 0, vat_rate: 20, net_cents: 100_000 },
      ],
      totals: { net_cents: 100_000, vat_cents: 20_000, gross_cents: 120_000 },
      note: null,
    };

    const billed: { actor: string }[] = [];
    const withOffers = createApp({
      db,
      auth,
      seller,
      serviceToken: SERVICE_TOKEN,
      shellOrigins: [SHELL],
      platform: {
        async audit() {},
        async notify() {},
        async resolveParty() {
          return null;
        },
        async linkParty() {},
        async fetchSelf() {
          return null;
        },
        async fetchOffer() {
          return transfer;
        },
        async offerBilled(info: { actor: string }) {
          billed.push(info);
        },
        async settle() {},
      } as never,
    });

    // 1. The shell asks this module for a session for whoever clicked.
    const issued = await request(withOffers)
      .post('/api/session/issue')
      .set('X-Service-Token', SERVICE_TOKEN)
      .send({ actor: 'ada@example' })
      .expect(200);

    // 2. It replays that session against the ordinary import route.
    const created = await request(withOffers)
      .post('/api/invoices/import-offer')
      .set('Cookie', `${issued.body.cookie_name}=${issued.body.token}`)
      .send({ offer_number: offerNumber })
      .expect(201);

    expect(created.body.imported).toBe(true);
    expect(created.body.gross_cents).toBe(120_000);
    // The invoice names the person, not a service account. This is the whole
    // reason the shell holds a user session instead of using the machine token.
    expect(billed).toEqual([expect.objectContaining({ actor: 'ada@example' })]);

    // 3. And the board reflects it immediately.
    const body = (await request(withOffers).get('/api/summary').set('X-Service-Token', SERVICE_TOKEN).expect(200))
      .body as ModuleSummary;
    expect(body.tiles.find((t) => t.key === 'drafts')!.value).toBe('1');
  });

  it('refuses the import when the shell presents no session at all', async () => {
    await request(app).post('/api/invoices/import-offer').send({ offer_number: 'AN-2026-0007' }).expect(401);
    // The machine token is deliberately NOT a way in here: writes are done as
    // a person or not at all.
    await request(app)
      .post('/api/invoices/import-offer')
      .set('X-Service-Token', SERVICE_TOKEN)
      .send({ offer_number: 'AN-2026-0007' })
      .expect(401);
  });

  it('mints a session only for a caller holding the machine token', async () => {
    await request(app).post('/api/session/issue').send({ actor: 'ada@example' }).expect(401);
    await request(app).post('/api/session/issue').set('Cookie', cookie).send({ actor: 'ada@example' }).expect(401);
    const ok = await request(app)
      .post('/api/session/issue')
      .set('X-Service-Token', SERVICE_TOKEN)
      .send({ actor: 'ada@example' })
      .expect(200);
    expect(ok.body.cookie_name).toBe(COOKIE_NAME);
  });
});
