import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import { buildPlatform, noopPlatform, OfferFetchError, type PlatformHooks } from '../server/platform.js';
import { importTransfer } from '../server/transfer-import.js';
import { TRANSFER_VERSION, transferTotals, type DocumentTransfer } from '../shared/transfer.js';
import type { Project } from '../shared/types.js';

/**
 * Planning an accepted offer as a project.
 *
 * The step between selling work and doing it, and the third consumer of the
 * same neutral transfer MOD-13 exports and MOD-04 bills. What this file pins
 * down is mostly what does NOT come across.
 *
 * THE MONEY STAYS BEHIND. A project's rate is what an HOUR costs; an offer's
 * total is what the JOB costs, and the offer does not say how many hours are in
 * it. Deriving one from the other would put an invented number in this module
 * that every timesheet total afterwards would inherit.
 *
 * A DEAL IS NOT AN OFFER. Staffing work the customer has not agreed to buy is
 * how a team books real hours against a job that never happens.
 *
 * ONE JOB IS ONE PROJECT. The import is idempotent, because hours split across
 * two projects for one offer is a mistake nobody notices until billing.
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

/** An accepted offer as MOD-13 puts it on the wire. */
function transfer(overrides: Partial<DocumentTransfer> = {}): DocumentTransfer {
  const lines = overrides.lines ?? [
    {
      description: 'Consulting — platform onboarding (10h)',
      quantity: 10,
      unit_price_cents: 12000,
      discount_percent: 0,
      vat_rate: 20,
      net_cents: 120000,
    },
    {
      description: 'Priority support, one year',
      quantity: 1,
      unit_price_cents: 90000,
      discount_percent: 0,
      vat_rate: 20,
      net_cents: 90000,
    },
  ];
  return {
    transfer_version: TRANSFER_VERSION,
    origin: {
      kind: 'offer',
      module: 'mod-13-offers',
      reference: 'AN-2026-0007',
      issued_at: '2026-07-18',
      accepted_at: '2026-07-20T12:00:00Z',
    },
    currency: 'EUR',
    customer: {
      name: 'Blaustern Café GmbH',
      contact_person: 'Anna Berger',
      email: 'buchhaltung@blaustern.example',
      vat_id: 'ATU12345678',
      address_lines: ['Hauptstraße 12', '5020 Salzburg'],
      party_id: null,
      source: 'mod-13-offers',
      external_id: '7',
    },
    lines,
    totals: transferTotals(lines),
    note: 'Thank you for your interest.',
    ...overrides,
  };
}

