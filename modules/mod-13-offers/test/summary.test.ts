import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { moduleSummary, MODULE_ID } from '../server/summary.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import {
  CONTEXT_FILTERS,
  isModulePath,
  parseSummaryContext,
  SUMMARY_VERSION,
  validateSummary,
  type ModuleSummary,
} from '../shared/summary.js';

/**
 * What this module puts on a shell's board.
 *
 * Two things are load-bearing and get most of the cases. The summary must
 * satisfy `validateSummary` — the shell refuses a peer that fails it, so a
 * shape mistake here is a blank widget rather than a wrong one. And the
 * context echo must be TRUE: a board that says "filtered to Blaustern" while
 * showing everyone's offers is worse than a board that admits it could not
 * narrow.
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

const SERVICE_TOKEN = 'test-machine-token';
const CLOCK = '2026-07-20';

let db: Database.Database;
let app: Express;
let cookie: string;

/** A customer, optionally already linked to a PS-11 party. */
function customer(name: string, partyId: number | null = null): number {
  const info = db
    .prepare('INSERT INTO customers (name, email, created_at) VALUES (?, ?, ?)')
    .run(name, `${name.toLowerCase().replace(/\W+/g, '')}@example`, '2026-01-01T00:00:00Z');
  const id = Number(info.lastInsertRowid);
  if (partyId !== null) db.prepare('UPDATE customers SET party_id = ? WHERE id = ?').run(partyId, id);
  return id;
}

/** An offer in a given state, created and sent on `date`. */
async function offer(
  customerId: number,
  title: string,
  cents: number,
  state: 'draft' | 'sent' | 'accepted' | 'rejected',
  date = CLOCK,
): Promise<number> {
  const draft = await request(app)
    .post('/api/offers')
    .set('Cookie', cookie)
    .send({
      customer_id: customerId,
      title,
      valid_until: '2026-12-31',
      lines: [{ description: 'Work', quantity: 1, unit_price_cents: cents, vat_rate: 20 }],
    })
    .expect(201);
  const id = draft.body.id as number;
  if (state === 'draft') return id;

  await request(app).post(`/api/offers/${id}/send`).set('Cookie', cookie).send({}).expect(200);
  // `sent_at` is what the from/to filters read; the app clock is fixed, so set
  // it directly when a case needs an offer on a different day.
  if (date !== CLOCK) db.prepare('UPDATE offers SET sent_at = ? WHERE id = ?').run(`${date}T12:00:00Z`, id);
  if (state === 'accepted') await request(app).post(`/api/offers/${id}/accept`).set('Cookie', cookie).send({}).expect(200);
  if (state === 'rejected') await request(app).post(`/api/offers/${id}/reject`).set('Cookie', cookie).send({}).expect(200);
  return id;
}

function summary(query = ''): Promise<request.Response> {
  return request(app).get(`/api/summary${query}`).set('X-Service-Token', SERVICE_TOKEN);
}

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({
    db,
    auth,
    seller,
    publicBaseUrl: 'http://localhost:3013',
    clock: () => CLOCK,
    serviceToken: SERVICE_TOKEN,
  });
  const login = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
});

describe('GET /api/summary — auth', () => {
  it('requires the machine token, and a staff session is not one', async () => {
    await request(app).get('/api/summary').expect(401);
    // Same stance as the transfer endpoint: the caller is another service in
    // this stack, not a human, so a logged-in session is deliberately not enough.
    await request(app).get('/api/summary').set('Cookie', cookie).expect(401);
    await request(app).get('/api/summary').set('X-Service-Token', 'wrong').expect(401);
    await summary().expect(200);
  });

  it('is closed when the stack has no machine token', async () => {
    const standalone = createApp({ db, auth, seller, clock: () => CLOCK });
    await request(standalone).get('/api/summary').set('X-Service-Token', SERVICE_TOKEN).expect(401);
  });
});

