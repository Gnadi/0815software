import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { offerToken } from '../server/tokens.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import { computeTotals } from '../shared/money.js';
import type { OfferDetail, OfferRow, PublicOffer } from '../shared/types.js';

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

// Injectable clock — tests move "today" both directions; never wall-time.
let CLOCK = '2026-07-20';

let db: Database.Database;
let app: Express;
let cookie: string;

async function listOffers(query = ''): Promise<OfferRow[]> {
  const res = await request(app).get(`/api/offers${query}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body.offers as OfferRow[];
}

async function detail(id: number): Promise<OfferDetail> {
  const res = await request(app).get(`/api/offers/${id}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as OfferDetail;
}

/** Create a draft for customer 1 (defaults: one €100 line at 20%, valid far ahead). */
async function createDraft(
  lines: Record<string, unknown>[] = [
    { description: 'Consulting', quantity: 1, unit_price_cents: 10_000, vat_rate: 20 },
  ],
  extra: Record<string, unknown> = {},
): Promise<OfferDetail> {
  const res = await request(app)
    .post('/api/offers')
    .set('Cookie', cookie)
    .send({ customer_id: 1, title: 'Test offer', valid_until: '2026-12-31', lines, ...extra });
  expect(res.status).toBe(201);
  return res.body as OfferDetail;
}

async function send(id: number): Promise<OfferDetail> {
  const res = await request(app).post(`/api/offers/${id}/send`).set('Cookie', cookie).send({});
  expect(res.status).toBe(200);
  return res.body as OfferDetail;
}

/** Highest sequence number already used for a year. */
function maxSeq(year: number): number {
  const row = db
    .prepare('SELECT COALESCE(last_seq, 0) AS n FROM offer_counters WHERE year = ?')
    .get(year) as { n: number } | undefined;
  return row?.n ?? 0;
}

beforeAll(async () => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, auth, seller, clock: () => CLOCK });

  const res = await request(app)
    .post('/api/login')
    .send({ username: 'admin', password: 'test-password' });
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
});

describe('auth', () => {
  it('rejects unauthenticated requests with 401', async () => {
    for (const path of ['/api/offers', '/api/customers', '/api/offers/1', '/api/offers/1/pdf', '/api/stats']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
    }
    const post = await request(app).post('/api/offers').send({});
    expect(post.status).toBe(401);
  });

  it('rejects bad credentials', async () => {
    const res = await request(app).post('/api/login').send({ username: 'admin', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('accepts good credentials and sets an HttpOnly session cookie', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ username: 'admin', password: 'test-password' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']![0]).toContain('mod13_session=');
    expect(res.headers['set-cookie']![0]).toContain('HttpOnly');
  });
});

describe('totals are derived from lines with per-line discount + rounding', () => {
  it('handles the discount boundary: 3 × €0.33 with a 10% line discount', async () => {
    const offer = await createDraft([
      { description: 'Sticker', quantity: 3, unit_price_cents: 33, vat_rate: 20, discount_percent: 10 },
    ]);
    // round(3 × 33 × 0.9) = round(89.1) = 89 net, per LINE after the discount.
    expect(offer.lines[0]!.net_cents).toBe(89);
    expect(offer.net_cents).toBe(89);
    expect(offer.vat_cents).toBe(18); // round(89 × 0.20) = round(17.8)
    expect(offer.gross_cents).toBe(107);
    expect(offer.discount_cents).toBe(10); // 99 gross-of-discount − 89 net
  });

  it('computes a per-rate VAT breakdown for a mixed-VAT, mixed-discount offer', async () => {
    const offer = await createDraft([
      { description: 'Zero-rated export', quantity: 2, unit_price_cents: 250, vat_rate: 0 },
      { description: 'Book (half price)', quantity: 1, unit_price_cents: 1_000, vat_rate: 10, discount_percent: 50 },
      { description: 'Sticker', quantity: 3, unit_price_cents: 33, vat_rate: 20, discount_percent: 10 },
    ]);
    expect(offer.vat_breakdown).toEqual([
      { rate: 0, base_cents: 500, vat_cents: 0 },
      { rate: 10, base_cents: 500, vat_cents: 50 },
      { rate: 20, base_cents: 89, vat_cents: 18 },
    ]);
    expect(offer.net_cents).toBe(1_089);
    expect(offer.vat_cents).toBe(68);
    expect(offer.gross_cents).toBe(1_157);
    expect(offer.discount_cents).toBe(510); // 1599 − 1089
  });

  it('never stores totals — every listed amount equals recomputation from lines', async () => {
    const rows = await listOffers();
    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const row of rows) {
      const lines = db
        .prepare('SELECT quantity, unit_price_cents, vat_rate, discount_percent FROM offer_lines WHERE offer_id = ?')
        .all(row.id) as { quantity: number; unit_price_cents: number; vat_rate: number; discount_percent: number }[];
      const totals = computeTotals(lines);
      expect(row.net_cents, `offer ${row.id} net`).toBe(totals.net_cents);
      expect(row.vat_cents, `offer ${row.id} vat`).toBe(totals.vat_cents);
      expect(row.gross_cents, `offer ${row.id} gross`).toBe(totals.gross_cents);
    }
  });

  it('validates lines (empty set, bad rate, negative price, bad discount)', async () => {
    const empty = await request(app)
      .post('/api/offers')
      .set('Cookie', cookie)
      .send({ customer_id: 1, title: 'x', lines: [] });
    expect(empty.status).toBe(422);

    const bad = await request(app)
      .post('/api/offers')
      .set('Cookie', cookie)
      .send({
        customer_id: 1,
        title: 'x',
        lines: [{ description: '', quantity: -1, unit_price_cents: 10.5, vat_rate: 19, discount_percent: 150 }],
      });
    expect(bad.status).toBe(422);
    const fields = bad.body.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        'lines[0].description',
        'lines[0].quantity',
        'lines[0].unit_price_cents',
        'lines[0].vat_rate',
        'lines[0].discount_percent',
      ]),
    );
  });
});

