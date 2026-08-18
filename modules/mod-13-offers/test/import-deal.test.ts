import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import { buildPlatform, DealFetchError, noopPlatform, type PlatformHooks } from '../server/platform.js';
import { importTransfer } from '../server/transfer-import.js';
import { TRANSFER_VERSION, transferTotals, type DocumentTransfer } from '../shared/transfer.js';
import type { OfferDetail } from '../shared/types.js';

/**
 * Quoting a deal from the pipeline.
 *
 * The mirror of MOD-04's `import-offer`, one step earlier in the same chain:
 * MOD-10 knows what is being sold and to whom, this module knows how to put a
 * price on paper. Three properties carry the weight here.
 *
 * A DEAL IS AN ESTIMATE. What arrives is one number a salesperson wrote down,
 * with no VAT opinion behind it, and what this module produces is therefore a
 * DRAFT: no number, not sent, every figure editable.
 *
 * IT IS IDEMPOTENT. Two clicks must not leave a customer holding two quotes for
 * one job, so the origin reference is stored and the second import returns the
 * first one's draft.
 *
 * IT REFUSES AN OFFER. The transfer shape also carries accepted offers, and
 * importing one here would make a rival copy of a document this module already
 * owns. That operation is called a revision and already exists.
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
  email: 'offers@0815software.example.at',
};

const CLOCK = '2026-07-20';

/** A deal still in play, as MOD-10 puts it on the wire. */
function dealTransfer(overrides: Partial<DocumentTransfer> = {}): DocumentTransfer {
  const lines = overrides.lines ?? [
    {
      description: 'Battery storage pilot',
      quantity: 1,
      unit_price_cents: 1_200_000_00,
      discount_percent: 0,
      // A CRM has no VAT concept, so it states none. This zero is the input
      // that the module under test must NOT treat as a tax rate.
      vat_rate: 0,
      net_cents: 1_200_000_00,
    },
  ];
  return {
    transfer_version: TRANSFER_VERSION,
    origin: {
      kind: 'deal',
      module: 'mod-10-crm-lite',
      reference: 'DEAL-3',
      issued_at: '2026-06-10T09:00:00Z',
      accepted_at: null,
    },
    currency: 'EUR',
    customer: {
      name: 'Helios Renewables GmbH',
      contact_person: 'Ingrid Sauer',
      email: 'i.sauer@helios-energy.example.at',
      vat_id: null,
      address_lines: [],
      party_id: null,
      source: 'mod-10-crm-lite',
      external_id: '1',
    },
    lines,
    totals: transferTotals(lines),
    note: 'Site survey completed, budget confirmed.',
    ...overrides,
  };
}

/** An accepted offer, as MOD-13 itself exports one. This module must refuse it. */
function offerTransfer(): DocumentTransfer {
  const doc = dealTransfer();
  return {
    ...doc,
    origin: {
      kind: 'offer',
      module: 'mod-13-offers',
      reference: 'AN-2026-0007',
      issued_at: '2026-07-18',
      accepted_at: '2026-07-20T12:00:00Z',
    },
  };
}

/** A platform that serves one deal and records what it was asked to do. */
function dealSource(
  deals: Record<string, DocumentTransfer>,
  opts: { partyId?: number | null; fail?: DealFetchError } = {},
): { hooks: PlatformHooks; calls: { resolved: unknown[]; audited: unknown[] } } {
  const calls = { resolved: [] as unknown[], audited: [] as unknown[] };
  return {
    calls,
    hooks: {
      ...noopPlatform,
      async fetchDeal(dealId: string) {
        if (opts.fail) throw opts.fail;
        const found = deals[dealId];
        if (!found) throw new DealFetchError(404, 'Deal not found');
        return found;
      },
      async resolveParty(info) {
        calls.resolved.push(info);
        return opts.partyId ?? null;
      },
      async audit(info) {
        calls.audited.push(info);
      },
    },
  };
}

let db: Database.Database;

async function login(app: Express): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  expect(res.status).toBe(200);
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

