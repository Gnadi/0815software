import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import { ISO_3166_1_ALPHA_2, isCountryCode, normalizeCountryCode } from '../shared/countries.js';
import type { Party } from '../shared/types.js';

/**
 * The structured postal address (migration 003).
 *
 * `address_lines` is the letterhead — how a human wants the address printed.
 * These four fields are the same address as data, because EN 16931 does not
 * accept an address as lines of text: a compliant e-invoice carries an ISO
 * 3166-1 country code, and recipients match on post code and city. Guessing
 * those out of free text is the failure mode this exists to prevent — an
 * e-invoice built on a guessed address is silently rejected weeks later by the
 * recipient's system, which is worse than not sending one.
 */

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

async function create(body: Record<string, unknown>): Promise<request.Response> {
  return request(app).post('/api/parties').set(svc()).send(body);
}

const FULL = {
  name: 'Blaustern Café GmbH',
  address_lines: ['Hauptstraße 12', '5020 Salzburg', 'Austria'],
  street: 'Hauptstraße 12',
  postcode: '5020',
  city: 'Salzburg',
  country_code: 'AT',
};

describe('country code validation', () => {
  it('accepts a real code and normalizes its case and padding', async () => {
    const res = await create({ name: 'Nordwind AG', country_code: ' de ' });
    expect(res.status).toBe(201);
    expect((res.body.party as Party).country_code).toBe('DE');
  });

  // The point of shipping the ISO list rather than testing `^[A-Z]{2}$`: a
  // shape check accepts every two-letter typo, and a wrong country code is
  // invisible until a recipient's validator refuses the invoice.
  it.each(['XX', 'ZZ', 'QQ', 'DA', 'Germany', 'D', 'DEU', '12'])(
    'refuses %o with a 422 naming the field',
    async (code) => {
      const res = await create({ name: 'Nordwind AG', country_code: code });
      expect(res.status).toBe(422);
      expect(res.body.details[0].field).toBe('country_code');
    },
  );

  it.each([undefined, null, ''])('treats %o as "not given", not as an error', async (code) => {
    const res = await create({ name: 'Nordwind AG', country_code: code });
    expect(res.status).toBe(201);
    expect((res.body.party as Party).country_code).toBeNull();
  });

  it('exposes a plausible ISO list, including the EU VAT special cases', () => {
    expect(ISO_3166_1_ALPHA_2.length).toBeGreaterThan(200);
    for (const code of ['AT', 'DE', 'CH', 'FR', 'IT', 'US', 'EL', 'XI']) {
      expect(isCountryCode(code), code).toBe(true);
    }
    expect(new Set(ISO_3166_1_ALPHA_2).size).toBe(ISO_3166_1_ALPHA_2.length);
    expect([...ISO_3166_1_ALPHA_2].sort()).toEqual([...ISO_3166_1_ALPHA_2]);
    expect(normalizeCountryCode('xx')).toBeNull();
  });
});

describe('the structured address round-trips', () => {
  it('stores and returns all four fields alongside the letterhead', async () => {
    const created = await create(FULL);
    expect(created.status).toBe(201);
    const party = created.body.party as Party;
    expect(party).toMatchObject({ street: 'Hauptstraße 12', postcode: '5020', city: 'Salzburg', country_code: 'AT' });
    // The letterhead is untouched — the two forms coexist, neither derived.
    expect(party.address_lines).toEqual(['Hauptstraße 12', '5020 Salzburg', 'Austria']);

    const read = await request(app).get(`/api/parties/${party.id}`).set(svc());
    expect(read.body.party).toMatchObject({ postcode: '5020', country_code: 'AT' });
  });

  it('patches one field without disturbing the others', async () => {
    const { body } = await create(FULL);
    const res = await request(app)
      .patch(`/api/parties/${body.party.id}`)
      .set(svc())
      .send({ city: 'Wien', postcode: '1010' });
    expect(res.status).toBe(200);
    expect(res.body.party).toMatchObject({ city: 'Wien', postcode: '1010', street: 'Hauptstraße 12', country_code: 'AT' });
  });

  it('never invents structured fields from the printed lines', async () => {
    // "5020 Salzburg" is right there in the text and is NOT parsed out. A
    // guessed address is the thing this contract exists to avoid.
    const res = await create({ name: 'Guessy GmbH', address_lines: ['Hauptstraße 12', '5020 Salzburg', 'Austria'] });
    expect(res.status).toBe(201);
    expect(res.body.party).toMatchObject({ street: null, postcode: null, city: null, country_code: null });
  });
});