describe('numbering is gapless and sequential per year, assigned when sent', () => {
  it('drafts have no number; sending assigns the next one atomically', async () => {
    const draft = await createDraft();
    expect(draft.number).toBeNull();
    expect(draft.status).toBe('draft');
    expect(draft.sent_at).toBeNull();

    const year = Number(CLOCK.slice(0, 4));
    const before = maxSeq(year);
    const sent = await send(draft.id);
    expect(sent.number).toBe(`OFF-${year}-${String(before + 1).padStart(4, '0')}`);
    expect(sent.status).toBe('sent');
    expect(sent.sent_at).not.toBeNull();
  });

  it('several sends (fired together) draw consecutive numbers with no gaps or duplicates', async () => {
    const year = Number(CLOCK.slice(0, 4));
    const drafts = await Promise.all(Array.from({ length: 5 }, () => createDraft()));
    const before = maxSeq(year);

    const results = await Promise.all(drafts.map((d) => send(d.id)));
    const seqs = results.map((r) => Number(r.number!.split('-')[2])).sort((a, b) => a - b);
    expect(seqs).toEqual([before + 1, before + 2, before + 3, before + 4, before + 5]);

    const dup = db
      .prepare('SELECT COUNT(*) AS c FROM (SELECT number FROM offers WHERE number IS NOT NULL GROUP BY number HAVING COUNT(*) > 1)')
      .get() as { c: number };
    expect(dup.c).toBe(0);
  });

  it('deleting a draft leaves no gap because drafts never had a number', async () => {
    const year = Number(CLOCK.slice(0, 4));
    const doomed = await createDraft();
    const survivor = await createDraft();
    const before = maxSeq(year);

    const del = await request(app).delete(`/api/offers/${doomed.id}`).set('Cookie', cookie);
    expect(del.status).toBe(200);

    const sent = await send(survivor.id);
    expect(sent.number).toBe(`OFF-${year}-${String(before + 1).padStart(4, '0')}`);
  });

  it('the full number sequence per year is gapless: 1..maxSeq all exist exactly once', () => {
    const years = db.prepare('SELECT year, last_seq FROM offer_counters').all() as {
      year: number;
      last_seq: number;
    }[];
    expect(years.length).toBeGreaterThanOrEqual(2); // seed covers 2025 + 2026
    for (const { year, last_seq } of years) {
      const numbers = (
        db
          .prepare('SELECT number FROM offers WHERE number LIKE ? ORDER BY number')
          .all(`OFF-${year}-%`) as { number: string }[]
      ).map((r) => r.number);
      const expected = Array.from(
        { length: last_seq },
        (_, i) => `OFF-${year}-${String(i + 1).padStart(4, '0')}`,
      );
      expect(numbers, `year ${year}`).toEqual(expected);
    }
  });

  it('each year has its own sequence (sending under a 2025 clock continues the 2025 series)', async () => {
    const before2025 = maxSeq(2025);
    expect(before2025).toBeGreaterThanOrEqual(4); // from the seed
    const draft = await createDraft();
    const saved = CLOCK;
    CLOCK = '2025-12-31';
    try {
      const sent = await send(draft.id);
      expect(sent.number).toBe(`OFF-2025-${String(before2025 + 1).padStart(4, '0')}`);
    } finally {
      CLOCK = saved;
    }
  });

  it('sending a non-draft is a 409', async () => {
    const draft = await createDraft();
    await send(draft.id);
    const again = await request(app).post(`/api/offers/${draft.id}/send`).set('Cookie', cookie).send({});
    expect(again.status).toBe(409);
  });

  it('sending without a validity date is a 422', async () => {
    const draft = await createDraft(undefined, { valid_until: null });
    expect(draft.valid_until).toBeNull();
    const res = await request(app).post(`/api/offers/${draft.id}/send`).set('Cookie', cookie).send({});
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe('valid_until');
  });
});