describe('the summary a shell renders', () => {
  it('satisfies the contract every consumer validates against', async () => {
    const acme = customer('Acme');
    await offer(acme, 'Onboarding', 120_000, 'sent');
    await offer(acme, 'Rollout', 300_000, 'accepted');
    await offer(acme, 'Pilot', 50_000, 'draft');

    const res = await summary().expect(200);
    expect(validateSummary(res.body)).toEqual([]);
    expect(res.body.summary_version).toBe(SUMMARY_VERSION);
    expect(res.body.module).toBe(MODULE_ID);
  });

  it('counts and values the pipeline the way this module’s own screens do', async () => {
    const acme = customer('Acme');
    await offer(acme, 'A', 100_000, 'sent'); // 1000.00 net -> 1200.00 gross
    await offer(acme, 'B', 200_000, 'accepted');
    await offer(acme, 'C', 300_000, 'rejected');
    await offer(acme, 'D', 400_000, 'draft');

    const body = (await summary().expect(200)).body as ModuleSummary;
    const tile = (key: string) => body.tiles.find((t) => t.key === key)!;

    expect(tile('open').value).toBe('1');
    expect(tile('drafts').value).toBe('1');
    // One accepted of two decided.
    expect(tile('win_rate').value).toBe('50 %');
    // Gross, as the module computes it: 1000.00 + 20 % VAT.
    expect(tile('open_value').value).toContain('1.200');
  });

  it('reports no win rate rather than 0 % when nothing has been decided', async () => {
    const acme = customer('Acme');
    await offer(acme, 'A', 100_000, 'sent');

    const body = (await summary().expect(200)).body as ModuleSummary;
    // "0 %" out of nothing is a figure a board would repeat all day.
    expect(body.tiles.find((t) => t.key === 'win_rate')!.value).toBe('—');
  });

  it('lists accepted offers by NUMBER, which is what the billing action takes', async () => {
    const acme = customer('Acme');
    const id = await offer(acme, 'Rollout', 300_000, 'accepted');
    const detail = await request(app).get(`/api/offers/${id}`).set('Cookie', cookie).expect(200);

    const body = (await summary().expect(200)).body as ModuleSummary;
    const accepted = body.lists.find((l) => l.key === 'accepted_offers')!;
    expect(accepted.items.map((i) => i.id)).toEqual([detail.body.number]);
  });

  it('hands out only paths, never absolute URLs', async () => {
    const acme = customer('Acme');
    await offer(acme, 'A', 100_000, 'sent');

    const body = (await summary().expect(200)).body as ModuleSummary;
    const hrefs = [
      ...body.tiles.map((t) => t.href),
      ...body.lists.map((l) => l.href),
      ...body.lists.flatMap((l) => l.items.map((i) => i.href)),
    ].filter((h): h is string => h !== null);

    expect(hrefs.length).toBeGreaterThan(0);
    // The shell joins these to this module's public origin. A peer that could
    // return an absolute URL would decide where the shell's UI navigates.
    for (const href of hrefs) expect(isModulePath(href)).toBe(true);
  });
});

