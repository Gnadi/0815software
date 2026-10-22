import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { noopPlatform, type PlatformHooks } from '../server/platform.js';
import { refreshSellerSource, type SelfParty } from '../server/seller.js';
import { SellerSource } from '../server/seller-settings.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';

/**
 * The seller as the admin maintains it on the Settings screen.
 *
 * What is pinned: a filled field beats PS-11 and the env, an emptied one
 * falls back again; a PS-11 refresh never undoes an admin's save; while PS-11
 * is wired it stays the one authority for the fields it carries; bad values
 * are refused; who changed what is recorded; and an invoice already issued
 * does not move.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 's'.repeat(32), ttlHours: 1, secureCookie: false };

function envSeller(): SellerConfig {
  return {
    name: 'Env GmbH',
    addressLines: ['Envgasse 1', '80331 München', 'Deutschland'],
    vatId: 'DE123456789',
    iban: 'DE02 1203 0000 0000 2020 51',
    bic: 'BYLADEM1001',
  };
}

const self: SelfParty = {
  name: 'Platform GmbH',
  vat_id: 'DE999999999',
  address_lines: ['Plattformweg 9', '10115 Berlin'],
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
};

let db: Database.Database;
let app: Express;
let cookie: string;
let seller: SellerConfig;
let audited: { actor: string; section: string; fields: string[] }[];

async function boot(options: { platformManaged?: boolean } = {}): Promise<SellerSource> {
  db = openDb(':memory:');
  seller = envSeller();
  audited = [];
  const source = new SellerSource(seller, options.platformManaged ?? false);
  if (options.platformManaged) source.setPlatform(self);
  const platform: PlatformHooks = {
    ...noopPlatform,
    async settingsChanged(info) {
      audited.push(info);
    },
  };
  app = createApp({ db, auth, seller, sellerSource: source, platform });
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'pw' });
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
  return source;
}

const field = (body: { fields: { key: string }[] }, key: string) =>
  body.fields.find((f) => f.key === key) as { value: string | null; source: string; locked: boolean; setting: string | null };

describe('the seller on the Settings screen', () => {
  beforeEach(async () => {
    await boot();
  });

  it('shows every field with its value and where it comes from', async () => {
    const res = await request(app).get('/api/settings/seller').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(field(res.body, 'name')).toMatchObject({ value: 'Env GmbH', source: 'env', locked: false });
    expect(field(res.body, 'phone')).toMatchObject({ value: null, source: 'unset' });
    expect(res.body.platform_managed).toBe(false);
    expect(res.body.problems.xrechnung.map((p: { term: string }) => p.term)).toEqual(['BT-41', 'BT-42', 'BT-43', 'BT-34']);
  });

  it('a saved field wins over the env, and the e-invoice becomes ready', async () => {
    const res = await request(app)
      .put('/api/settings/seller')
      .set('Cookie', cookie)
      .send({ name: 'Admin GmbH', contactName: 'Erika Mustermann', phone: '+49 89 1', email: 'rechnung@admin.de', registration: 'HRB 1' });
    expect(res.status).toBe(200);
    expect(field(res.body, 'name')).toMatchObject({ value: 'Admin GmbH', source: 'settings' });
    expect(res.body.problems.xrechnung).toEqual([]);
    expect(res.body.updated_by).toBe('admin');
    // The live config every screen reads changed with it.
    expect(seller.name).toBe('Admin GmbH');
    expect(seller.phone).toBe('+49 89 1');
    expect((await request(app).get('/api/payment-config').set('Cookie', cookie)).body.debtor_name).toBe('Admin GmbH');
  });

  it('an emptied field falls back to the env', async () => {
    await request(app).put('/api/settings/seller').set('Cookie', cookie).send({ name: 'Admin GmbH' });
    const res = await request(app).put('/api/settings/seller').set('Cookie', cookie).send({ name: '' });
    expect(field(res.body, 'name')).toMatchObject({ value: 'Env GmbH', source: 'env', setting: null });
    expect(seller.name).toBe('Env GmbH');
  });

  it('survives a restart: the next process loads what was saved', async () => {
    await request(app).put('/api/settings/seller').set('Cookie', cookie).send({ phone: '+49 1' });
    const fresh = envSeller();
    createApp({ db, auth, seller: fresh });
    expect(fresh.phone).toBe('+49 1');
  });

  it('refuses malformed values, field by field', async () => {
    const res = await request(app)
      .put('/api/settings/seller')
      .set('Cookie', cookie)
      .send({ iban: 'DE00 1234', bic: 'X', country: 'Germany', email: 'nope', vatId: '123' });
    expect(res.status).toBe(422);
    expect(res.body.details.map((d: { field: string }) => d.field)).toEqual(['country', 'vatId', 'iban', 'bic', 'email']);
    expect(seller.iban).toBe('DE02 1203 0000 0000 2020 51');
  });

  it('records who changed which fields — names, not values', async () => {
    await request(app).put('/api/settings/seller').set('Cookie', cookie).send({ phone: '+49 1', email: 'a@b.de' });
    await request(app).put('/api/settings/seller').set('Cookie', cookie).send({ phone: '+49 1', email: 'a@b.de' });
    expect(audited).toEqual([{ actor: 'admin', section: 'seller', fields: ['phone', 'email'] }]);
  });

  it('leaves invoices already issued exactly as they were', async () => {
    const customer = await request(app)
      .post('/api/customers')
      .set('Cookie', cookie)
      .send({ name: 'Kunde AG', email: 'ap@kunde.de', address: 'Weg 1\n10115 Berlin', country_code: 'DE' });
    const draft = await request(app)
      .post('/api/invoices')
      .set('Cookie', cookie)
      .send({ customer_id: customer.body.id, lines: [{ description: 'x', quantity: 1, unit_price_cents: 100, vat_rate: 19 }] });
    await request(app).post(`/api/invoices/${draft.body.id}/finalize`).set('Cookie', cookie).send({});
    const before = await request(app).get(`/api/invoices/${draft.body.id}/zugferd.pdf`).set('Cookie', cookie).buffer(true);
    expect(before.status).toBe(200);

    await request(app).put('/api/settings/seller').set('Cookie', cookie).send({ name: 'Renamed GmbH' });
    const after = await request(app).get(`/api/invoices/${draft.body.id}/zugferd.pdf`).set('Cookie', cookie).buffer(true);
    expect(Buffer.compare(before.body as Buffer, after.body as Buffer)).toBe(0);
  });
});

describe('with PS-11 Customers wired', () => {
  it('keeps PS-11 the authority for its fields and lets the admin set the rest', async () => {
    await boot({ platformManaged: true });
    const shown = (await request(app).get('/api/settings/seller').set('Cookie', cookie)).body;
    expect(field(shown, 'name')).toMatchObject({ value: 'Platform GmbH', source: 'platform', locked: true });
    expect(field(shown, 'phone')).toMatchObject({ locked: false });

    const refused = await request(app).put('/api/settings/seller').set('Cookie', cookie).send({ name: 'Mine', phone: '+49 1' });
    expect(refused.status).toBe(422);
    expect(refused.body.details.map((d: { field: string }) => d.field)).toEqual(['name']);

    const ok = await request(app).put('/api/settings/seller').set('Cookie', cookie).send({ phone: '+49 1' });
    expect(ok.status).toBe(200);
    expect(seller).toMatchObject({ name: 'Platform GmbH', phone: '+49 1' });
  });

  it('a PS-11 refresh never undoes what the admin saved', async () => {
    const source = await boot({ platformManaged: true });
    await request(app).put('/api/settings/seller').set('Cookie', cookie).send({ contactName: 'Erika' });
    await refreshSellerSource(source, async () => ({ ...self, name: 'Renamed in PS-11' }));
    expect(seller).toMatchObject({ name: 'Renamed in PS-11', contactName: 'Erika' });
    // And an unreachable PS-11 leaves the last known state.
    await refreshSellerSource(source, async () => {
      throw new Error('down');
    });
    expect(seller.name).toBe('Renamed in PS-11');
  });
});

describe('the export settings', () => {
  it('record who saved them and which settings changed', async () => {
    await boot();
    const current = (await request(app).get('/api/accounting-settings').set('Cookie', cookie)).body;
    expect(current.updated_by).toBeNull();
    const res = await request(app)
      .put('/api/accounting-settings')
      .set('Cookie', cookie)
      .send({
        ...current.settings,
        datev: { ...current.settings.datev, consultant_number: 1234567, client_number: 42 },
        bmd: { ...current.settings.bmd, revenue: { ...current.settings.bmd.revenue, AE: { account: 4060, tax_code: '9' } } },
      });
    expect(res.status).toBe(200);
    expect(res.body.updated_by).toBe('admin');
    expect(audited).toEqual([
      {
        actor: 'admin',
        section: 'accounting',
        fields: ['datev.consultant_number', 'datev.client_number', 'bmd.revenue.AE.account', 'bmd.revenue.AE.tax_code'],
      },
    ]);
  });
});

describe('upgrading from the first e-invoicing build', () => {
  it('adds who-saved-it to an existing export settings table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mod04-settings-'));
    try {
      const file = join(dir, 'db.sqlite');
      const old = new Database(file);
      old.exec(
        "CREATE TABLE accounting_settings (id INTEGER PRIMARY KEY CHECK (id = 1), settings TEXT NOT NULL, updated_at TEXT NOT NULL);" +
          "INSERT INTO accounting_settings VALUES (1, '{}', '2026-10-21T00:00:00Z');",
      );
      old.close();
      const upgraded = openDb(file);
      expect(upgraded.prepare('SELECT updated_by FROM accounting_settings').get()).toEqual({ updated_by: null });
      upgraded.close();
      openDb(file).close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
