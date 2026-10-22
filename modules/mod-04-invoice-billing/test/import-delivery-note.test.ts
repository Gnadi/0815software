import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import { buildPlatform, noopPlatform } from '../server/platform.js';
import { TRANSFER_VERSION, transferLineNet, transferTotals, type DocumentTransfer } from '../shared/transfer.js';

/**
 * Billing a delivery note from MOD-17: one draft per delivery, for exactly
 * what was delivered, idempotent on the delivery note number — and MOD-17
 * told, over HTTP, that it was billed.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 's', ttlHours: 1, secureCookie: false };
const seller: SellerConfig = { name: 'Muster GmbH', addressLines: ['Lassallestraße 5', '1020 Wien'], vatId: 'ATU12345678', iban: 'AT611904300234573201', bic: 'BKAUATWW' };
const TOKEN = 'machine-token';
const as = (access: AccessLevel) => `${COOKIE_NAME}=${createToken(auth, `${access}@example`, Date.now(), access)}`;

/** A delivery note as MOD-17 puts it on the wire: 3 of 4 desks, 10 % off. */
function delivery(reference = 'LS-2026-0001', kind: DocumentTransfer['origin']['kind'] = 'delivery'): DocumentTransfer {
  const base = { description: 'Schreibtisch', quantity: 3, unit_price_cents: 38900, discount_percent: 10, vat_rate: 20 };
  const lines = [{ ...base, net_cents: transferLineNet(base) }];
  return {
    transfer_version: TRANSFER_VERSION,
    origin: { kind, module: 'mod-17-orders-delivery', reference, issued_at: '2026-10-20', accepted_at: '2026-10-18' },
    currency: 'EUR',
    customer: { name: 'Beispiel AG', contact_person: null, email: 'office@beispiel.example', vat_id: null, address_lines: ['Ring 5', '1010 Wien'], party_id: null, source: 'mod-13-offers', external_id: '7' },
    lines,
    totals: transferTotals(lines),
    note: 'Lieferschein LS-2026-0001 vom 2026-10-20 zu Auftrag AB-2026-0003',
  };
}

/** A stand-in MOD-17: serves transfers and records the "invoiced" calls. */
let server: Server;
let ordersUrl: string;
let notes: Record<string, DocumentTransfer>;
let billed: { number: string; token: string | undefined; body: unknown }[];

beforeEach(async () => {
  notes = { 'LS-2026-0001': delivery(), 'AN-2026-0007': { ...delivery('AN-2026-0007', 'offer') } };
  billed = [];
  server = createServer((req, res) => {
    const transfer = /^\/api\/delivery-notes\/([^/]+)\/transfer$/.exec(req.url ?? '');
    const invoiced = /^\/api\/delivery-notes\/([^/]+)\/invoiced$/.exec(req.url ?? '');
    if (transfer && req.method === 'GET') {
      const note = notes[decodeURIComponent(transfer[1]!)];
      res.writeHead(note ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(note ?? { error: 'Delivery note not found' }));
      return;
    }
    if (invoiced && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        billed.push({ number: decodeURIComponent(invoiced[1]!), token: req.headers['x-service-token'] as string | undefined, body: JSON.parse(raw) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  ordersUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function appWith(db: Database.Database): Express {
  return createApp({ db, auth, seller, platform: { ...noopPlatform, ...buildPlatform({ ordersUrl, serviceToken: TOKEN }) } });
}

describe('POST /api/invoices/import-delivery-note', () => {
  it('bills exactly what was delivered, once, and tells MOD-17', async () => {
    const db = openDb(':memory:');
    const app = appWith(db);
    const first = await request(app).post('/api/invoices/import-delivery-note').set('Cookie', as('edit')).send({ delivery_note_number: 'LS-2026-0001' }).expect(201);
    // Discounted lines are folded to their exact net, as for an offer: 3 × 389.00 − 10 % = 1050.30.
    expect(first.body).toMatchObject({ status: 'draft', imported: true, net_cents: 105030, gross_cents: 126036, customer_name: 'Beispiel AG' });
    expect(first.body.note).toContain('LS-2026-0001');
    expect(billed).toEqual([
      { number: 'LS-2026-0001', token: TOKEN, body: { reference: `mod-04-invoice-billing:draft ${first.body.id}`, actor: 'edit@example' } },
    ]);

    const again = await request(app).post('/api/invoices/import-delivery-note').set('Cookie', as('edit')).send({ delivery_note_number: 'LS-2026-0001' }).expect(200);
    expect(again.body).toMatchObject({ id: first.body.id, imported: false });
    expect(billed).toHaveLength(1);
    // The idempotency key is qualified by the module, so it cannot meet an offer number.
    expect(db.prepare('SELECT origin_offer_number FROM invoices').all()).toEqual([{ origin_offer_number: 'mod-17-orders-delivery:LS-2026-0001' }]);
  });

  it('refuses what is not a delivery note, an unknown one, and a viewer', async () => {
    const app = appWith(openDb(':memory:'));
    const offer = await request(app).post('/api/invoices/import-delivery-note').set('Cookie', as('edit')).send({ delivery_note_number: 'AN-2026-0007' }).expect(422);
    expect(offer.body.error).toMatch(/Expected a delivery note/);
    await request(app).post('/api/invoices/import-delivery-note').set('Cookie', as('edit')).send({ delivery_note_number: 'LS-1999-0001' }).expect(404);
    await request(app).post('/api/invoices/import-delivery-note').set('Cookie', as('edit')).send({}).expect(422);
    await request(app).post('/api/invoices/import-delivery-note').set('Cookie', as('view')).send({ delivery_note_number: 'LS-2026-0001' }).expect(403);
    expect(billed).toEqual([]);
  });

  it('the offer route refuses a delivery, so each source bills only its own kind', async () => {
    const app = createApp({
      db: openDb(':memory:'),
      auth,
      seller,
      platform: { ...noopPlatform, fetchOffer: async () => delivery() },
    });
    const res = await request(app).post('/api/invoices/import-offer').set('Cookie', as('edit')).send({ offer_number: 'LS-2026-0001' }).expect(422);
    expect(res.body.error).toMatch(/Expected an accepted offer/);
  });

  it('says plainly when no order source is configured', async () => {
    const app = createApp({ db: openDb(':memory:'), auth, seller });
    await request(app).post('/api/invoices/import-delivery-note').set('Cookie', as('edit')).send({ delivery_note_number: 'LS-2026-0001' }).expect(501);
  });
});