/** A platform that serves one offer and records what it was asked to do. */
function offerSource(
  offers: Record<string, DocumentTransfer>,
  opts: { fail?: OfferFetchError } = {},
): { hooks: PlatformHooks; audited: unknown[] } {
  const audited: unknown[] = [];
  return {
    audited,
    hooks: {
      ...noopPlatform,
      async fetchOffer(offerNumber: string) {
        if (opts.fail) throw opts.fail;
        const found = offers[offerNumber];
        if (!found) throw new OfferFetchError(404, 'Offer not found');
        return found;
      },
      async audit(info) {
        audited.push(info);
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
  return createApp({ db, auth, platform });
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('POST /api/projects/import-offer', () => {
  it('creates a project named so you can find it again', async () => {
    const app = build(offerSource({ 'AN-2026-0007': transfer() }).hooks);
    const cookie = await login(app);

    const res = await request(app)
      .post('/api/projects/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' })
      .expect(201);

    const project = res.body as Project & { imported: boolean };
    expect(project.imported).toBe(true);
    // The offer number is in the name because a customer's second order makes
    // "Blaustern Café GmbH" ambiguous in a dropdown, and a dropdown is where
    // this project is going to be picked from every day for months.
    expect(project.name).toBe('AN-2026-0007 · Blaustern Café GmbH');
    expect(project.client).toBe('Blaustern Café GmbH');
    expect(project.active).toBe(true);
    expect(project.billable_default).toBe(true);
  });

  it('turns each offer line into a task', async () => {
    const app = build(offerSource({ 'AN-2026-0007': transfer() }).hooks);
    const cookie = await login(app);

    const res = await request(app)
      .post('/api/projects/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' })
      .expect(201);

    // Hours land against the thing that was sold, rather than in a single
    // bucket that has to be untangled later.
    expect((res.body as Project).tasks.map((t) => t.name)).toEqual([
      'Consulting — platform onboarding (10h)',
      'Priority support, one year',
    ]);
  });

  it('leaves the rate at zero rather than inventing one', async () => {
    const app = build(offerSource({ 'AN-2026-0007': transfer() }).hooks);
    const cookie = await login(app);

    const res = await request(app)
      .post('/api/projects/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' })
      .expect(201);

    // The offer totals €2,100 net. There is no honest way to turn that into an
    // hourly rate — the offer does not say how many hours are in it, and a
    // fixed-price one may have no answer at all. A zero someone must fill in
    // beats a number that looks authoritative and is made up, because every
    // billable-hours total afterwards would inherit the invention.
    expect((res.body as Project).rate_cents).toBe(0);
  });

  it('is idempotent — a second import returns the first project', async () => {
    const app = build(offerSource({ 'AN-2026-0007': transfer() }).hooks);
    const cookie = await login(app);

    const first = await request(app)
      .post('/api/projects/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' })
      .expect(201);
    const second = await request(app)
      .post('/api/projects/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' })
      .expect(200);

    expect(second.body.id).toBe(first.body.id);
    expect(second.body.imported).toBe(false);
    // And no orphan tasks from the second attempt.
    expect(second.body.tasks).toHaveLength(2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
  });

  it('records the import on the audit trail, once', async () => {
    const source = offerSource({ 'AN-2026-0007': transfer() });
    const app = build(source.hooks);
    const cookie = await login(app);

    await request(app).post('/api/projects/import-offer').set('Cookie', cookie).send({ offer_number: 'AN-2026-0007' });
    await request(app).post('/api/projects/import-offer').set('Cookie', cookie).send({ offer_number: 'AN-2026-0007' });

    // The replay created nothing, so it records nothing.
    expect(source.audited).toHaveLength(1);
    expect(source.audited[0]).toMatchObject({ action: 'project.imported' });
  });

  it('lets time be booked against the imported project immediately', async () => {
    const app = build(offerSource({ 'AN-2026-0007': transfer() }).hooks);
    const cookie = await login(app);

    const project = await request(app)
      .post('/api/projects/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' })
      .expect(201);
    const employee = await request(app)
      .post('/api/employees')
      .set('Cookie', cookie)
      .send({ name: 'Sara Fink', email: 'sara@example.test' })
      .expect(201);

    // The point of the whole path: an ordinary project, indistinguishable from
    // a hand-created one everywhere except its origin column.
    await request(app)
      .post('/api/entries')
      .set('Cookie', cookie)
      .send({
        employee_id: employee.body.id,
        project_id: project.body.id,
        task_id: project.body.tasks[0].id,
        entry_date: '2026-07-21',
        minutes: 120,
      })
      .expect(201);
  });
});