function build(platform: PlatformHooks): Express {
  return createApp({ db, auth, seller, platform, clock: () => CLOCK });
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('POST /api/offers/import-deal', () => {
  it('turns a deal in play into a draft quote', async () => {
    const source = dealSource({ '3': dealTransfer() });
    const app = build(source.hooks);
    const cookie = await login(app);

    const res = await request(app)
      .post('/api/offers/import-deal')
      .set('Cookie', cookie)
      .send({ deal_id: 3 })
      .expect(201);

    const offer = res.body as OfferDetail & { imported: boolean };
    expect(offer.imported).toBe(true);
    // A DRAFT, always: no number, not sent, and therefore editable. What
    // arrived was one estimate, and the person quoting turns it into a
    // document — that is the whole division of labour between the two modules.
    expect(offer.status).toBe('draft');
    expect(offer.number).toBeNull();
    expect(offer.title).toBe('Battery storage pilot');
    expect(offer.customer_name).toBe('Helios Renewables GmbH');
    expect(offer.intro).toBe('Site survey completed, budget confirmed.');
  });

  it('applies this module’s own VAT rate, because the CRM expressed none', async () => {
    const source = dealSource({ '3': dealTransfer() });
    const app = build(source.hooks);
    const cookie = await login(app);

    const res = await request(app)
      .post('/api/offers/import-deal')
      .set('Cookie', cookie)
      .send({ deal_id: '3' })
      .expect(201);

    const offer = res.body as OfferDetail;
    expect(offer.lines).toHaveLength(1);
    // 20 % is what this module's own editor puts on a new line. The failure
    // this pins down is the quiet one: an import that took the CRM's `0`
    // literally would quote everything zero-rated, and that number reaches a
    // customer.
    expect(offer.lines[0]!.vat_rate).toBe(20);
    expect(offer.lines[0]!.unit_price_cents).toBe(1_200_000_00);
    expect(offer.net_cents).toBe(1_200_000_00);
    expect(offer.vat_cents).toBe(24_000_000);
  });

  it('honours a rate the source really did choose', async () => {
    // Only a ZERO means "no opinion". A source that names 10 % is naming a
    // rate, and substituting the default for it would be this module
    // overruling a decision that was made.
    const doc = dealTransfer({
      lines: [
        {
          description: 'Reduced-rate supply',
          quantity: 1,
          unit_price_cents: 50_000,
          discount_percent: 0,
          vat_rate: 10,
          net_cents: 50_000,
        },
      ],
    });
    const source = dealSource({ '9': { ...doc, totals: transferTotals(doc.lines) } });
    const app = build(source.hooks);
    const cookie = await login(app);

    const res = await request(app)
      .post('/api/offers/import-deal')
      .set('Cookie', cookie)
      .send({ deal_id: 9 })
      .expect(201);
    expect((res.body as OfferDetail).lines[0]!.vat_rate).toBe(10);
  });

  it('gives the draft a validity date derived from today', async () => {
    const source = dealSource({ '3': dealTransfer() });
    const app = build(source.hooks);
    const cookie = await login(app);

    const res = await request(app)
      .post('/api/offers/import-deal')
      .set('Cookie', cookie)
      .send({ deal_id: 3 })
      .expect(201);
    // 30 days from the injected clock. A draft may legally have none, but
    // finalization requires one, so pre-filling it saves a step and is
    // trivially editable.
    expect((res.body as OfferDetail).valid_until).toBe('2026-08-19');
  });

  it('is idempotent — a second import returns the first draft', async () => {
    const source = dealSource({ '3': dealTransfer() });
    const app = build(source.hooks);
    const cookie = await login(app);

    const first = await request(app).post('/api/offers/import-deal').set('Cookie', cookie).send({ deal_id: 3 });
    expect(first.status).toBe(201);
    const second = await request(app).post('/api/offers/import-deal').set('Cookie', cookie).send({ deal_id: 3 });
    // 200, not 201: nothing was created this time. A customer holding two
    // quotes for one job is the failure this prevents, and a board button is
    // exactly the thing people click twice.
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.imported).toBe(false);

    const count = db.prepare('SELECT COUNT(*) AS n FROM offers').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('reuses the customer instead of creating a second one', async () => {
    const source = dealSource({ '3': dealTransfer(), '4': { ...dealTransfer(), origin: { ...dealTransfer().origin, reference: 'DEAL-4' } } });
    const app = build(source.hooks);
    const cookie = await login(app);

    await request(app).post('/api/offers/import-deal').set('Cookie', cookie).send({ deal_id: 3 }).expect(201);
    await request(app).post('/api/offers/import-deal').set('Cookie', cookie).send({ deal_id: 4 }).expect(201);

    // Two deals for one company are two quotes for one customer. Matching is
    // by email here, since a CRM carries no VAT id.
    const customers = db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number };
    expect(customers.n).toBe(1);
  });

  it('does not blank fields the CRM has no answer for', async () => {
    const app = build(dealSource({ '3': dealTransfer() }).hooks);
    const cookie = await login(app);

    // A customer this module already knows properly, with details a CRM does
    // not carry.
    await request(app)
      .post('/api/customers')
      .set('Cookie', cookie)
      .send({
        name: 'Helios Renewables GmbH',
        contact_person: 'Dr. Ingrid Sauer',
        email: 'i.sauer@helios-energy.example.at',
        vat_id: 'ATU99887766',
        address: 'Sonnenweg 4, 4020 Linz',
      })
      .expect(201);

    await request(app).post('/api/offers/import-deal').set('Cookie', cookie).send({ deal_id: 3 }).expect(201);

    const customer = db.prepare('SELECT * FROM customers').get() as {
      vat_id: string | null;
      address: string | null;
      contact_person: string | null;
    };
    // Enrich, never clobber. An import from a module that knows less must not
    // cost the invoicing details someone typed in here.
    expect(customer.vat_id).toBe('ATU99887766');
    expect(customer.address).toBe('Sonnenweg 4, 4020 Linz');
    expect(customer.contact_person).toBe('Dr. Ingrid Sauer');
  });

  it('matches on the PS-11 party rather than on a name spelled twice', async () => {
    const doc = dealTransfer();
    doc.customer.party_id = 4711;
    doc.customer.name = 'HELIOS RENEWABLES G.M.B.H.';
    doc.customer.email = null;
    const app = build(dealSource({ '3': doc }).hooks);
    const cookie = await login(app);

    const created = await request(app)
      .post('/api/customers')
      .set('Cookie', cookie)
      .send({ name: 'Helios Renewables GmbH', email: 'i.sauer@helios-energy.example.at' })
      .expect(201);
    db.prepare('UPDATE customers SET party_id = ? WHERE id = ?').run(4711, created.body.id);

    await request(app).post('/api/offers/import-deal').set('Cookie', cookie).send({ deal_id: 3 }).expect(201);

    // Same party, two spellings, one customer row. Without the party id this
    // import would have created a duplicate that nobody would notice until
    // someone tried to reconcile them.
    const customers = db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number };
    expect(customers.n).toBe(1);
  });

  it('records the import on the audit trail, once', async () => {
    const source = dealSource({ '3': dealTransfer() });
    const app = build(source.hooks);
    const cookie = await login(app);

    await request(app).post('/api/offers/import-deal').set('Cookie', cookie).send({ deal_id: 3 }).expect(201);
    await request(app).post('/api/offers/import-deal').set('Cookie', cookie).send({ deal_id: 3 }).expect(200);

    // The replay created nothing, so it records nothing. An audit trail that
    // logs a second creation that did not happen is worse than a quiet one.
    expect(source.calls.audited).toHaveLength(1);
    expect(source.calls.audited[0]).toMatchObject({ action: 'offer.imported' });
  });
});