describe('the context a shell passes', () => {
  it('narrows to one PS-11 party, and says that it did', async () => {
    const linked = customer('Blaustern', 77);
    const other = customer('Acme', 88);
    await offer(linked, 'Theirs', 100_000, 'sent');
    await offer(other, 'Someone else’s', 900_000, 'sent');

    const body = (await summary('?party=77').expect(200)).body as ModuleSummary;
    expect(body.context.applied).toEqual(['party']);
    expect(body.tiles.find((t) => t.key === 'open')!.value).toBe('1');
    expect(body.lists.find((l) => l.key === 'awaiting_decision')!.items[0]!.subtitle).toBe('Blaustern');
  });

  it('answers empty — not unfiltered — for a customer it has never seen', async () => {
    const acme = customer('Acme', 88);
    await offer(acme, 'A', 100_000, 'sent');

    const body = (await summary('?party=999').expect(200)).body as ModuleSummary;
    // The filter RAN. Empty is the true answer, and `applied` says so, so the
    // board can render "nothing here for this customer" honestly.
    expect(body.context.applied).toEqual(['party']);
    expect(body.tiles.find((t) => t.key === 'open')!.value).toBe('0');
  });

  it('narrows to a date range', async () => {
    const acme = customer('Acme');
    await offer(acme, 'Old', 100_000, 'sent', '2026-01-15');
    await offer(acme, 'Recent', 200_000, 'sent', '2026-07-15');

    const body = (await summary('?from=2026-07-01&to=2026-07-31').expect(200)).body as ModuleSummary;
    expect(body.context.applied).toEqual(['from', 'to']);
    expect(body.tiles.find((t) => t.key === 'open')!.value).toBe('1');
  });

  it('advertises what it supports and applies nothing when asked for nothing', async () => {
    const body = (await summary().expect(200)).body as ModuleSummary;
    expect(body.context.supported).toEqual([...CONTEXT_FILTERS]);
    expect(body.context.applied).toEqual([]);
  });

  it('ignores a malformed context instead of failing the widget', async () => {
    const acme = customer('Acme');
    await offer(acme, 'A', 100_000, 'sent');

    const body = (await summary('?party=nonsense&from=yesterday').expect(200)).body as ModuleSummary;
    expect(body.context.applied).toEqual([]);
    expect(body.tiles.find((t) => t.key === 'open')!.value).toBe('1');
  });
});

describe('parseSummaryContext', () => {
  it('takes what it understands', () => {
    expect(parseSummaryContext({ party: '42', from: '2026-01-01', to: '2026-12-31' })).toEqual({
      party: 42,
      from: '2026-01-01',
      to: '2026-12-31',
    });
  });

  it('drops what it does not, without complaint', () => {
    expect(parseSummaryContext({})).toEqual({});
    expect(parseSummaryContext({ party: 'abc' })).toEqual({});
    expect(parseSummaryContext({ party: '0' })).toEqual({});
    expect(parseSummaryContext({ party: '-1' })).toEqual({});
    expect(parseSummaryContext({ from: '01/01/2026' })).toEqual({});
  });

  it('drops a backwards range whole rather than honouring half of it', () => {
    // Keeping `from` alone would narrow the answer in a direction nobody asked
    // for, and the board would show a filtered widget labelled with a range
    // that was never applied.
    expect(parseSummaryContext({ from: '2026-12-31', to: '2026-01-01' })).toEqual({});
  });
});

describe('validateSummary', () => {
  const valid = (): ModuleSummary => moduleSummary(openDb(':memory:'), {}, { today: CLOCK });

  it('accepts a real summary', () => {
    expect(validateSummary(valid())).toEqual([]);
  });

  it('refuses a version it does not know, and stops there', () => {
    const problems = validateSummary({ ...valid(), summary_version: 99 });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.field).toBe('summary_version');
  });

  it('refuses an href that would send the shell to another origin', () => {
    const s = valid();
    s.tiles[0]!.href = 'https://evil.example/steal';
    expect(validateSummary(s).map((p) => p.field)).toContain('tiles[0].href');

    const protocolRelative = valid();
    protocolRelative.tiles[0]!.href = '//evil.example';
    expect(validateSummary(protocolRelative).map((p) => p.field)).toContain('tiles[0].href');
  });

  it('refuses duplicate keys, which a saved board could not tell apart', () => {
    const s = valid();
    s.tiles[1]!.key = s.tiles[0]!.key;
    expect(validateSummary(s).map((p) => p.message)).toContainEqual(expect.stringContaining('duplicate key'));
  });

  it('refuses a claim to have applied a filter the module does not support', () => {
    const s = valid();
    s.context = { supported: ['from'], applied: ['party'] };
    expect(validateSummary(s).map((p) => p.field)).toContain('context.applied');
  });
});
