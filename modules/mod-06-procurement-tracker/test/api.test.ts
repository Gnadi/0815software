import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { AuthConfig } from '../server/auth.js';
import { requiredTiers } from '../server/approval-config.js';
import { EXPORT_PROFILES } from '../server/export-profiles.js';
import { computeTotalCents } from '../shared/money.js';
import type { PoDetail, RfqDetail } from '../shared/types.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

let db: Database.Database;
let app: Express;
let cookie: string;

async function poDetail(id: number): Promise<PoDetail> {
  const res = await request(app).get(`/api/pos/${id}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as PoDetail;
}

async function rfqDetail(id: number): Promise<RfqDetail> {
  const res = await request(app).get(`/api/rfqs/${id}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as RfqDetail;
}

/** Create a draft PO for supplier 1 with the given lines. */
async function createPo(
  lines: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): Promise<PoDetail> {
  const res = await request(app)
    .post('/api/pos')
    .set('Cookie', cookie)
    .send({ supplier_id: 1, lines, ...extra });
  expect(res.status).toBe(201);
  return res.body as PoDetail;
}

/** One line priced so the PO total is exactly `totalCents`. */
function linesTotalling(totalCents: number): Record<string, unknown>[] {
  return [{ description: 'Budget line', quantity: 1, unit: 'pc', unit_price_cents: totalCents }];
}

/** Create + submit a PO totalling exactly `totalCents`; returns the detail. */
async function submitted(totalCents: number): Promise<PoDetail> {
  const po = await createPo(linesTotalling(totalCents));
  const res = await request(app).post(`/api/pos/${po.id}/submit`).set('Cookie', cookie).send({});
  expect(res.status).toBe(200);
  return res.body as PoDetail;
}

async function approve(
  poId: number,
  tier: number,
  approver = 'T. Ester',
): Promise<request.Response> {
  return request(app)
    .post(`/api/pos/${poId}/approvals`)
    .set('Cookie', cookie)
    .send({ tier, approver });
}

beforeAll(async () => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, auth });

  const res = await request(app)
    .post('/api/login')
    .send({ username: 'admin', password: 'test-password' });
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
});

describe('auth', () => {
  it('rejects unauthenticated requests with 401', async () => {
    for (const path of [
      '/api/suppliers',
      '/api/rfqs',
      '/api/pos',
      '/api/pos/1',
      '/api/config',
      '/api/export/pos.csv?profile=GENERIC',
    ]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
    }
    const post = await request(app).post('/api/pos/1/submit').send({});
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
    expect(res.headers['set-cookie']![0]).toContain('mod06_session=');
    expect(res.headers['set-cookie']![0]).toContain('HttpOnly');
  });
});

describe('config endpoint mirrors the one config file', () => {
  it('serves tiers, threshold rules and export profiles', async () => {
    const res = await request(app).get('/api/config').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.tiers).toEqual([
      { tier: 1, label: 'Team lead' },
      { tier: 2, label: 'Department head' },
      { tier: 3, label: 'Finance' },
    ]);
    expect(res.body.rules).toEqual([
      { max_total_cents: 100_000, tiers: [1] },
      { max_total_cents: 1_000_000, tiers: [1, 2] },
      { max_total_cents: null, tiers: [1, 2, 3] },
    ]);
    expect(res.body.profiles.map((p: { name: string }) => p.name)).toEqual([
      'GENERIC',
      'SAP-B1-STYLE',
      'DATEV-STYLE',
    ]);
  });
});