describe('sent offers are immutable', () => {
  it('editing a sent offer → 409; drafts stay editable', async () => {
    const draft = await createDraft();
    const edit = await request(app)
      .put(`/api/offers/${draft.id}`)
      .set('Cookie', cookie)
      .send({
        customer_id: 2,
        title: 'Edited',
        valid_until: '2026-12-31',
        lines: [{ description: 'Edited line', quantity: 2, unit_price_cents: 5_000, vat_rate: 10 }],
      });
    expect(edit.status).toBe(200);
    expect(edit.body.customer_id).toBe(2);
    expect(edit.body.lines[0].description).toBe('Edited line');

    await send(draft.id);
    const after = await request(app)
      .put(`/api/offers/${draft.id}`)
      .set('Cookie', cookie)
      .send({
        customer_id: 2,
        title: 'Sneaky',
        valid_until: '2026-12-31',
        lines: [{ description: 'Sneaky edit', quantity: 1, unit_price_cents: 1, vat_rate: 0 }],
      });
    expect(after.status).toBe(409);
    expect(after.body.error).toContain('immutable');

    const unchanged = await detail(draft.id);
    expect(unchanged.lines[0]!.description).toBe('Edited line');
  });

  it('deleting a sent offer → 409 (only drafts may be deleted)', async () => {
    const draft = await createDraft();
    const sent = await send(draft.id);
    const del = await request(app).delete(`/api/offers/${draft.id}`).set('Cookie', cookie);
    expect(del.status).toBe(409);
    expect((await detail(draft.id)).number).toBe(sent.number);
  });
});