describe('POST /api/offers/import-deal — what it refuses', () => {
  it('refuses an accepted offer, and says to revise instead', async () => {
    const source = dealSource({ '3': offerTransfer() });
    const app = build(source.hooks);
    const cookie = await login(app);

    const res = await request(app)
      .post('/api/offers/import-deal')
      .set('Cookie', cookie)
      .send({ deal_id: 3 })
      .expect(422);
    // The shape validates perfectly; only the meaning is wrong, so the
    // refusal is explicit and names the alternative that does exist.
    expect(String(res.body.error)).toContain('pipeline deal');
    expect(String(res.body.error)).toContain('revise');
  });

  it('requires a session — the board acts as a person, never as the machine', async () => {
    const app = build(dealSource({ '3': dealTransfer() }).hooks);
    await request(app).post('/api/offers/import-deal').send({ deal_id: 3 }).expect(401);
    // The machine token opens summaries and mints sessions. It writes nothing.
    await request(app)
      .post('/api/offers/import-deal')
      .set('X-Service-Token', 'test-machine-token')
      .send({ deal_id: 3 })
      .expect(401);
  });

  it('says CRM_URL is unset rather than failing obscurely', async () => {
    const app = build(noopPlatform);
    const cookie = await login(app);
    const res = await request(app)
      .post('/api/offers/import-deal')
      .set('Cookie', cookie)
      .send({ deal_id: 3 })
      .expect(501);
    expect(String(res.body.error)).toContain('CRM_URL');
  });

  it('passes an upstream 404 through, and turns anything else into a 502', async () => {
    const missing = build(dealSource({}).hooks);
    let cookie = await login(missing);
    await request(missing).post('/api/offers/import-deal').set('Cookie', cookie).send({ deal_id: 99 }).expect(404);

    // A CRM that is down is not a validation error on this side, and calling
    // it one would send the operator looking at the wrong module.
    const broken = build(dealSource({}, { fail: new DealFetchError(503, 'crm unavailable') }).hooks);
    cookie = await login(broken);
    await request(broken).post('/api/offers/import-deal').set('Cookie', cookie).send({ deal_id: 3 }).expect(502);
  });

  /**
   * A CRM that is DOWN, not one that answered badly.
   *
   * The case above stubs the hook and throws a `DealFetchError`, which only
   * proves the route maps that error. A refused connection, a DNS failure or
   * the fetch timeout throw from `fetch` itself, and those used to escape the
   * route's `instanceof` check entirely and surface as `500 Internal server
   * error` — which points the operator at this module when the problem is the
   * one it was calling. So this case uses a real platform pointed at a port
   * nothing is listening on.
   */
  it('reports an unreachable CRM as a bad gateway, not as its own failure', async () => {
    const app = createApp({
      db,
      auth,
      seller,
      clock: () => CLOCK,
      platform: buildPlatform({ crmUrl: 'http://127.0.0.1:1', serviceToken: 'tok' }),
    });
    const cookie = await login(app);

    const res = await request(app)
      .post('/api/offers/import-deal')
      .set('Cookie', cookie)
      .send({ deal_id: 3 })
      .expect(502);
    expect(String(res.body.error)).toMatch(/unreachable/i);
    expect(String(res.body.error)).not.toBe('Internal server error');
  });

  it('requires a deal id', async () => {
    const app = build(dealSource({ '3': dealTransfer() }).hooks);
    const cookie = await login(app);
    await request(app).post('/api/offers/import-deal').set('Cookie', cookie).send({}).expect(422);
    await request(app).post('/api/offers/import-deal').set('Cookie', cookie).send({ deal_id: '  ' }).expect(422);
  });
});

describe('importTransfer — the numbers', () => {
  it('refuses a transfer whose totals do not match its lines', async () => {
    const doc = dealTransfer();
    doc.totals.net_cents += 1;
    // Same self-checking rule the billing direction uses: a rounding
    // disagreement between two modules must never become a wrong document.
    expect(() => importTransfer(db, doc)).toThrowError(/cannot be quoted/);
  });

  it('refuses a currency it cannot quote', () => {
    expect(() => importTransfer(db, dealTransfer({ currency: 'CHF' }))).toThrowError(/Only EUR/);
  });

  it('refuses a transfer from a future version of the contract', () => {
    expect(() => importTransfer(db, dealTransfer({ transfer_version: TRANSFER_VERSION + 1 }))).toThrowError(
      /cannot be quoted/,
    );
  });
});