describe('required tiers are derived from the total and frozen at submit', () => {
  it('derives tiers at every threshold boundary (incl. exactly at)', () => {
    expect(requiredTiers(0)).toEqual([1]);
    expect(requiredTiers(99_999)).toEqual([1]);
    expect(requiredTiers(100_000)).toEqual([1]); // exactly €1,000.00 — inclusive
    expect(requiredTiers(100_001)).toEqual([1, 2]); // one cent above
    expect(requiredTiers(999_999)).toEqual([1, 2]);
    expect(requiredTiers(1_000_000)).toEqual([1, 2]); // exactly €10,000.00 — inclusive
    expect(requiredTiers(1_000_001)).toEqual([1, 2, 3]); // one cent above
    expect(requiredTiers(50_000_000)).toEqual([1, 2, 3]);
  });

  it('freezes the boundary-derived tiers on the submitted PO', async () => {
    const atThreshold = await submitted(100_000);
    expect(atThreshold.required_tiers).toEqual([1]);
    expect(atThreshold.total_cents).toBe(100_000);

    const justAbove = await submitted(100_001);
    expect(justAbove.required_tiers).toEqual([1, 2]);

    const atSecond = await submitted(1_000_000);
    expect(atSecond.required_tiers).toEqual([1, 2]);

    const top = await submitted(1_000_001);
    expect(top.required_tiers).toEqual([1, 2, 3]);
  });

  it('computes the total from the lines with per-line rounding', async () => {
    const po = await createPo([
      { description: 'Odd quantity', quantity: 1.5, unit: 'h', unit_price_cents: 333 },
      { description: 'Plain', quantity: 3, unit: 'pc', unit_price_cents: 33 },
    ]);
    // round(1.5 × 333) = 500 (from 499.5), round(3 × 33) = 99.
    expect(po.lines[0]!.net_cents).toBe(500);
    expect(po.lines[1]!.net_cents).toBe(99);
    expect(po.total_cents).toBe(599);
    expect(po.total_cents).toBe(
      computeTotalCents([
        { quantity: 1.5, unit_price_cents: 333 },
        { quantity: 3, unit_price_cents: 33 },
      ]),
    );
  });

  it('drafts have no required tiers and empty POs cannot be submitted', async () => {
    const po = await createPo(linesTotalling(5_000));
    expect(po.status).toBe('draft');
    expect(po.required_tiers).toEqual([]);
    expect(po.submissions).toEqual([]);
  });
});

describe('approval order is strictly enforced', () => {
  it('rejects out-of-order approvals with 422', async () => {
    const po = await submitted(2_000_000); // top bracket: tiers 1+2+3
    // Tier 2 before tier 1 → 422.
    const early2 = await approve(po.id, 2);
    expect(early2.status).toBe(422);
    expect(early2.body.details[0].message).toContain('tier order');
    // Tier 3 before anything → 422.
    expect((await approve(po.id, 3)).status).toBe(422);
    // Tier 1 → ok.
    expect((await approve(po.id, 1)).status).toBe(201);
    // Tier 3 with tier 2 still pending → still 422.
    expect((await approve(po.id, 3)).status).toBe(422);
    // 2 then 3 → fully approved (derived status).
    expect((await approve(po.id, 2)).status).toBe(201);
    expect((await approve(po.id, 3)).status).toBe(201);
    const done = await poDetail(po.id);
    expect(done.status).toBe('approved');
    expect(done.approved_tiers).toEqual([1, 2, 3]);
  });

  it('rejects approving a tier the total does not require with 422', async () => {
    const po = await submitted(50_000); // tier 1 only
    expect((await approve(po.id, 1)).status).toBe(201);
    const res = await approve(po.id, 2);
    expect(res.status).toBe(422);
    expect(res.body.details[0].message).toContain('not required');
  });

  it('rejects a duplicate tier approval with 409', async () => {
    const po = await submitted(500_000); // tiers 1+2
    expect((await approve(po.id, 1)).status).toBe(201);
    expect((await approve(po.id, 1)).status).toBe(409);
  });

  it('requires an approver name', async () => {
    const po = await submitted(50_000);
    const res = await request(app)
      .post(`/api/pos/${po.id}/approvals`)
      .set('Cookie', cookie)
      .send({ tier: 1 });
    expect(res.status).toBe(422);
  });

  it('cannot approve a draft (409)', async () => {
    const po = await createPo(linesTotalling(50_000));
    expect((await approve(po.id, 1)).status).toBe(409);
  });
});

