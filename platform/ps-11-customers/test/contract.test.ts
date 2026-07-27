import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
// Drive the *real* client source against the *real* service over HTTP — the
// one test that catches client↔service drift (see ps-02 contract test).
import { CustomersClient } from '../../clients/src/index.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};

let server: Server;
let baseUrl: string;
let db: Database.Database;

beforeAll(async () => {
  db = openDb(':memory:');
  server = createApp({ db, auth }).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

describe('CustomersClient ↔ PS-11 contract', () => {
  it('resolves, enriches, links and lists a party', async () => {
    const customers = new CustomersClient({ baseUrl, serviceToken: 'test-service' });

    const created = await customers.resolve({
      name: 'Blaustern Café GmbH',
      vat_id: 'ATU12345678',
      source: 'mod-13-offers',
      external_id: '7',
    });
    expect(created.created).toBe(true);
    expect(created.matched_on).toBe('created');
    expect(created.party.vat_id).toBe('ATU12345678');

    // A second module resolving the same customer converges on one party.
    const matched = await customers.resolve({
      name: 'Blaustern Cafe',
      vat_id: 'atu 1234 5678',
      email: 'buchhaltung@blaustern.example',
      source: 'mod-04-invoice-billing',
      external_id: '31',
    });
    expect(matched.created).toBe(false);
    expect(matched.matched_on).toBe('vat_id');
    expect(matched.party.id).toBe(created.party.id);
    expect(matched.party.email).toBe('buchhaltung@blaustern.example');

    const fetched = await customers.get(created.party.id);
    expect(fetched.party.name).toBe('Blaustern Café GmbH');
    expect(fetched.refs.map((r) => r.source).sort()).toEqual(['mod-04-invoice-billing', 'mod-13-offers']);

    const listed = await customers.list({ q: 'Blaustern' });
    expect(listed.parties).toHaveLength(1);

    const updated = await customers.update(created.party.id, { contact_person: 'Anna Berger' });
    expect(updated.party.contact_person).toBe('Anna Berger');

    const linked = await customers.link(created.party.id, 'mod-10-crm-lite', '5');
    expect(linked.ref.party_id).toBe(created.party.id);
  });

  it('round-trips the seller identity through the self party', async () => {
    const customers = new CustomersClient({ baseUrl, serviceToken: 'test-service' });

    expect((await customers.self()).party).toBeNull();
    const set = await customers.setSelf({
      name: 'Acme Corporation',
      vat_id: 'ATU99999999',
      address_lines: ['Teststrasse 1', '1010 Wien'],
    });
    expect(set.party.kind).toBe('self');
    const self = await customers.self();
    expect(self.party?.name).toBe('Acme Corporation');
    expect(self.party?.address_lines).toEqual(['Teststrasse 1', '1010 Wien']);
  });

  it('resolves a supplier without ever touching the customer of the same name', async () => {
    const customers = new CustomersClient({ baseUrl, serviceToken: 'test-service' });
    const asCustomer = await customers.resolve({ name: 'Doppel GmbH', vat_id: 'ATU55555555' });
    const asSupplier = await customers.resolve({
      kind: 'supplier',
      name: 'Doppel GmbH',
      vat_id: 'ATU55555555',
      source: 'mod-06-procurement-tracker',
      external_id: '3',
    });
    expect(asSupplier.created).toBe(true);
    expect(asSupplier.party.kind).toBe('supplier');
    expect(asSupplier.party.id).not.toBe(asCustomer.party.id);
  });

  it('merges two records and redirects the old id', async () => {
    const customers = new CustomersClient({ baseUrl, serviceToken: 'test-service' });
    const survivor = await customers.resolve({ name: 'Merge Survivor GmbH', vat_id: 'ATU70000001' });
    const loser = await customers.resolve({
      name: 'Merge Loser GmbH',
      email: 'loser@merge.example',
      source: 'mod-10-crm-lite',
      external_id: '77',
    });

    const merged = await customers.merge(loser.party.id, survivor.party.id);
    expect(merged.party.id).toBe(survivor.party.id);
    expect(merged.merged_id).toBe(loser.party.id);
    expect(merged.moved_refs).toBe(1);
    // The survivor gained what only the loser knew.
    expect(merged.party.email).toBe('loser@merge.example');

    const stale = await customers.get(loser.party.id);
    expect(stale.party.id).toBe(survivor.party.id);
    expect(stale.requested_id).toBe(loser.party.id);
    expect(stale.party.merged_into).toBeNull();
  });

  it('surfaces a service error as ServiceError with its status', async () => {
    const customers = new CustomersClient({ baseUrl, serviceToken: 'test-service' });
    await expect(customers.get(999_999)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects a caller with no credentials', async () => {
    const anonymous = new CustomersClient({ baseUrl });
    await expect(anonymous.list()).rejects.toMatchObject({ status: 401 });
  });
});
