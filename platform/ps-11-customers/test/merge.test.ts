import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { MIGRATIONS, openDb } from '../server/db.js';
import { runMigrations } from '../server/migrations.js';
import type { AuthConfig } from '../server/auth.js';
import type { MergeResult, Party, ResolveResult } from '../shared/types.js';

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

async function resolve(input: Record<string, unknown>): Promise<ResolveResult> {
  const res = await request(app).post('/api/parties/resolve').set(svc()).send(input);
  expect([200, 201]).toContain(res.status);
  return res.body as ResolveResult;
}

async function merge(loser: number, into: number): Promise<{ status: number; body: MergeResult }> {
  const res = await request(app).post(`/api/parties/${loser}/merge`).set(svc()).send({ into });
  return { status: res.status, body: res.body as MergeResult };
}

describe('supplier parties', () => {
  it('creates a supplier and keeps it out of the customer list', async () => {
    const supplier = await resolve({ kind: 'supplier', name: 'Auer & Söhne GmbH', vat_id: 'ATU87654321' });
    expect(supplier.party.kind).toBe('supplier');
    await resolve({ name: 'Blaustern Café GmbH', vat_id: 'ATU12345678' });

    const customers = await request(app).get('/api/parties?kind=customer').set(svc());
    expect(customers.body.parties.map((p: Party) => p.name)).toEqual(['Blaustern Café GmbH']);
    const suppliers = await request(app).get('/api/parties?kind=supplier').set(svc());
    expect(suppliers.body.parties.map((p: Party) => p.name)).toEqual(['Auer & Söhne GmbH']);
  });

  it('never matches across kinds, even on an identical VAT id', async () => {
    // A company you both buy from and sell to is two relationships. Silently
    // merging them would let a procurement import rewrite billing details.
    const customer = await resolve({ name: 'Doppel GmbH', vat_id: 'ATU55555555' });
    const supplier = await resolve({ kind: 'supplier', name: 'Doppel GmbH', vat_id: 'ATU55555555' });
    expect(supplier.created).toBe(true);
    expect(supplier.party.id).not.toBe(customer.party.id);
  });

  it('never matches across kinds on an identical email either', async () => {
    const customer = await resolve({ name: 'Doppel GmbH', email: 'office@doppel.example' });
    const supplier = await resolve({ kind: 'supplier', name: 'Doppel GmbH', email: 'office@doppel.example' });
    expect(supplier.party.id).not.toBe(customer.party.id);
  });

  it('refuses to reuse another kind’s reference', async () => {
    await resolve({ name: 'Doppel GmbH', source: 'mod-10-crm-lite', external_id: '1' });
    const res = await request(app)
      .post('/api/parties/resolve')
      .set(svc())
      .send({ kind: 'supplier', name: 'Doppel GmbH', source: 'mod-10-crm-lite', external_id: '1' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/linked to a customer party/);
  });

  it('rejects an unknown kind, listing the valid ones', async () => {
    const res = await request(app).post('/api/parties').set(svc()).send({ name: 'X', kind: 'partner' });
    expect(res.status).toBe(422);
    expect(res.body.details[0].message).toContain('customer, supplier, self');
    const query = await request(app).get('/api/parties?kind=partner').set(svc());
    expect(query.status).toBe(422);
  });

  it('counts each kind on its own gauge', async () => {
    await resolve({ name: 'Blaustern Café GmbH' });
    await resolve({ kind: 'supplier', name: 'Auer GmbH' });
    await resolve({ kind: 'supplier', name: 'Nordwind Zulieferer' });
    const res = await request(app).get('/api/metrics');
    expect(res.text).toContain('customers_parties_total{service="ps-11"} 1');
    expect(res.text).toContain('customers_suppliers_total{service="ps-11"} 2');
  });
});

describe('merging duplicates', () => {
  it('moves references onto the survivor so both modules agree', async () => {
    // The situation merge exists for: one import had a VAT id, the other an
    // email, so nothing matched and the stack holds the company twice.
    const a = await resolve({ name: 'Blaustern Café GmbH', vat_id: 'ATU12345678', source: 'mod-13-offers', external_id: '7' });
    const b = await resolve({
      name: 'Blaustern Cafe',
      email: 'buchhaltung@blaustern.example',
      source: 'mod-04-invoice-billing',
      external_id: '31',
    });
    expect(b.party.id).not.toBe(a.party.id);

    const merged = await merge(b.party.id, a.party.id);
    expect(merged.status).toBe(200);
    expect(merged.body.merged_id).toBe(b.party.id);
    expect(merged.body.moved_refs).toBe(1);
    expect(merged.body.party.id).toBe(a.party.id);

    const refs = await request(app).get(`/api/parties/${a.party.id}/refs`).set(svc());
    expect(refs.body.refs.map((r: { source: string }) => r.source).sort()).toEqual([
      'mod-04-invoice-billing',
      'mod-13-offers',
    ]);

    const list = await request(app).get('/api/parties').set(svc());
    expect(list.body.parties).toHaveLength(1);
  });

  it('enriches the survivor with what only the loser knew, and clobbers nothing', async () => {
    const survivor = await resolve({ name: 'Blaustern Café GmbH', vat_id: 'ATU12345678' });
    const loser = await resolve({
      name: 'Blaustern Cafe',
      email: 'buchhaltung@blaustern.example',
      contact_person: 'Anna Berger',
      address_lines: ['Hauptstraße 12', '5020 Salzburg'],
      vat_id: 'ATU99999999',
    });

    const merged = await merge(loser.party.id, survivor.party.id);
    expect(merged.body.party.email).toBe('buchhaltung@blaustern.example');
    expect(merged.body.party.contact_person).toBe('Anna Berger');
    expect(merged.body.party.address_lines).toEqual(['Hauptstraße 12', '5020 Salzburg']);
    // The survivor's own name and VAT id are untouched by the loser's versions.
    expect(merged.body.party.name).toBe('Blaustern Café GmbH');
    expect(merged.body.party.vat_id).toBe('ATU12345678');
  });

  it('redirects a consumer still holding the old id', async () => {
    const survivor = await resolve({ name: 'Alpha GmbH', vat_id: 'ATU1' });
    const loser = await resolve({ name: 'Alpha Gmbh', email: 'a@alpha.example' });
    await merge(loser.party.id, survivor.party.id);

    const res = await request(app).get(`/api/parties/${loser.party.id}`).set(svc());
    expect(res.status).toBe(200);
    expect(res.body.party.id).toBe(survivor.party.id);
    expect(res.body.requested_id).toBe(loser.party.id);
  });

  it('keeps a stale reference resolving to the survivor', async () => {
    const survivor = await resolve({ name: 'Alpha GmbH', vat_id: 'ATU1' });
    const loser = await resolve({ name: 'Alpha Gmbh', source: 'mod-10-crm-lite', external_id: '9' });
    await merge(loser.party.id, survivor.party.id);

    // The module re-resolves with the id it has always used.
    const again = await resolve({ name: 'Alpha Gmbh', source: 'mod-10-crm-lite', external_id: '9' });
    expect(again.created).toBe(false);
    expect(again.matched_on).toBe('ref');
    expect(again.party.id).toBe(survivor.party.id);
  });

  it('drops a duplicate reference rather than failing on the primary key', async () => {
    // Both parties carry the same module reference — possible if one was linked
    // by hand. The merge must not blow up on the unique (source, external_id).
    const survivor = await resolve({ name: 'Alpha GmbH', source: 'mod-10-crm-lite', external_id: '5' });
    const loser = await resolve({ name: 'Alpha Gmbh', email: 'a@alpha.example' });
    db.prepare('UPDATE party_refs SET party_id = ? WHERE source = ?').run(loser.party.id, 'mod-10-crm-lite');
    db.prepare('INSERT INTO party_refs (party_id, source, external_id, created_at) VALUES (?, ?, ?, ?)').run(
      survivor.party.id,
      'mod-10-crm-lite',
      '5b',
      '2026-01-01T00:00:00Z',
    );

    const merged = await merge(loser.party.id, survivor.party.id);
    expect(merged.status).toBe(200);
    const refs = await request(app).get(`/api/parties/${survivor.party.id}/refs`).set(svc());
    expect(refs.body.refs.map((r: { external_id: string }) => r.external_id).sort()).toEqual(['5', '5b']);
  });

  it('refuses to merge across kinds, into itself, or the self party', async () => {
    const customer = await resolve({ name: 'Alpha GmbH', vat_id: 'ATU1' });
    const supplier = await resolve({ kind: 'supplier', name: 'Auer GmbH', vat_id: 'ATU2' });
    expect((await merge(supplier.party.id, customer.party.id)).status).toBe(409);
    expect((await merge(customer.party.id, customer.party.id)).status).toBe(422);

    const self = await request(app).put('/api/self').set(svc()).send({ name: 'Acme' });
    expect((await merge(self.body.party.id, customer.party.id)).status).toBe(409);
    expect((await merge(customer.party.id, self.body.party.id)).status).toBe(409);
  });

  it('refuses to merge a party twice, and points at the survivor', async () => {
    const a = await resolve({ name: 'Alpha GmbH', vat_id: 'ATU1' });
    const b = await resolve({ name: 'Alpha Two', vat_id: 'ATU2' });
    const cc = await resolve({ name: 'Alpha Three', vat_id: 'ATU3' });
    await merge(b.party.id, a.party.id);

    const again = await merge(b.party.id, cc.party.id);
    expect(again.status).toBe(409);
    expect((again.body as unknown as { error: string }).error).toContain(String(a.party.id));

    // ...and merging INTO a party that was itself merged away is refused too.
    const into = await merge(cc.party.id, b.party.id);
    expect(into.status).toBe(409);
    expect((into.body as unknown as { error: string }).error).toMatch(/merge into that one/);
  });

  it('404s an unknown party on either side', async () => {
    const a = await resolve({ name: 'Alpha GmbH' });
    expect((await merge(9999, a.party.id)).status).toBe(404);
    expect((await merge(a.party.id, 9999)).status).toBe(404);
  });

  it('requires a numeric `into`', async () => {
    const a = await resolve({ name: 'Alpha GmbH' });
    const res = await request(app).post(`/api/parties/${a.party.id}/merge`).set(svc()).send({ into: 'nope' });
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe('into');
  });

  it('refuses to archive or erase a party that was merged away', async () => {
    const a = await resolve({ name: 'Alpha GmbH', vat_id: 'ATU1' });
    const b = await resolve({ name: 'Alpha Two', vat_id: 'ATU2' });
    await merge(b.party.id, a.party.id);
    const archived = await request(app).post(`/api/parties/${b.party.id}/archive`).set(svc());
    expect(archived.status).toBe(409);
    expect(archived.body.error).toContain(String(a.party.id));
  });
});

describe('migration 002', () => {
  it('rebuilds parties without losing references or idempotency records', () => {
    // The rebuild widens a CHECK constraint, which SQLite cannot ALTER. Run the
    // v1 baseline alone, put data in, then apply 002 and check nothing was
    // cascade-deleted by the DROP.
    const fresh = new Database(':memory:');
    fresh.pragma('foreign_keys = OFF');
    runMigrations(fresh, MIGRATIONS.slice(0, 1));

    fresh
      .prepare(
        `INSERT INTO parties (kind, name, email, vat_id, address_lines, created_at, updated_at)
         VALUES ('customer', 'Legacy GmbH', 'a@legacy.example', 'ATU1', 'Line 1\nLine 2', 'T', 'T')`,
      )
      .run();
    const id = (fresh.prepare('SELECT id FROM parties').get() as { id: number }).id;
    fresh
      .prepare('INSERT INTO party_refs (party_id, source, external_id, created_at) VALUES (?, ?, ?, ?)')
      .run(id, 'mod-04-invoice-billing', '42', 'T');
    fresh.prepare('INSERT INTO idempotency (key, party_id, created_at) VALUES (?, ?, ?)').run('k1', id, 'T');

    // Every migration after the baseline runs. Expressed as a count derived
    // from MIGRATIONS rather than a literal, so appending 004 does not fail a
    // test that is about data survival, not about how many migrations exist.
    expect(runMigrations(fresh, MIGRATIONS)).toBe(MIGRATIONS.length - 1);

    const party = fresh.prepare('SELECT * FROM parties WHERE id = ?').get(id) as Record<string, unknown>;
    expect(party.name).toBe('Legacy GmbH');
    expect(party.address_lines).toBe('Line 1\nLine 2');
    expect(party.merged_into).toBeNull();
    // 003 is additive: a party that predates the structured address adopts the
    // columns as NULL and keeps every other field. Nothing is back-filled by
    // guessing at the free-text lines above.
    expect(party.street).toBeNull();
    expect(party.postcode).toBeNull();
    expect(party.city).toBeNull();
    expect(party.country_code).toBeNull();
    expect((fresh.prepare('SELECT COUNT(*) AS n FROM party_refs').get() as { n: number }).n).toBe(1);
    expect((fresh.prepare('SELECT COUNT(*) AS n FROM idempotency').get() as { n: number }).n).toBe(1);

    // The widened CHECK now accepts a supplier, and still rejects nonsense.
    fresh
      .prepare(
        `INSERT INTO parties (kind, name, address_lines, created_at, updated_at)
         VALUES ('supplier', 'Auer GmbH', '', 'T', 'T')`,
      )
      .run();
    expect(() =>
      fresh
        .prepare(
          `INSERT INTO parties (kind, name, address_lines, created_at, updated_at)
           VALUES ('partner', 'Nope GmbH', '', 'T', 'T')`,
        )
        .run(),
    ).toThrow();

    // The one-self index survived the rebuild.
    fresh
      .prepare(
        `INSERT INTO parties (kind, name, address_lines, created_at, updated_at)
         VALUES ('self', 'Us GmbH', '', 'T', 'T')`,
      )
      .run();
    expect(() =>
      fresh
        .prepare(
          `INSERT INTO parties (kind, name, address_lines, created_at, updated_at)
           VALUES ('self', 'Us Again GmbH', '', 'T', 'T')`,
        )
        .run(),
    ).toThrow();

    fresh.pragma('foreign_keys = ON');
    expect(fresh.pragma('foreign_key_check')).toEqual([]);
    fresh.close();
  });

  it('leaves a freshly opened database fully migrated and referentially sound', () => {
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