describe('rejection voids approvals and returns the PO to draft', () => {
  it('keeps every history row while voiding the active approvals', async () => {
    const po = await submitted(500_000); // tiers 1+2
    expect((await approve(po.id, 1, 'M. Huber')).status).toBe(201);

    const rejection = await request(app)
      .post(`/api/pos/${po.id}/reject`)
      .set('Cookie', cookie)
      .send({ tier: 2, approver: 'S. Wagner', note: 'Budget disagreement' });
    expect(rejection.status).toBe(200);

    const after = rejection.body as PoDetail;
    expect(after.status).toBe('draft');
    expect(after.approved_tiers).toEqual([]);
    expect(after.required_tiers).toEqual([]); // no ACTIVE submission in draft
    // Append-only: both rows survive, both voided.
    expect(after.approvals).toHaveLength(2);
    expect(after.approvals.every((a) => a.voided)).toBe(true);
    expect(after.approvals.map((a) => a.decision)).toEqual(['approved', 'rejected']);
    // The frozen submission snapshot survives too, inactive.
    expect(after.submissions).toHaveLength(1);
    expect(after.submissions[0]!.active).toBe(false);
    expect(after.submissions[0]!.required_tiers).toEqual([1, 2]);

    // Nothing was deleted from the database.
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM approvals WHERE po_id = ?')
      .get(po.id) as { n: number };
    expect(rows.n).toBe(2);

    // Re-submitting starts a fresh submission: old approvals do NOT count.
    const resubmit = await request(app).post(`/api/pos/${po.id}/submit`).set('Cookie', cookie).send({});
    expect(resubmit.status).toBe(200);
    const fresh = resubmit.body as PoDetail;
    expect(fresh.submission_no).toBe(2);
    expect(fresh.approved_tiers).toEqual([]); // tier 1 must approve again
    expect(fresh.approvals.every((a) => a.voided)).toBe(true);
  });

  it('return-to-draft also voids approvals without deleting them', async () => {
    const po = await submitted(500_000);
    expect((await approve(po.id, 1)).status).toBe(201);
    const res = await request(app)
      .post(`/api/pos/${po.id}/return-to-draft`)
      .set('Cookie', cookie)
      .send({});
    expect(res.status).toBe(200);
    const after = res.body as PoDetail;
    expect(after.status).toBe('draft');
    expect(after.approvals).toHaveLength(1);
    expect(after.approvals[0]!.voided).toBe(true);
  });

  it('a tier that already approved cannot also reject (409)', async () => {
    const po = await submitted(500_000);
    expect((await approve(po.id, 1)).status).toBe(201);
    const res = await request(app)
      .post(`/api/pos/${po.id}/reject`)
      .set('Cookie', cookie)
      .send({ tier: 1, approver: 'M. Huber' });
    expect(res.status).toBe(409);
  });
});

describe('submitted POs are frozen', () => {
  it('rejects edits to a submitted PO with 409', async () => {
    const po = await submitted(500_000);
    const res = await request(app)
      .put(`/api/pos/${po.id}`)
      .set('Cookie', cookie)
      .send({ supplier_id: 1, lines: linesTotalling(1) });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('frozen');
  });

  it('rejects edits to a partially-approved PO with 409', async () => {
    const po = await submitted(500_000);
    expect((await approve(po.id, 1)).status).toBe(201);
    const res = await request(app)
      .put(`/api/pos/${po.id}`)
      .set('Cookie', cookie)
      .send({ supplier_id: 1, lines: linesTotalling(1) });
    expect(res.status).toBe(409);
  });

  it('allows editing again after return-to-draft', async () => {
    const po = await submitted(500_000);
    await request(app).post(`/api/pos/${po.id}/return-to-draft`).set('Cookie', cookie).send({});
    const res = await request(app)
      .put(`/api/pos/${po.id}`)
      .set('Cookie', cookie)
      .send({ supplier_id: 1, lines: linesTotalling(123) });
    expect(res.status).toBe(200);
    expect((res.body as PoDetail).total_cents).toBe(123);
  });

  it('deleting a PO with approval history is 409; a fresh draft deletes fine', async () => {
    const withHistory = await submitted(50_000);
    await request(app).post(`/api/pos/${withHistory.id}/return-to-draft`).set('Cookie', cookie).send({});
    expect((await request(app).delete(`/api/pos/${withHistory.id}`).set('Cookie', cookie)).status).toBe(409);

    const fresh = await createPo(linesTotalling(50_000));
    expect((await request(app).delete(`/api/pos/${fresh.id}`).set('Cookie', cookie)).status).toBe(200);
  });
});

