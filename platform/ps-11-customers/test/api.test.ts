import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import type { Party, ResolveResult } from '../shared/types.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};

let db: Database.Database;
let app: Express;

const svc = () => ({ 'X-Service-Token': 'test-service' });

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, auth });
});

async function resolve(input: Record<string, unknown>): Promise<{ status: number; body: ResolveResult }> {
  const res = await request(app).post('/api/parties/resolve').set(svc()).send(input);
  return { status: res.status, body: res.body as ResolveResult };
}

describe('auth', () => {
  it('rejects an unauthenticated caller', async () => {
    await request(app).get('/api/parties').expect(401);
    await request(app).post('/api/parties').send({ name: 'X' }).expect(401);
    await request(app).get('/api/self').expect(401);
  });

  it('accepts the service token and an admin session alike', async () => {
    await request(app).get('/api/parties').set(svc()).expect(200);
    const login = await request(app).post('/api/login').send({ username: 'admin', password: 'test-pass' });
    expect(login.status).toBe(200);
    await request(app).get('/api/parties').set('Authorization', `Bearer ${login.body.token}`).expect(200);
  });

  it('leaves health, readiness and metrics public', async () => {
    await request(app).get('/api/health').expect(200);
    await request(app).get('/api/ready').expect(200);
    await request(app).get('/api/metrics').expect(200);
  });
});

describe('parties', () => {
  it('creates a party, normalizing the VAT id and the email', async () => {
    const res = await request(app)
      .post('/api/parties')
      .set(svc())
      .send({
        name: '  Blaustern Café GmbH ',
        email: 'Buchhaltung@Blaustern.Example',
        vat_id: 'atu 123 456 78',
        address_lines: ['Hauptstraße 12', '', '5020 Salzburg'],
      });
    expect(res.status).toBe(201);
    const party = res.body.party as Party;
    expect(party.name).toBe('Blaustern Café GmbH');
    expect(party.email).toBe('buchhaltung@blaustern.example');
    expect(party.vat_id).toBe('ATU12345678');
    // Blank address lines are dropped rather than stored.
    expect(party.address_lines).toEqual(['Hauptstraße 12', '5020 Salzburg']);
    expect(party.kind).toBe('customer');
    expect(party.archived_at).toBeNull();
  });

  it('requires a name and reports the field', async () => {
    const res = await request(app).post('/api/parties').set(svc()).send({ email: 'a@b.example' });
    expect(res.status).toBe(422);
    expect(res.body.details).toEqual([{ field: 'name', message: 'is required' }]);
  });

  it('rejects a malformed email and an over-long name', async () => {
    const bad = await request(app).post('/api/parties').set(svc()).send({ name: 'X', email: 'not-an-email' });
    expect(bad.status).toBe(422);
    expect(bad.body.details).toEqual([{ field: 'email', message: 'must be a valid email' }]);

    const long = await request(app).post('/api/parties').set(svc()).send({ name: 'x'.repeat(201) });
    expect(long.status).toBe(422);
  });

  it('replays a create with the same idempotency key instead of duplicating', async () => {
    const first = await request(app)
      .post('/api/parties')
      .set({ ...svc(), 'Idempotency-Key': 'import-42' })
      .send({ name: 'Nordwind AG' });
    expect(first.status).toBe(201);
    const again = await request(app)
      .post('/api/parties')
      .set({ ...svc(), 'Idempotency-Key': 'import-42' })
      .send({ name: 'Nordwind AG' });
    expect(again.status).toBe(200);
    expect(again.body.party.id).toBe(first.body.party.id);

    const list = await request(app).get('/api/parties').set(svc());
    expect(list.body.parties).toHaveLength(1);
  });

  it('lists, searches and hides archived parties', async () => {
    await request(app).post('/api/parties').set(svc()).send({ name: 'Alpha GmbH', vat_id: 'ATU1' });
    const beta = await request(app).post('/api/parties').set(svc()).send({ name: 'Beta AG', email: 'b@beta.example' });

    const all = await request(app).get('/api/parties').set(svc());
    expect(all.body.parties.map((p: Party) => p.name)).toEqual(['Alpha GmbH', 'Beta AG']);

    const byName = await request(app).get('/api/parties?q=Beta').set(svc());
    expect(byName.body.parties).toHaveLength(1);

    const byEmail = await request(app).get('/api/parties?q=beta.example').set(svc());
    expect(byEmail.body.parties).toHaveLength(1);

    await request(app).post(`/api/parties/${beta.body.party.id}/archive`).set(svc()).expect(200);
    const active = await request(app).get('/api/parties').set(svc());
    expect(active.body.parties.map((p: Party) => p.name)).toEqual(['Alpha GmbH']);
    const withArchived = await request(app).get('/api/parties?include_archived=true').set(svc());
    expect(withArchived.body.parties).toHaveLength(2);
  });

  it('patches only the fields present in the request', async () => {
    const created = await request(app)
      .post('/api/parties')
      .set(svc())
      .send({ name: 'Alpha GmbH', email: 'a@alpha.example', vat_id: 'ATU1', contact_person: 'Ada' });
    const patched = await request(app)
      .patch(`/api/parties/${created.body.party.id}`)
      .set(svc())
      .send({ email: 'billing@alpha.example' });
    expect(patched.status).toBe(200);
    expect(patched.body.party.email).toBe('billing@alpha.example');
    expect(patched.body.party.contact_person).toBe('Ada');
    expect(patched.body.party.vat_id).toBe('ATU1');
    expect(patched.body.party.name).toBe('Alpha GmbH');
  });

  it('404s an unknown or non-numeric id', async () => {
    await request(app).get('/api/parties/9999').set(svc()).expect(404);
    await request(app).get('/api/parties/not-a-number').set(svc()).expect(404);
  });

  it('erases personal data in place, keeping the id and its references', async () => {
    const created = await resolve({
      name: 'Blaustern Café GmbH',
      email: 'a@blaustern.example',
      vat_id: 'ATU12345678',
      source: 'mod-04-invoice-billing',
      external_id: '17',
    });
    const id = created.body.party.id;

    const erased = await request(app).post(`/api/parties/${id}/erase`).set(svc());
    expect(erased.status).toBe(200);
    expect(erased.body.party.id).toBe(id);
    expect(erased.body.party.name).toBe(`[erased party ${id}]`);
    expect(erased.body.party.email).toBeNull();
    expect(erased.body.party.vat_id).toBeNull();
    expect(erased.body.party.address_lines).toEqual([]);
    expect(erased.body.party.archived_at).not.toBeNull();

    // The module's reference still resolves, so its foreign key stays valid.
    const refs = await request(app).get(`/api/parties/${id}/refs`).set(svc());
    expect(refs.body.refs).toHaveLength(1);
  });
});