describe('resolve enriches the structured address', () => {
  async function resolve(body: Record<string, unknown>): Promise<Party> {
    const res = await request(app).post('/api/parties/resolve').set(svc()).send(body);
    expect([200, 201]).toContain(res.status);
    return res.body.party as Party;
  }

  it('fills fields the master record is missing', async () => {
    await resolve({ name: 'Nordwind AG', vat_id: 'DE811234567' });
    const enriched = await resolve({
      name: 'Nordwind AG',
      vat_id: 'DE811234567',
      street: 'Hafenstraße 4',
      postcode: '20359',
      city: 'Hamburg',
      country_code: 'DE',
    });
    expect(enriched).toMatchObject({ street: 'Hafenstraße 4', postcode: '20359', city: 'Hamburg', country_code: 'DE' });
  });

  it('never clobbers a field the master record already has', async () => {
    await resolve({ name: 'Nordwind AG', vat_id: 'DE811234567', city: 'Hamburg', country_code: 'DE' });
    const second = await resolve({ name: 'Nordwind AG', vat_id: 'DE811234567', city: 'Bremen', country_code: 'AT' });
    expect(second.city).toBe('Hamburg');
    expect(second.country_code).toBe('DE');
  });

  // Each field enriches on its own. Treating the address as one all-or-nothing
  // unit would leave a party that arrived with a partial address incomplete
  // forever — which, for an e-invoice, means permanently unsendable.
  it('completes a partial address field by field across several imports', async () => {
    await resolve({ name: 'Nordwind AG', vat_id: 'DE811234567', country_code: 'DE' });
    await resolve({ name: 'Nordwind AG', vat_id: 'DE811234567', city: 'Hamburg' });
    const done = await resolve({ name: 'Nordwind AG', vat_id: 'DE811234567', postcode: '20359', street: 'Hafenstraße 4' });
    expect(done).toMatchObject({ street: 'Hafenstraße 4', postcode: '20359', city: 'Hamburg', country_code: 'DE' });
  });
});

describe('merge and erase cover the structured address', () => {
  it('a merge keeps what only the loser knew', async () => {
    const survivor = await create({ name: 'Alpha GmbH', vat_id: 'ATU1', city: 'Wien' });
    const loser = await create({ name: 'Alpha Gmbh', vat_id: 'ATU2', postcode: '1010', country_code: 'AT' });
    const res = await request(app)
      .post(`/api/parties/${loser.body.party.id}/merge`)
      .set(svc())
      .send({ into: survivor.body.party.id });
    expect(res.status).toBe(200);
    expect(res.body.party).toMatchObject({ city: 'Wien', postcode: '1010', country_code: 'AT' });
  });

  // A street and post code identify a sole trader exactly as the printed lines
  // do. Leaving them behind would defeat the erasure through the back door.
  it('an erasure clears every address field, structured included', async () => {
    const { body } = await create(FULL);
    const res = await request(app).post(`/api/parties/${body.party.id}/erase`).set(svc());
    expect(res.status).toBe(200);
    expect(res.body.party).toMatchObject({
      address_lines: [],
      street: null,
      postcode: null,
      city: null,
      country_code: null,
    });
  });

  it('a subject-access export carries the structured address', async () => {
    await create({ ...FULL, email: 'buchhaltung@blaustern.example' });
    const res = await request(app).get('/api/export?subject=buchhaltung@blaustern.example').set(svc());
    expect(res.status).toBe(200);
    expect(res.body.records.parties[0]).toMatchObject({ postcode: '5020', country_code: 'AT' });
  });
});

describe('the self party carries it too', () => {
  it('PUT /api/self accepts and returns the structured address', async () => {
    const res = await request(app)
      .put('/api/self')
      .set(svc())
      .send({ name: '0815software GmbH', street: 'Teststraße 1', postcode: '4020', city: 'Linz', country_code: 'AT' });
    expect(res.status).toBe(200);
    expect(res.body.party).toMatchObject({ kind: 'self', postcode: '4020', country_code: 'AT' });

    const read = await request(app).get('/api/self').set(svc());
    expect(read.body.party).toMatchObject({ street: 'Teststraße 1', city: 'Linz' });
  });

  it('refuses a bad country code on the seller as firmly as on a customer', async () => {
    const res = await request(app).put('/api/self').set(svc()).send({ name: 'Seller GmbH', country_code: 'XX' });
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe('country_code');
  });
});

describe('the seeded demo data is e-invoice ready', () => {
  it('every seeded party has a complete structured address', async () => {
    const { seed } = await import('../server/seed.js');
    seed(db);
    const res = await request(app).get('/api/parties').set(svc());
    expect(res.body.parties.length).toBeGreaterThan(0);
    for (const party of res.body.parties as Party[]) {
      expect(party.street, party.name).toBeTruthy();
      expect(party.postcode, party.name).toBeTruthy();
      expect(party.city, party.name).toBeTruthy();
      expect(isCountryCode(party.country_code), party.name).toBe(true);
    }
  });
});