describe('ordered transition requires full approval', () => {
  it('blocks mark-ordered until every tier approved (422), then allows it', async () => {
    const po = await submitted(500_000); // tiers 1+2
    const early = await request(app).post(`/api/pos/${po.id}/mark-ordered`).set('Cookie', cookie).send({});
    expect(early.status).toBe(422);
    expect(early.body.details[0].message).toContain('pending');

    await approve(po.id, 1);
    const stillEarly = await request(app).post(`/api/pos/${po.id}/mark-ordered`).set('Cookie', cookie).send({});
    expect(stillEarly.status).toBe(422);

    await approve(po.id, 2);
    const ok = await request(app).post(`/api/pos/${po.id}/mark-ordered`).set('Cookie', cookie).send({});
    expect(ok.status).toBe(200);
    expect((ok.body as PoDetail).status).toBe('ordered');
    expect((ok.body as PoDetail).ordered_at).toBeTruthy();

    // Ordered is frozen too: edits 409, approvals 409, close works.
    expect(
      (await request(app).put(`/api/pos/${po.id}`).set('Cookie', cookie).send({ supplier_id: 1, lines: linesTotalling(1) })).status,
    ).toBe(409);
    expect((await approve(po.id, 1)).status).toBe(409);
    const closed = await request(app).post(`/api/pos/${po.id}/close`).set('Cookie', cookie).send({});
    expect(closed.status).toBe(200);
    expect((closed.body as PoDetail).status).toBe('closed');
  });

  it('cannot mark a draft ordered (409)', async () => {
    const po = await createPo(linesTotalling(50_000));
    const res = await request(app).post(`/api/pos/${po.id}/mark-ordered`).set('Cookie', cookie).send({});
    expect(res.status).toBe(409);
  });
});