describe('resolve — find or create', () => {
  it('creates when nothing matches, and says so', async () => {
    const res = await resolve({ name: 'Blaustern Café GmbH', vat_id: 'ATU12345678' });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.matched_on).toBe('created');
  });

  it('matches an existing party by VAT id however it was typed', async () => {
    const first = await resolve({ name: 'Blaustern Café GmbH', vat_id: 'ATU12345678' });
    const second = await resolve({ name: 'Blaustern Cafe', vat_id: 'atu 1234 5678' });
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.matched_on).toBe('vat_id');
    expect(second.body.party.id).toBe(first.body.party.id);
    // The known name is not overwritten by the second caller's version.
    expect(second.body.party.name).toBe('Blaustern Café GmbH');
  });

  it('matches by email when no VAT id is available', async () => {
    const first = await resolve({ name: 'Nordwind AG', email: 'rechnungen@nordwind.example' });
    const second = await resolve({ name: 'Nordwind', email: 'Rechnungen@Nordwind.Example' });
    expect(second.body.matched_on).toBe('email');
    expect(second.body.party.id).toBe(first.body.party.id);
  });

  it('prefers the caller reference over VAT id and email', async () => {
    const a = await resolve({ name: 'Alpha GmbH', vat_id: 'ATU1', source: 'mod-13-offers', external_id: '1' });
    // Same reference, contradictory VAT id: the reference wins.
    const again = await resolve({ name: 'Alpha GmbH', vat_id: 'ATU999', source: 'mod-13-offers', external_id: '1' });
    expect(again.body.matched_on).toBe('ref');
    expect(again.body.party.id).toBe(a.body.party.id);
    // ...and the known VAT id is not clobbered by the contradiction.
    expect(again.body.party.vat_id).toBe('ATU1');
  });

  it('enriches a matched party with fields it was missing', async () => {
    const first = await resolve({ name: 'Blaustern Café GmbH', vat_id: 'ATU12345678' });
    expect(first.body.party.email).toBeNull();
    expect(first.body.party.address_lines).toEqual([]);

    const second = await resolve({
      name: 'Blaustern Café GmbH',
      vat_id: 'ATU12345678',
      email: 'buchhaltung@blaustern.example',
      contact_person: 'Anna Berger',
      address_lines: ['Hauptstraße 12', '5020 Salzburg'],
    });
    expect(second.body.matched_on).toBe('vat_id');
    expect(second.body.party.email).toBe('buchhaltung@blaustern.example');
    expect(second.body.party.contact_person).toBe('Anna Berger');
    expect(second.body.party.address_lines).toEqual(['Hauptstraße 12', '5020 Salzburg']);
  });

  it('converges two modules importing the same customer onto one party', async () => {
    // This is the whole point of the service.
    const fromOffers = await resolve({
      name: 'Blaustern Café GmbH',
      vat_id: 'ATU12345678',
      source: 'mod-13-offers',
      external_id: '7',
    });
    const fromInvoicing = await resolve({
      name: 'Blaustern Café GmbH',
      vat_id: 'ATU12345678',
      source: 'mod-04-invoice-billing',
      external_id: '31',
    });
    expect(fromInvoicing.body.party.id).toBe(fromOffers.body.party.id);

    const refs = await request(app).get(`/api/parties/${fromOffers.body.party.id}/refs`).set(svc());
    expect(refs.body.refs.map((r: { source: string; external_id: string }) => `${r.source}/${r.external_id}`)).toEqual([
      'mod-04-invoice-billing/31',
      'mod-13-offers/7',
    ]);
  });

  it('is idempotent on the caller reference — repeated resolves create nothing', async () => {
    for (let i = 0; i < 3; i += 1) {
      await resolve({ name: 'Alpha GmbH', source: 'mod-04-invoice-billing', external_id: '5' });
    }
    const list = await request(app).get('/api/parties').set(svc());
    expect(list.body.parties).toHaveLength(1);
  });

  it('does not match an archived party — a new one is created instead', async () => {
    const first = await resolve({ name: 'Alpha GmbH', vat_id: 'ATU1' });
    await request(app).post(`/api/parties/${first.body.party.id}/archive`).set(svc()).expect(200);
    const second = await resolve({ name: 'Alpha GmbH', vat_id: 'ATU1' });
    expect(second.body.created).toBe(true);
    expect(second.body.party.id).not.toBe(first.body.party.id);
  });

  it('rejects source without external_id, and vice versa', async () => {
    const a = await resolve({ name: 'X', source: 'mod-04-invoice-billing' });
    expect(a.status).toBe(422);
    const b = await resolve({ name: 'X', external_id: '1' });
    expect(b.status).toBe(422);
  });

  it('refuses to resolve the self party', async () => {
    const res = await resolve({ name: 'Us GmbH', kind: 'self' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/PUT \/api\/self/);
  });
});