describe('POST /api/projects/import-offer — what it refuses', () => {
  it('refuses a pipeline deal, and says why', async () => {
    const deal = transfer({
      origin: {
        kind: 'deal',
        module: 'mod-10-crm-lite',
        reference: 'DEAL-3',
        issued_at: '2026-06-10T09:00:00Z',
        accepted_at: null,
      },
    });
    const app = build(offerSource({ 'DEAL-3': deal }).hooks);
    const cookie = await login(app);

    const res = await request(app)
      .post('/api/projects/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'DEAL-3' })
      .expect(422);
    expect(String(res.body.error)).toContain('accepted offer');
    expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(0);
  });

  it('requires a session — the board acts as a person, never as the machine', async () => {
    const app = build(offerSource({ 'AN-2026-0007': transfer() }).hooks);
    await request(app).post('/api/projects/import-offer').send({ offer_number: 'AN-2026-0007' }).expect(401);
    // The machine token opens summaries and mints sessions. It writes nothing.
    await request(app)
      .post('/api/projects/import-offer')
      .set('X-Service-Token', 'test-machine-token')
      .send({ offer_number: 'AN-2026-0007' })
      .expect(401);
  });

  it('says OFFERS_URL is unset rather than failing obscurely', async () => {
    const app = build(noopPlatform);
    const cookie = await login(app);
    const res = await request(app)
      .post('/api/projects/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' })
      .expect(501);
    expect(String(res.body.error)).toContain('OFFERS_URL');
  });

  it('passes an upstream 404 through, and turns anything else into a 502', async () => {
    const missing = build(offerSource({}).hooks);
    let cookie = await login(missing);
    await request(missing)
      .post('/api/projects/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-9999' })
      .expect(404);

    const broken = build(offerSource({}, { fail: new OfferFetchError(503, 'offers unavailable') }).hooks);
    cookie = await login(broken);
    await request(broken)
      .post('/api/projects/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' })
      .expect(502);
  });

  /**
   * Offers that is DOWN, not one that answered badly.
   *
   * The case above stubs the hook and throws an `OfferFetchError`, which only
   * proves the route maps that error. A refused connection, a DNS failure or
   * the fetch timeout throw from `fetch` itself, and those used to escape the
   * route's `instanceof` check entirely and surface as `500 Internal server
   * error` — pointing the operator at this module when the problem is the one
   * it was calling. So this case uses a real platform pointed at a dead port.
   */
  it('reports an unreachable Offers as a bad gateway, not as its own failure', async () => {
    const app = createApp({
      db,
      auth,
      platform: buildPlatform({ offersUrl: 'http://127.0.0.1:1', serviceToken: 'tok' }),
    });
    const cookie = await login(app);

    const res = await request(app)
      .post('/api/projects/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' })
      .expect(502);
    expect(String(res.body.error)).toMatch(/unreachable/i);
    expect(String(res.body.error)).not.toBe('Internal server error');
  });

  it('requires an offer number', async () => {
    const app = build(offerSource({ 'AN-2026-0007': transfer() }).hooks);
    const cookie = await login(app);
    await request(app).post('/api/projects/import-offer').set('Cookie', cookie).send({}).expect(422);
    await request(app).post('/api/projects/import-offer').set('Cookie', cookie).send({ offer_number: ' ' }).expect(422);
  });
});

describe('importTransfer — the task list', () => {
  it('does not create two tasks a person could not tell apart', () => {
    const lines = ['Travel', 'On-site work', 'Travel'].map((description) => ({
      description,
      quantity: 1,
      unit_price_cents: 10_000,
      discount_percent: 0,
      vat_rate: 20,
      net_cents: 10_000,
    }));
    const { projectId } = importTransfer(db, transfer({ lines, totals: transferTotals(lines) }));

    // Two "Travel" lines on an offer are perfectly legitimate — different
    // dates, say. As tasks they would be two identical dropdown entries, and
    // which one someone picked would be meaningless.
    const tasks = db.prepare('SELECT name FROM tasks WHERE project_id = ?').all(projectId) as { name: string }[];
    expect(tasks.map((t) => t.name)).toEqual(['Travel', 'On-site work']);
  });

  it('caps the task list rather than importing an offer’s entire bill of materials', () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({
      description: `Item ${i + 1}`,
      quantity: 1,
      unit_price_cents: 1_000,
      discount_percent: 0,
      vat_rate: 20,
      net_cents: 1_000,
    }));
    const { projectId } = importTransfer(db, transfer({ lines, totals: transferTotals(lines) }));

    const count = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?').get(projectId) as { n: number };
    expect(count.n).toBe(12);
  });

  it('refuses a malformed transfer', () => {
    expect(() => importTransfer(db, { transfer_version: 99 })).toThrowError(/cannot be planned/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(0);
  });
});