describe('revisions form an append-only supersession chain', () => {
  it('revising a sent offer supersedes it (keeping its number) and links the new draft back', async () => {
    const draft = await createDraft([
      { description: 'Original scope', quantity: 1, unit_price_cents: 100_000, vat_rate: 20 },
    ]);
    const original = await send(draft.id);
    expect(original.status).toBe('sent');

    const res = await request(app).post(`/api/offers/${original.id}/revise`).set('Cookie', cookie).send({});
    expect(res.status).toBe(201);
    const revision = res.body as OfferDetail;
    expect(revision.status).toBe('draft');
    expect(revision.number).toBeNull();
    expect(revision.supersedes_id).toBe(original.id);
    expect(revision.supersedes_number).toBe(original.number);
    // Content is copied.
    expect(revision.lines[0]!.description).toBe('Original scope');

    // The original is now superseded but keeps its number and points forward.
    const oldAfter = await detail(original.id);
    expect(oldAfter.status).toBe('superseded');
    expect(oldAfter.number).toBe(original.number);
    expect(oldAfter.superseded_by_id).toBe(revision.id);

    // Sending the revision assigns a NEW number; the chain persists.
    const revSent = await send(revision.id);
    expect(revSent.number).not.toBe(original.number);
    expect(revSent.supersedes_number).toBe(original.number);

    // An already-superseded offer cannot be revised again.
    const twice = await request(app).post(`/api/offers/${original.id}/revise`).set('Cookie', cookie).send({});
    expect(twice.status).toBe(409);
  });

  it('an accepted offer can be revised too (per the workflow)', async () => {
    const draft = await createDraft();
    const sent = await send(draft.id);
    await request(app).post(`/api/offers/${sent.id}/accept`).set('Cookie', cookie).send({});
    const res = await request(app).post(`/api/offers/${sent.id}/revise`).set('Cookie', cookie).send({});
    expect(res.status).toBe(201);
    expect((await detail(sent.id)).status).toBe('superseded');
  });

  it('the seed contains a superseded → accepted revision chain', async () => {
    // The seeded OFF-2026-0005 was superseded by OFF-2026-0006 (accepted).
    const superseded = (await listOffers('?search=OFF-2026-0005'))[0];
    expect(superseded).toBeDefined();
    const full = await detail(superseded!.id);
    expect(full.status).toBe('superseded');
    expect(full.number).toBe('OFF-2026-0005');
    expect(full.superseded_by_number).toBe('OFF-2026-0006');
  });
});

describe('expiry is derived from the validity date via the injected clock', () => {
  it('a sent offer becomes expired once the clock passes its validity, and back again', async () => {
    const draft = await createDraft(undefined, { valid_until: '2026-07-25' });
    const saved = CLOCK;
    CLOCK = '2026-07-20';
    const sent = await send(draft.id);
    expect(sent.status).toBe('sent');
    expect(sent.expired).toBe(false);

    CLOCK = '2026-07-26'; // one day past validity
    const later = await detail(draft.id);
    expect(later.status).toBe('expired');
    expect(later.expired).toBe(true);

    CLOCK = '2026-07-20'; // back before validity — no stored flag to be wrong
    const back = await detail(draft.id);
    expect(back.status).toBe('sent');
    expect(back.expired).toBe(false);

    CLOCK = saved;

    // No "expired"/"status=expired" column exists to drift.
    const columns = db.prepare("SELECT name FROM pragma_table_info('offers')").all() as { name: string }[];
    expect(columns.map((c) => c.name)).not.toContain('expired');
  });

  it('accepting or rejecting an expired offer → 409', async () => {
    const draft = await createDraft(undefined, { valid_until: '2026-07-25' });
    const saved = CLOCK;
    CLOCK = '2026-07-20';
    const sent = await send(draft.id);

    CLOCK = '2026-08-01'; // expired
    const accept = await request(app).post(`/api/offers/${sent.id}/accept`).set('Cookie', cookie).send({});
    expect(accept.status).toBe(409);
    const reject = await request(app).post(`/api/offers/${sent.id}/reject`).set('Cookie', cookie).send({});
    expect(reject.status).toBe(409);
    CLOCK = saved;
  });

  it('?status=expired returns exactly the derived-expired rows', async () => {
    const rows = await listOffers('?status=expired');
    expect(rows.length).toBeGreaterThanOrEqual(1); // seed has an expired offer
    for (const row of rows) {
      expect(row.status).toBe('expired');
      expect(row.expired).toBe(true);
    }
  });
});