describe('references', () => {
  it('links a caller id and is idempotent', async () => {
    const created = await resolve({ name: 'Alpha GmbH' });
    const id = created.body.party.id;
    await request(app)
      .post(`/api/parties/${id}/refs`)
      .set(svc())
      .send({ source: 'mod-10-crm-lite', external_id: '99' })
      .expect(201);
    await request(app)
      .post(`/api/parties/${id}/refs`)
      .set(svc())
      .send({ source: 'mod-10-crm-lite', external_id: '99' })
      .expect(201);
    const refs = await request(app).get(`/api/parties/${id}/refs`).set(svc());
    expect(refs.body.refs).toHaveLength(1);
  });

  it('refuses to re-point a reference at another party', async () => {
    const a = await resolve({ name: 'Alpha GmbH', source: 'mod-10-crm-lite', external_id: '1' });
    const b = await resolve({ name: 'Beta AG', email: 'b@beta.example' });
    const res = await request(app)
      .post(`/api/parties/${b.body.party.id}/refs`)
      .set(svc())
      .send({ source: 'mod-10-crm-lite', external_id: '1' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(String(a.body.party.id));
  });

  it('requires both source and external_id', async () => {
    const created = await resolve({ name: 'Alpha GmbH' });
    const res = await request(app).post(`/api/parties/${created.body.party.id}/refs`).set(svc()).send({});
    expect(res.status).toBe(422);
    expect(res.body.details.map((d: { field: string }) => d.field)).toEqual(['source', 'external_id']);
  });
});

describe('the self party — one home for the seller identity', () => {
  it('is null before it is set, then round-trips', async () => {
    const before = await request(app).get('/api/self').set(svc());
    expect(before.body.party).toBeNull();

    const set = await request(app)
      .put('/api/self')
      .set(svc())
      .send({
        name: 'Acme Corporation',
        vat_id: 'ATU99999999',
        address_lines: ['Teststrasse 1', '1010 Wien'],
        iban: 'AT11 1111 1111 1111 1111',
        bic: 'ACMEXX',
        email: 'office@acme.example',
      });
    expect(set.status).toBe(200);
    expect(set.body.party.kind).toBe('self');

    const after = await request(app).get('/api/self').set(svc());
    expect(after.body.party.name).toBe('Acme Corporation');
    expect(after.body.party.address_lines).toEqual(['Teststrasse 1', '1010 Wien']);
    expect(after.body.party.iban).toBe('AT11 1111 1111 1111 1111');
  });

  it('updates in place rather than creating a second self party', async () => {
    await request(app).put('/api/self').set(svc()).send({ name: 'Acme Corporation' }).expect(200);
    await request(app).put('/api/self').set(svc()).send({ name: 'Acme GmbH', vat_id: 'ATU1' }).expect(200);
    const all = await request(app).get('/api/parties?kind=self').set(svc());
    expect(all.body.parties).toHaveLength(1);
    expect(all.body.parties[0].name).toBe('Acme GmbH');
  });

  it('replaces absent fields on a PUT (it is a put, not a patch)', async () => {
    await request(app).put('/api/self').set(svc()).send({ name: 'Acme', iban: 'AT1' }).expect(200);
    const second = await request(app).put('/api/self').set(svc()).send({ name: 'Acme' });
    expect(second.body.party.iban).toBeNull();
  });

  it('is excluded from the customer list and cannot be archived or erased', async () => {
    await request(app).put('/api/self').set(svc()).send({ name: 'Acme' }).expect(200);
    await resolve({ name: 'Alpha GmbH' });
    const customers = await request(app).get('/api/parties?kind=customer').set(svc());
    expect(customers.body.parties.map((p: Party) => p.name)).toEqual(['Alpha GmbH']);

    const self = await request(app).get('/api/self').set(svc());
    await request(app).post(`/api/parties/${self.body.party.id}/archive`).set(svc()).expect(409);
    await request(app).post(`/api/parties/${self.body.party.id}/erase`).set(svc()).expect(409);
  });

  it('refuses a second self party through POST /api/parties', async () => {
    await request(app).put('/api/self').set(svc()).send({ name: 'Acme' }).expect(200);
    const res = await request(app).post('/api/parties').set(svc()).send({ name: 'Other', kind: 'self' });
    expect(res.status).toBe(409);
  });
});

describe('metrics', () => {
  it('reports the active party count as a gauge', async () => {
    await resolve({ name: 'Alpha GmbH' });
    await resolve({ name: 'Beta AG', email: 'b@beta.example' });
    const res = await request(app).get('/api/metrics');
    expect(res.text).toContain('customers_parties_total{service="ps-11"} 2');
  });

  it('excludes archived parties from the gauge', async () => {
    const a = await resolve({ name: 'Alpha GmbH' });
    await request(app).post(`/api/parties/${a.body.party.id}/archive`).set(svc()).expect(200);
    const res = await request(app).get('/api/metrics');
    expect(res.text).toContain('customers_parties_total{service="ps-11"} 0');
  });
});
