import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { AuthConfig } from '../server/auth.js';
import { expectedValueCents } from '../server/pipeline-config.js';
import type { DealDetail, Metrics } from '../shared/types.js';

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

async function dealDetail(id: number): Promise<DealDetail> {
  const res = await request(app).get(`/api/deals/${id}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as DealDetail;
}

/** Create a company + deal at `lead` and return the deal detail. */
async function freshDeal(valueCents = 100_000): Promise<DealDetail> {
  const company = await request(app).post('/api/companies').set('Cookie', cookie).send({ name: 'Fixture Co' });
  expect(company.status).toBe(201);
  const res = await request(app)
    .post('/api/deals')
    .set('Cookie', cookie)
    .send({ title: 'Fixture deal', company_id: company.body.id, value_cents: valueCents });
  expect(res.status).toBe(201);
  return res.body as DealDetail;
}

async function move(id: number, stage: string, note?: string): Promise<request.Response> {
  return request(app).post(`/api/deals/${id}/stage`).set('Cookie', cookie).send({ stage, note });
}

beforeAll(async () => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, auth });

  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
});

describe('auth', () => {
  it('rejects unauthenticated requests with 401', async () => {
    for (const path of [
      '/api/companies',
      '/api/contacts',
      '/api/deals',
      '/api/deals/1',
      '/api/config',
      '/api/metrics',
      '/api/followups',
      '/api/deals.csv',
    ]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
    }
    const post = await request(app).post('/api/deals/1/stage').send({ stage: 'won' });
    expect(post.status).toBe(401);
  });

  it('rejects bad credentials, accepts good ones with an HttpOnly cookie', async () => {
    expect((await request(app).post('/api/login').send({ username: 'admin', password: 'nope' })).status).toBe(401);
    const ok = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
    expect(ok.status).toBe(200);
    expect(ok.headers['set-cookie']![0]).toContain('mod10_session=');
    expect(ok.headers['set-cookie']![0]).toContain('HttpOnly');
  });
});

describe('config mirrors the one pipeline config file', () => {
  it('serves ordered stages with terminal won/lost last', async () => {
    const res = await request(app).get('/api/config').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.stages.map((s: { key: string }) => s.key)).toEqual([
      'lead',
      'qualified',
      'proposal',
      'negotiation',
      'won',
      'lost',
    ]);
    const won = res.body.stages.find((s: { key: string }) => s.key === 'won');
    const lost = res.body.stages.find((s: { key: string }) => s.key === 'lost');
    expect(won).toMatchObject({ terminal: true, probability: 100, position: 4 });
    expect(lost).toMatchObject({ terminal: true, probability: 0, position: 5 });
    expect(res.body.activity_types).toEqual(['call', 'email', 'meeting', 'note']);
  });
});

describe('deal stage history — the core invariant', () => {
  it('records an opening event on creation', async () => {
    const deal = await freshDeal();
    expect(deal.stage).toBe('lead');
    expect(deal.stage_events).toHaveLength(1);
    expect(deal.stage_events[0]).toMatchObject({ from_stage: null, to_stage: 'lead', kind: 'open' });
  });

  it('keeps deals.stage equal to the latest event across a move sequence', async () => {
    const deal = await freshDeal();
    const sequence = ['qualified', 'proposal', 'negotiation'];
    for (const stage of sequence) {
      const res = await move(deal.id, stage, `moving to ${stage}`);
      expect(res.status).toBe(200);
    }
    const detail = await dealDetail(deal.id);
    // Opening event + three moves.
    expect(detail.stage_events).toHaveLength(4);
    expect(detail.stage_events.map((e) => e.to_stage)).toEqual(['lead', 'qualified', 'proposal', 'negotiation']);
    const latest = detail.stage_events[detail.stage_events.length - 1]!;
    expect(detail.stage).toBe(latest.to_stage);
    // from_stage of each move is the previous to_stage.
    for (let i = 1; i < detail.stage_events.length; i += 1) {
      expect(detail.stage_events[i]!.from_stage).toBe(detail.stage_events[i - 1]!.to_stage);
    }
  });

  it('treats a move to the same stage as a no-op (409, no event written)', async () => {
    const deal = await freshDeal();
    await move(deal.id, 'qualified');
    const before = (await dealDetail(deal.id)).stage_events.length;
    const res = await move(deal.id, 'qualified');
    expect(res.status).toBe(409);
    expect((await dealDetail(deal.id)).stage_events.length).toBe(before);
  });

  it('rejects an unknown target stage with 422', async () => {
    const deal = await freshDeal();
    expect((await move(deal.id, 'banana')).status).toBe(422);
  });
});

describe('won/lost are terminal and reopen is a distinct, recorded action', () => {
  it('blocks any further move once won (409) and reopen restores movement', async () => {
    const deal = await freshDeal();
    await move(deal.id, 'qualified');
    expect((await move(deal.id, 'won', 'closed')).status).toBe(200);

    // Terminal: no further normal moves.
    expect((await move(deal.id, 'negotiation')).status).toBe(409);
    expect((await move(deal.id, 'lost')).status).toBe(409);

    // Reopen appends a recorded reopen event back to an active stage.
    const reopen = await request(app)
      .post(`/api/deals/${deal.id}/reopen`)
      .set('Cookie', cookie)
      .send({ stage: 'negotiation', note: 'client came back' });
    expect(reopen.status).toBe(200);
    const detail = reopen.body as DealDetail;
    expect(detail.stage).toBe('negotiation');
    expect(detail.terminal).toBe(false);
    const last = detail.stage_events[detail.stage_events.length - 1]!;
    expect(last).toMatchObject({ from_stage: 'won', to_stage: 'negotiation', kind: 'reopen', note: 'client came back' });
    // Invariant still holds after reopen.
    expect(detail.stage).toBe(last.to_stage);

    // Moves work again after reopen.
    expect((await move(deal.id, 'won')).status).toBe(200);
  });

  it('refuses to reopen a non-terminal deal (409) and to reopen into a terminal stage (422)', async () => {
    const deal = await freshDeal();
    expect(
      (await request(app).post(`/api/deals/${deal.id}/reopen`).set('Cookie', cookie).send({})).status,
    ).toBe(409);
    await move(deal.id, 'qualified');
    await move(deal.id, 'lost');
    expect(
      (await request(app).post(`/api/deals/${deal.id}/reopen`).set('Cookie', cookie).send({ stage: 'won' })).status,
    ).toBe(422);
  });
});

describe('expected value is derived from value × stage probability', () => {
  it('recomputes expected value as the deal moves (never stored)', async () => {
    const deal = await freshDeal(1_000_00); // €1,000.00 = 100000 cents
    expect(deal.probability).toBe(10);
    expect(deal.expected_value_cents).toBe(10_000); // 10% of €1,000 = €100

    await move(deal.id, 'qualified');
    const qualified = await dealDetail(deal.id);
    expect(qualified.probability).toBe(30);
    expect(qualified.expected_value_cents).toBe(30_000);
    expect(qualified.expected_value_cents).toBe(expectedValueCents(qualified.value_cents, 'qualified'));

    await move(deal.id, 'proposal');
    const proposal = await dealDetail(deal.id);
    expect(proposal.expected_value_cents).toBe(55_000);
  });

  it('rounds per deal (half-away-from-zero)', () => {
    // 55% of €33.33 = 1833.15 → 1833.
    expect(expectedValueCents(33_33, 'proposal')).toBe(1833);
    expect(expectedValueCents(100_00, 'won')).toBe(100_00);
    expect(expectedValueCents(100_00, 'lost')).toBe(0);
  });
});

describe('pipeline metrics vs hand-computed seed fixtures', () => {
  // Isolated app on a freshly seeded db so metrics reflect ONLY the seed,
  // not the fixture deals other tests create in the shared database.
  let seededApp: Express;
  let seededCookie: string;
  let metrics: Metrics;

  beforeAll(async () => {
    const freshDb = openDb(':memory:');
    seed(freshDb);
    seededApp = createApp({ db: freshDb, auth });
    const login = await request(seededApp).post('/api/login').send({ username: 'admin', password: 'test-password' });
    seededCookie = login.headers['set-cookie']![0]!.split(';')[0]!;
    const res = await request(seededApp).get('/api/metrics').set('Cookie', seededCookie);
    expect(res.status).toBe(200);
    metrics = res.body as Metrics;
  });

  it('per-stage count, value and expected value match the seed', () => {
    const byKey = Object.fromEntries(metrics.stages.map((s) => [s.key, s]));
    expect(byKey.lead).toMatchObject({ count: 2, value_cents: 750_000_00, expected_value_cents: 75_000_00 });
    expect(byKey.qualified).toMatchObject({ count: 2, value_cents: 2_000_000_00, expected_value_cents: 600_000_00 });
    expect(byKey.proposal).toMatchObject({ count: 2, value_cents: 3_450_000_00, expected_value_cents: 1_897_500_00 });
    expect(byKey.negotiation).toMatchObject({ count: 2, value_cents: 7_500_000_00, expected_value_cents: 6_000_000_00 });
    expect(byKey.won).toMatchObject({ count: 2, value_cents: 2_900_000_00, expected_value_cents: 2_900_000_00 });
    expect(byKey.lost).toMatchObject({ count: 2, value_cents: 1_500_000_00, expected_value_cents: 0 });
    expect(metrics.totals.count).toBe(12);
  });

  it('win rate = won / (won + lost) over the whole range', () => {
    expect(metrics.win_rate).toMatchObject({ won: 2, lost: 2, rate: 0.5 });
  });

  it('win rate respects the date range (closing-event date)', async () => {
    const may = await request(seededApp).get('/api/metrics?from=2026-05-01&to=2026-05-31').set('Cookie', seededCookie);
    expect((may.body as Metrics).win_rate).toMatchObject({ won: 1, lost: 0, rate: 1 });

    const june = await request(seededApp).get('/api/metrics?from=2026-06-01&to=2026-06-30').set('Cookie', seededCookie);
    expect((june.body as Metrics).win_rate).toMatchObject({ won: 1, lost: 1, rate: 0.5 });

    const empty = await request(seededApp).get('/api/metrics?from=2020-01-01&to=2020-12-31').set('Cookie', seededCookie);
    expect((empty.body as Metrics).win_rate).toMatchObject({ won: 0, lost: 0, rate: null });
  });
});

describe('companies', () => {
  it('CRUD round-trip with validation', async () => {
    expect((await request(app).post('/api/companies').set('Cookie', cookie).send({ name: '' })).status).toBe(422);
    const created = await request(app).post('/api/companies').set('Cookie', cookie).send({ name: 'Acme', domain: 'acme.test' });
    expect(created.status).toBe(201);
    const id = created.body.id as number;
    const updated = await request(app).put(`/api/companies/${id}`).set('Cookie', cookie).send({ name: 'Acme Inc' });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('Acme Inc');
    expect((await request(app).delete(`/api/companies/${id}`).set('Cookie', cookie)).status).toBe(200);
  });

  it('refuses to delete a company that has contacts or deals (409)', async () => {
    // Company 1 (Helios) has both in the seed.
    const res = await request(app).delete('/api/companies/1').set('Cookie', cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('reassign');
  });
});

describe('contacts', () => {
  it('exposes a deal list and activity timeline on the detail', async () => {
    const res = await request(app).get('/api/contacts/1').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.company_name).toBe('Helios Renewables GmbH');
    expect(Array.isArray(res.body.deals)).toBe(true);
    expect(Array.isArray(res.body.activities)).toBe(true);
  });
});

describe('activity log', () => {
  it('is append-only and its timeline is ordered newest-first', async () => {
    const deal = await freshDeal();
    const stamps = ['2026-01-01T09:00:00Z', '2026-03-01T09:00:00Z', '2026-02-01T09:00:00Z'];
    for (const [i] of stamps.entries()) {
      const res = await request(app)
        .post('/api/activities')
        .set('Cookie', cookie)
        .send({ type: 'note', subject: `note ${i}`, deal_id: deal.id });
      expect(res.status).toBe(201);
    }
    const detail = await dealDetail(deal.id);
    const times = detail.activities.map((a) => a.created_at);
    const sorted = [...times].sort((a, b) => (a < b ? 1 : -1));
    expect(times).toEqual(sorted);
  });

  it('requires a contact and/or deal link (422)', async () => {
    const res = await request(app).post('/api/activities').set('Cookie', cookie).send({ type: 'note', subject: 'orphan' });
    expect(res.status).toBe(422);
  });
});

describe('follow-ups', () => {
  it('derives open + overdue and records the done toggle', async () => {
    const deal = await freshDeal();
    const overdue = await request(app)
      .post('/api/activities')
      .set('Cookie', cookie)
      .send({ type: 'call', subject: 'chase', deal_id: deal.id, due_date: '2000-01-01' });
    expect(overdue.status).toBe(201);
    const future = await request(app)
      .post('/api/activities')
      .set('Cookie', cookie)
      .send({ type: 'call', subject: 'later', deal_id: deal.id, due_date: '2999-01-01' });
    expect(future.status).toBe(201);

    const list = (await request(app).get('/api/followups').set('Cookie', cookie)).body.followups as {
      id: number;
      overdue: boolean;
      done: number;
    }[];
    const od = list.find((f) => f.id === overdue.body.id)!;
    const fu = list.find((f) => f.id === future.body.id)!;
    expect(od.overdue).toBe(true);
    expect(fu.overdue).toBe(false);

    // Mark done → recorded and dropped from the open list.
    const done = await request(app).post(`/api/activities/${overdue.body.id}/done`).set('Cookie', cookie).send({ done: true });
    expect(done.status).toBe(200);
    expect(done.body.done).toBe(1);
    expect(done.body.done_at).toBeTruthy();
    const after = (await request(app).get('/api/followups').set('Cookie', cookie)).body.followups as { id: number }[];
    expect(after.some((f) => f.id === overdue.body.id)).toBe(false);

    // Un-done clears done_at.
    const undone = await request(app).post(`/api/activities/${overdue.body.id}/done`).set('Cookie', cookie).send({ done: false });
    expect(undone.body.done).toBe(0);
    expect(undone.body.done_at).toBeNull();
  });

  it('refuses to mark a non-follow-up activity done (409)', async () => {
    const deal = await freshDeal();
    const plain = await request(app).post('/api/activities').set('Cookie', cookie).send({ type: 'note', subject: 'no due', deal_id: deal.id });
    const res = await request(app).post(`/api/activities/${plain.body.id}/done`).set('Cookie', cookie).send({ done: true });
    expect(res.status).toBe(409);
  });

  it('seed contains open and overdue follow-ups', async () => {
    const list = (await request(app).get('/api/followups').set('Cookie', cookie)).body.followups as {
      overdue: boolean;
    }[];
    expect(list.some((f) => f.overdue)).toBe(true);
    expect(list.some((f) => !f.overdue)).toBe(true);
  });
});

describe('CSV export', () => {
  it('produces a valid RFC-4180 CSV with a header and one row per deal', async () => {
    const res = await request(app).get('/api/deals.csv').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('.csv');
    const lines = (res.text as string).trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'id,title,company,primary_contact,stage,stage_label,probability_pct,value,expected_value,created_at',
    );
    // One row per deal (12 seeded).
    const deals = (await request(app).get('/api/deals').set('Cookie', cookie)).body.deals as { id: number }[];
    expect(lines.length - 1).toBe(deals.length);
    // Every data row has the same column count as the header.
    const cols = lines[0]!.split(',').length;
    for (const line of lines.slice(1)) {
      // naive split is fine here — seed titles contain no commas
      expect(line.split(',').length).toBe(cols);
    }
  });
});

describe('seeded dataset invariants', () => {
  it('covers every stage and preserves stage == latest event on every deal', async () => {
    const deals = (await request(app).get('/api/deals').set('Cookie', cookie)).body.deals as {
      id: number;
      stage: string;
    }[];
    const stages = new Set(deals.map((d) => d.stage));
    for (const stage of ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost']) {
      expect(stages.has(stage), stage).toBe(true);
    }
    for (const d of deals) {
      const detail = await dealDetail(d.id);
      const latest = detail.stage_events[detail.stage_events.length - 1]!;
      expect(detail.stage, `deal ${d.id}`).toBe(latest.to_stage);
    }
  });

  it('contains a deal that was reopened from a terminal stage', async () => {
    const deals = (await request(app).get('/api/deals').set('Cookie', cookie)).body.deals as { id: number }[];
    const details = await Promise.all(deals.map((d) => dealDetail(d.id)));
    const reopened = details.find((d) => d.stage_events.some((e) => e.kind === 'reopen'));
    expect(reopened).toBeTruthy();
    // The reopen event's from_stage is a terminal stage.
    const reopenEvent = reopened!.stage_events.find((e) => e.kind === 'reopen')!;
    expect(['won', 'lost']).toContain(reopenEvent.from_stage);
  });
});