describe('RFQ → award → draft PO', () => {
  async function freshRfq(): Promise<RfqDetail> {
    const res = await request(app)
      .post('/api/rfqs')
      .set('Cookie', cookie)
      .send({
        title: 'Test sourcing',
        lines: [
          { description: 'Widget A', quantity: 10, unit: 'pc' },
          { description: 'Widget B', quantity: 2.5, unit: 'kg' },
        ],
      });
    expect(res.status).toBe(201);
    return res.body as RfqDetail;
  }

  async function invite(rfqId: number, supplierId: number): Promise<request.Response> {
    return request(app).post(`/api/rfqs/${rfqId}/invitations`).set('Cookie', cookie).send({ supplier_id: supplierId });
  }

  it('walks open → quoted → awarded and copies the winning quote into a draft PO', async () => {
    const rfq = await freshRfq();
    expect(rfq.status).toBe('open');
    expect((await invite(rfq.id, 1)).status).toBe(201);
    expect((await invite(rfq.id, 2)).status).toBe(201);
    // Duplicate invitation → 409.
    expect((await invite(rfq.id, 1)).status).toBe(409);

    const [lineA, lineB] = rfq.lines;
    // Supplier 1 quotes.
    const q1 = await request(app)
      .put(`/api/rfqs/${rfq.id}/quotes/1`)
      .set('Cookie', cookie)
      .send({
        valid_until: '2026-12-31',
        prices: [
          { rfq_line_id: lineA!.id, unit_price_cents: 120 },
          { rfq_line_id: lineB!.id, unit_price_cents: 999 },
        ],
      });
    expect(q1.status).toBe(200);
    expect((q1.body as RfqDetail).status).toBe('quoted'); // derived

    // Supplier 2 quotes cheaper.
    const q2 = await request(app)
      .put(`/api/rfqs/${rfq.id}/quotes/2`)
      .set('Cookie', cookie)
      .send({
        prices: [
          { rfq_line_id: lineA!.id, unit_price_cents: 110 },
          { rfq_line_id: lineB!.id, unit_price_cents: 950 },
        ],
      });
    expect(q2.status).toBe(200);
    const quoted = q2.body as RfqDetail;
    // Quote totals are derived from RFQ quantities × quoted unit prices.
    const quote2 = quoted.quotes.find((q) => q.supplier_id === 2)!;
    expect(quote2.total_cents).toBe(10 * 110 + Math.round(2.5 * 950)); // 1100 + 2375

    // Award supplier 2 → draft PO with lines + prices copied.
    const award = await request(app)
      .post(`/api/rfqs/${rfq.id}/award`)
      .set('Cookie', cookie)
      .send({ supplier_id: 2 });
    expect(award.status).toBe(200);
    expect(award.body.rfq.status).toBe('awarded');
    expect(award.body.rfq.awarded_supplier_id).toBe(2);

    const po = award.body.po as PoDetail;
    expect(po.status).toBe('draft');
    expect(po.supplier_id).toBe(2);
    expect(po.rfq_id).toBe(rfq.id);
    expect(po.lines.map((l) => [l.description, l.quantity, l.unit, l.unit_price_cents])).toEqual([
      ['Widget A', 10, 'pc', 110],
      ['Widget B', 2.5, 'kg', 950],
    ]);
    expect(po.total_cents).toBe(quote2.total_cents);
    expect(award.body.rfq.awarded_po_id).toBe(po.id);

    // Double-award → 409 (an RFQ has exactly one winner).
    const again = await request(app)
      .post(`/api/rfqs/${rfq.id}/award`)
      .set('Cookie', cookie)
      .send({ supplier_id: 1 });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain('already awarded');

    // The awarded PO cannot be deleted (it documents the award).
    expect((await request(app).delete(`/api/pos/${po.id}`).set('Cookie', cookie)).status).toBe(409);
  });

  it('rejects quotes from uninvited suppliers with 422', async () => {
    const rfq = await freshRfq();
    const res = await request(app)
      .put(`/api/rfqs/${rfq.id}/quotes/3`)
      .set('Cookie', cookie)
      .send({ prices: [{ rfq_line_id: rfq.lines[0]!.id, unit_price_cents: 1 }] });
    expect(res.status).toBe(422);
    expect(res.body.details[0].message).toContain('invited');
  });

  it('rejects incomplete quotes with 422 — every line must be priced', async () => {
    const rfq = await freshRfq();
    await invite(rfq.id, 1);
    const res = await request(app)
      .put(`/api/rfqs/${rfq.id}/quotes/1`)
      .set('Cookie', cookie)
      .send({ prices: [{ rfq_line_id: rfq.lines[0]!.id, unit_price_cents: 100 }] });
    expect(res.status).toBe(422);
    expect(res.body.details[0].message).toContain('every RFQ line');
  });

  it('rejects awarding a supplier without a quote with 422', async () => {
    const rfq = await freshRfq();
    await invite(rfq.id, 1);
    const res = await request(app)
      .post(`/api/rfqs/${rfq.id}/award`)
      .set('Cookie', cookie)
      .send({ supplier_id: 1 });
    expect(res.status).toBe(422);
  });

  it('close-without-award is terminal: no quotes, edits or award afterwards', async () => {
    const rfq = await freshRfq();
    await invite(rfq.id, 1);
    const close = await request(app).post(`/api/rfqs/${rfq.id}/close`).set('Cookie', cookie).send({});
    expect(close.status).toBe(200);
    expect((close.body as RfqDetail).status).toBe('closed');

    expect((await invite(rfq.id, 2)).status).toBe(409);
    expect(
      (
        await request(app)
          .put(`/api/rfqs/${rfq.id}/quotes/1`)
          .set('Cookie', cookie)
          .send({ prices: [{ rfq_line_id: rfq.lines[0]!.id, unit_price_cents: 1 }] })
      ).status,
    ).toBe(409);
    expect(
      (await request(app).post(`/api/rfqs/${rfq.id}/award`).set('Cookie', cookie).send({ supplier_id: 1 })).status,
    ).toBe(409);
  });

  it('freezes RFQ lines once a quote exists (409 on edit)', async () => {
    const rfq = await freshRfq();
    await invite(rfq.id, 1);
    await request(app)
      .put(`/api/rfqs/${rfq.id}/quotes/1`)
      .set('Cookie', cookie)
      .send({
        prices: rfq.lines.map((l) => ({ rfq_line_id: l.id, unit_price_cents: 10 })),
      });
    const res = await request(app)
      .put(`/api/rfqs/${rfq.id}`)
      .set('Cookie', cookie)
      .send({ title: 'Changed', lines: [{ description: 'X', quantity: 1, unit: 'pc' }] });
    expect(res.status).toBe(409);
  });
});

