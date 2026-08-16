import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
// Drive the *real* client source against the *real* service over HTTP — the
// one test that catches client↔service drift (see the ps-02 contract test).
import { EInvoiceClient, ServiceError, type EInvoiceInput } from '../../clients/src/index.js';

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

beforeAll(() => {
  db = openDb(':memory:');
  server = createApp({ db, auth }).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

function invoice(overrides: Partial<EInvoiceInput> = {}): EInvoiceInput {
  return {
    number: 'INV-2026-0001',
    issue_date: '2026-07-20',
    due_date: '2026-08-03',
    buyer_reference: '991-33333TEST-33',
    seller: {
      name: '0815software GmbH',
      vat_id: 'ATU12345678',
      email: 'rechnung@0815software.example',
      address: { street: 'Teststraße 1', postcode: '4020', city: 'Linz', country_code: 'AT' },
    },
    buyer: {
      name: 'Nordwind AG',
      vat_id: 'DE811234567',
      address: { street: 'Hafenstraße 4', postcode: '20359', city: 'Hamburg', country_code: 'DE' },
    },
    lines: [
      { id: '1', name: 'Consulting', quantity: 2, unit_price_cents: 1234, vat_category: 'S', vat_rate: 20, net_cents: 2468 },
    ],
    vat_breakdown: [{ category: 'S', rate: 20, base_cents: 2468, vat_cents: 494 }],
    net_cents: 2468,
    vat_total_cents: 494,
    gross_cents: 2962,
    payment: { iban: 'AT611904300234573201', bic: 'BKAUATWW' },
    ...overrides,
  };
}

describe('EInvoiceClient ↔ PS-12 contract', () => {
  const client = (): EInvoiceClient => new EInvoiceClient({ baseUrl, serviceToken: 'test-service' });

  it('validates, issues, reads back and lists', async () => {
    const einvoice = client();

    const check = await einvoice.validate(invoice(), 'xrechnung');
    expect(check).toEqual({ valid: true, profile: 'xrechnung', violations: [] });

    const issued = await einvoice.issue('mod-04-invoice-billing', invoice(), 'xrechnung');
    expect(issued.replayed).toBe(false);
    expect(issued.document.number).toBe('INV-2026-0001');
    expect(issued.xml).toContain('xrechnung_3.0');

    const fetched = await einvoice.getDocument('mod-04-invoice-billing', 'INV-2026-0001');
    expect(fetched.xml).toBe(issued.xml);
    expect(fetched.document.sha256).toBe(issued.document.sha256);

    const listed = await einvoice.listDocuments({ source: 'mod-04-invoice-billing' });
    expect(listed.documents.map((d) => d.number)).toContain('INV-2026-0001');
  });

  it('reports violations through the client rather than throwing', async () => {
    const result = await client().validate(invoice({ gross_cents: 1 }));
    expect(result.valid).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain('BR-CO-15');
  });

  it('surfaces a refused issue as a ServiceError carrying the rules', async () => {
    // The failure mode a caller has to handle: the invoice is not issuable, and
    // the reason has to survive the transport in a form a human can act on.
    await expect(client().issue('mod-04-invoice-billing', invoice({ number: 'BAD-1', gross_cents: 1 }))).rejects.toThrow(
      ServiceError,
    );
    try {
      await client().issue('mod-04-invoice-billing', invoice({ number: 'BAD-2', gross_cents: 1 }));
      expect.unreachable('issue should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).status).toBe(422);
      expect(JSON.stringify(err)).toContain('BR-CO-15');
    }
  });

  it('replays an issue rather than minting a second document', async () => {
    const einvoice = client();
    const first = await einvoice.issue('mod-13-offers', invoice({ number: 'REPLAY-1' }));
    const second = await einvoice.issue('mod-13-offers', invoice({ number: 'REPLAY-1' }));
    expect(second.replayed).toBe(true);
    expect(second.document.id).toBe(first.document.id);
  });

  it('receives an inbound document and deduplicates it', async () => {
    const einvoice = client();
    const issued = await einvoice.issue('mod-04-invoice-billing', invoice({ number: 'ROUNDTRIP-1' }));

    const received = await einvoice.receive(issued.xml);
    expect(received.duplicate).toBe(false);
    expect(received.invoice.number).toBe('ROUNDTRIP-1');
    expect(received.invoice.gross_cents).toBe(2962);

    const again = await einvoice.receive(issued.xml);
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(received.id);

    const listed = await einvoice.listInbound();
    expect(listed.invoices.map((i) => i.number)).toContain('ROUNDTRIP-1');
  });
});