describe('accept / reject and the append-only status timeline', () => {
  it('an admin decision appends an event and flips the status', async () => {
    const draft = await createDraft();
    const sent = await send(draft.id);
    const before = (await detail(sent.id)).events.length;

    const res = await request(app)
      .post(`/api/offers/${sent.id}/accept`)
      .set('Cookie', cookie)
      .send({ note: 'Signed off' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');

    const events = (await detail(sent.id)).events;
    expect(events.length).toBe(before + 1);
    const last = events[events.length - 1]!;
    expect(last.event).toBe('accepted');
    expect(last.note).toBe('Signed off');

    // A second decision on a decided offer → 409, and no event is lost.
    const again = await request(app).post(`/api/offers/${sent.id}/reject`).set('Cookie', cookie).send({});
    expect(again.status).toBe(409);
    expect((await detail(sent.id)).events.length).toBe(before + 1);
  });

  it('the timeline is chronological and starts with a created event', async () => {
    const draft = await createDraft();
    const sent = await send(draft.id);
    const events = (await detail(sent.id)).events;
    expect(events[0]!.event).toBe('created');
    expect(events.some((e) => e.event === 'sent')).toBe(true);
    const times = events.map((e) => e.created_at);
    expect([...times].sort()).toEqual(times);
  });
});

describe('public acceptance link (HMAC token)', () => {
  async function sentWithToken(): Promise<{ ref: string; token: string; id: number }> {
    const draft = await createDraft();
    const sent = await send(draft.id);
    const full = await detail(sent.id);
    return { ref: full.number!, token: full.public_token!, id: sent.id };
  }

  it('serves the offer read-only for a valid token', async () => {
    const { ref, token } = await sentWithToken();
    const res = await request(app).get(`/api/public/offers/${ref}?token=${token}`);
    expect(res.status).toBe(200);
    const body = res.body as PublicOffer;
    expect(body.number).toBe(ref);
    expect(body.decidable).toBe(true);
    expect(body.seller_name).toBe(seller.name);
  });

  it('a missing/wrong/foreign token → 404 (same as an unknown ref, so refs leak nothing)', async () => {
    const { ref } = await sentWithToken();
    const noToken = await request(app).get(`/api/public/offers/${ref}`);
    expect(noToken.status).toBe(404);
    const wrong = await request(app).get(`/api/public/offers/${ref}?token=deadbeef`);
    expect(wrong.status).toBe(404);
    // A token minted for a DIFFERENT ref must not open this offer.
    const foreign = offerToken(auth.secret, 'OFF-2026-9999');
    const cross = await request(app).get(`/api/public/offers/${ref}?token=${foreign}`);
    expect(cross.status).toBe(404);
  });

  it('accepting via the link records a customer event and flips the status', async () => {
    const { ref, token, id } = await sentWithToken();
    const res = await request(app).post(`/api/public/offers/${ref}/accept?token=${token}`).send({ note: 'Looks good' });
    expect(res.status).toBe(200);
    expect((res.body as PublicOffer).status).toBe('accepted');

    const full = await detail(id);
    expect(full.status).toBe('accepted');
    const last = full.events[full.events.length - 1]!;
    expect(last.event).toBe('accepted');
    expect(last.actor).toBe('customer');
    expect(last.note).toBe('Looks good');
  });

  it('rejecting via the link flips the status to rejected', async () => {
    const { ref, token, id } = await sentWithToken();
    const res = await request(app).post(`/api/public/offers/${ref}/reject?token=${token}`).send({});
    expect(res.status).toBe(200);
    expect((await detail(id)).status).toBe('rejected');
  });

  it('accepting via the link with a wrong token → 404 (before any state change)', async () => {
    const { ref, id } = await sentWithToken();
    const res = await request(app).post(`/api/public/offers/${ref}/accept?token=wrong`).send({});
    expect(res.status).toBe(404);
    expect((await detail(id)).status).toBe('sent');
  });

  it('accepting an expired offer via the link → 409 with a clear message', async () => {
    const draft = await createDraft(undefined, { valid_until: '2026-07-25' });
    const saved = CLOCK;
    CLOCK = '2026-07-20';
    const sent = await send(draft.id);
    const token = (await detail(sent.id)).public_token!;
    const ref = sent.number!;

    CLOCK = '2026-08-01'; // expired
    const res = await request(app).post(`/api/public/offers/${ref}/accept?token=${token}`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('expired');
    CLOCK = saved;
  });
});

describe('withdrawal keeps the number', () => {
  it('withdraws a sent offer, keeps its number, and blocks a decision', async () => {
    const draft = await createDraft();
    const sent = await send(draft.id);
    const res = await request(app)
      .post(`/api/offers/${sent.id}/withdraw`)
      .set('Cookie', cookie)
      .send({ reason: 'Replaced by a contract' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('withdrawn');
    expect(res.body.number).toBe(sent.number);

    const accept = await request(app).post(`/api/offers/${sent.id}/accept`).set('Cookie', cookie).send({});
    expect(accept.status).toBe(409);
  });
});

describe('customers', () => {
  it('round-trips a customer and archives one that has offers', async () => {
    const created = await request(app)
      .post('/api/customers')
      .set('Cookie', cookie)
      .send({
        name: 'Testkunde GmbH',
        contact_person: 'Max Muster',
        email: 'test@example.at',
        vat_id: 'ATU99999999',
        address: 'Teststraße 1\n1010 Wien',
      });
    expect(created.status).toBe(201);
    const id = created.body.id as number;

    const deleted = await request(app).delete(`/api/customers/${id}`).set('Cookie', cookie);
    expect(deleted.status).toBe(200); // no offers → hard delete allowed

    // Customer 1 has offers → cannot be deleted, must be archived.
    const del = await request(app).delete('/api/customers/1').set('Cookie', cookie);
    expect(del.status).toBe(409);

    const archived = await request(app).post('/api/customers/1/archive').set('Cookie', cookie).send({});
    expect(archived.status).toBe(200);
    expect(archived.body.archived_at).not.toBeNull();
    const unarchived = await request(app).post('/api/customers/1/unarchive').set('Cookie', cookie).send({});
    expect(unarchived.body.archived_at).toBeNull();
  });

  it('validates name and email', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('Cookie', cookie)
      .send({ name: '', email: 'not-an-email' });
    expect(res.status).toBe(422);
    const fields = res.body.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['name', 'email']));
  });
});

describe('offer list & CSV', () => {
  it('filters by search and by derived status', async () => {
    const byTitle = await listOffers('?search=Fleet');
    expect(byTitle.length).toBeGreaterThanOrEqual(1);

    for (const status of ['draft', 'sent', 'accepted', 'rejected', 'superseded', 'expired'] as const) {
      const rows = await listOffers(`?status=${status}`);
      for (const row of rows) expect(row.status).toBe(status);
    }
    const bad = await request(app).get('/api/offers?status=bogus').set('Cookie', cookie);
    expect(bad.status).toBe(422);
  });

  it('exports CSV with derived money and status columns', async () => {
    const res = await request(app).get('/api/offers/export.csv').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe('number,title,customer_name,status,valid_until,sent_at,net_cents,vat_cents,gross_cents,created_at');
    expect(lines.length).toBeGreaterThanOrEqual(12);
  });

  it('computes derived dashboard stats for a period', async () => {
    const res = await request(app).get('/api/stats?period=2026').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.period).toBe(2026);
    expect(res.body.accepted_count).toBeGreaterThanOrEqual(1);
    expect(res.body.win_rate_pct).toBeGreaterThanOrEqual(0);
    expect(res.body.win_rate_pct).toBeLessThanOrEqual(100);
  });
});

describe('PDF export', () => {
  const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };

  async function fetchPdf(id: number): Promise<{ status: number; type: string; body: Buffer }> {
    const res = await request(app)
      .get(`/api/offers/${id}/pdf`)
      .set('Cookie', cookie)
      .buffer(true)
      .parse(binary);
    return { status: res.status, type: res.headers['content-type'] ?? '', body: res.body as Buffer };
  }

  it('returns a valid, nontrivial PDF for a sent offer', async () => {
    const rows = await listOffers('?status=accepted');
    const { status, type, body } = await fetchPdf(rows[0]!.id);
    expect(status).toBe(200);
    expect(type).toContain('application/pdf');
    expect(body.length).toBeGreaterThan(1_500);
    expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(body.toString('latin1')).toContain('%%EOF');
    expect(body.toString('latin1')).toContain(rows[0]!.number!);
  });

  it('renders a draft with a DRAFT marker', async () => {
    const drafts = await listOffers('?status=draft');
    const draftPdf = await fetchPdf(drafts[0]!.id);
    expect(draftPdf.status).toBe(200);
    expect(draftPdf.body.toString('latin1')).toContain('DRAFT');
  });

  it('is 404 for a missing offer and 401 without a session', async () => {
    const missing = await request(app).get('/api/offers/99999/pdf').set('Cookie', cookie);
    expect(missing.status).toBe(404);
    const unauth = await request(app).get('/api/offers/1/pdf');
    expect(unauth.status).toBe(401);
  });
});