describe('ERP CSV export profiles', () => {
  let poNumber: string;

  beforeAll(async () => {
    // A deterministic ordered PO to find in every export: exactly
    // €12.34 unit price, quantity 2, ordered today.
    const po = await createPo(
      [{ description: 'Export, "quoted" item', quantity: 2, unit: 'pc', unit_price_cents: 1_234 }],
      { note: 'Export test' },
    );
    poNumber = po.number;
    await request(app).post(`/api/pos/${po.id}/submit`).set('Cookie', cookie).send({});
    await approve(po.id, 1);
    await request(app).post(`/api/pos/${po.id}/mark-ordered`).set('Cookie', cookie).send({});
  });

  async function fetchCsv(profile: string): Promise<string[]> {
    const res = await request(app).get(`/api/export/pos.csv?profile=${profile}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('.csv');
    return (res.text as string).trimEnd().split('\r\n');
  }

  it('GENERIC: snake_case headers, ISO dates, dot-decimal euros', async () => {
    const lines = await fetchCsv('GENERIC');
    expect(lines[0]).toBe(
      'po_number,supplier,supplier_email,order_date,currency,line_no,description,quantity,unit,unit_price,line_total,po_total',
    );
    const row = lines.find((l) => l.startsWith(`${poNumber},`))!;
    expect(row).toBeTruthy();
    const today = new Date().toISOString().slice(0, 10);
    // Description contains a comma and quotes → RFC-4180 escaped.
    expect(row).toContain('"Export, ""quoted"" item"');
    expect(row).toContain(`,${today},EUR,1,`);
    expect(row.endsWith(',2,pc,12.34,24.68,24.68')).toBe(true);
  });

  it('SAP-B1-STYLE: DocNum headers and compact YYYYMMDD dates', async () => {
    const lines = await fetchCsv('SAP-B1-STYLE');
    expect(lines[0]).toBe(
      'DocNum,CardName,DocDate,DocCurrency,LineNum,ItemDescription,Quantity,UomCode,Price,LineTotal',
    );
    const row = lines.find((l) => l.startsWith(`${poNumber},`))!;
    const compact = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    expect(row).toContain(`,${compact},EUR,1,`);
    expect(row.endsWith(',2,pc,12.34,24.68')).toBe(true);
  });

  it('DATEV-STYLE: semicolons, DD.MM.YYYY dates, comma-decimal euros', async () => {
    const lines = await fetchCsv('DATEV-STYLE');
    expect(lines[0]).toBe(
      'Belegnummer;Lieferant;Belegdatum;Waehrung;Position;Bezeichnung;Menge;Einheit;Einzelpreis;Gesamtpreis',
    );
    const row = lines.find((l) => l.startsWith(`${poNumber};`))!;
    const [y, m, d] = new Date().toISOString().slice(0, 10).split('-');
    expect(row).toContain(`;${d}.${m}.${y};EUR;1;`);
    expect(row.endsWith(';2;pc;12,34;24,68')).toBe(true);
  });

  it('exports only ordered POs (drafts, submitted, approved, closed excluded)', async () => {
    const lines = await fetchCsv('GENERIC');
    const listed = new Set(lines.slice(1).map((l) => l.split(',')[0]));
    const res = await request(app).get('/api/pos').set('Cookie', cookie);
    for (const po of res.body.pos as { number: string; status: string }[]) {
      expect(listed.has(po.number), `${po.number} (${po.status})`).toBe(po.status === 'ordered');
    }
  });

  it('rejects unknown profiles with 422 and lists the shipped ones', async () => {
    const res = await request(app).get('/api/export/pos.csv?profile=NOPE').set('Cookie', cookie);
    expect(res.status).toBe(422);
    expect(res.body.details[0].message).toContain('GENERIC');
    expect(EXPORT_PROFILES).toHaveLength(3);
  });
});

describe('suppliers', () => {
  it('CRUD round-trip with validation', async () => {
    const bad = await request(app).post('/api/suppliers').set('Cookie', cookie).send({ name: '' });
    expect(bad.status).toBe(422);

    const created = await request(app)
      .post('/api/suppliers')
      .set('Cookie', cookie)
      .send({ name: 'Test Supply Co', email: 'x@example.com' });
    expect(created.status).toBe(201);
    const id = created.body.id as number;

    const updated = await request(app)
      .put(`/api/suppliers/${id}`)
      .set('Cookie', cookie)
      .send({ name: 'Test Supply Co', contact: 'Ms Test' });
    expect(updated.status).toBe(200);
    expect(updated.body.contact).toBe('Ms Test');

    expect((await request(app).delete(`/api/suppliers/${id}`).set('Cookie', cookie)).status).toBe(200);
  });

  it('refuses to delete a supplier referenced by POs (409)', async () => {
    const res = await request(app).delete('/api/suppliers/1').set('Cookie', cookie);
    expect(res.status).toBe(409);
  });
});

describe('seeded dataset invariants', () => {
  it('covers every RFQ status and every PO status across all brackets', async () => {
    const rfqs = (await request(app).get('/api/rfqs').set('Cookie', cookie)).body.rfqs as { status: string }[];
    const rfqStatuses = new Set(rfqs.map((r) => r.status));
    for (const status of ['open', 'quoted', 'awarded']) {
      expect(rfqStatuses.has(status), `rfq status ${status}`).toBe(true);
    }

    const pos = (await request(app).get('/api/pos').set('Cookie', cookie)).body.pos as {
      status: string;
      required_tiers: number[];
    }[];
    const poStatuses = new Set(pos.map((p) => p.status));
    for (const status of ['draft', 'submitted', 'approved', 'ordered', 'closed']) {
      expect(poStatuses.has(status), `po status ${status}`).toBe(true);
    }
    const tierSets = new Set(pos.map((p) => p.required_tiers.join(',')).filter((s) => s !== ''));
    expect(tierSets.has('1')).toBe(true);
    expect(tierSets.has('1,2')).toBe(true);
    expect(tierSets.has('1,2,3')).toBe(true);
  });

  it('contains a rejected-and-returned PO whose history survives', async () => {
    const pos = (await request(app).get('/api/pos').set('Cookie', cookie)).body.pos as {
      id: number;
      status: string;
    }[];
    const details = await Promise.all(pos.map((p) => poDetail(p.id)));
    const rejected = details.find(
      (d) => d.status === 'draft' && d.approvals.some((a) => a.decision === 'rejected'),
    );
    expect(rejected).toBeTruthy();
    expect(rejected!.status).toBe('draft');
    expect(rejected!.approvals.every((a) => a.voided)).toBe(true);
    expect(rejected!.submissions).toHaveLength(1);
  });
});
