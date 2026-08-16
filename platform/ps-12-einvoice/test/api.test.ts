import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import { buildCii } from '../server/cii.js';
import type { EInvoiceInput } from '../shared/types.js';

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
const SOURCE = 'mod-04-invoice-billing';

function invoice(overrides: Partial<EInvoiceInput> = {}): EInvoiceInput {
  return {
    number: 'INV-2026-0001',
    issue_date: '2026-07-20',
    due_date: '2026-08-03',
    currency: 'EUR',
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

function issue(body: Record<string, unknown>): request.Test {
  return request(app).post('/api/documents').set(svc()).send(body);
}

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, auth, now: () => Date.parse('2026-07-20T09:00:00Z') });
});

describe('auth', () => {
  it('refuses every operational route without a caller', async () => {
    for (const [method, path] of [
      ['post', '/api/validate'],
      ['post', '/api/documents'],
      ['get', '/api/documents'],
      ['get', `/api/documents/${SOURCE}/INV-2026-0001`],
      ['post', '/api/inbound'],
      ['get', '/api/inbound'],
    ] as const) {
      const res = await request(app)[method](path).send({});
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('accepts an admin session as well as the service token', async () => {
    const login = await request(app).post('/api/login').send({ username: 'admin', password: 'test-pass' });
    expect(login.status).toBe(200);
    const res = await request(app)
      .get('/api/documents')
      .set('Authorization', `Bearer ${login.body.token as string}`);
    expect(res.status).toBe(200);
  });

  it('serves health and readiness without a caller', async () => {
    expect((await request(app).get('/api/health')).status).toBe(200);
    expect((await request(app).get('/api/ready')).body).toEqual({ ready: true });
  });
});

describe('issuing a document', () => {
  it('issues, stores and returns the XML', async () => {
    const res = await issue({ source: SOURCE, invoice: invoice() });
    expect(res.status).toBe(201);
    expect(res.body.document).toMatchObject({
      source: SOURCE,
      number: 'INV-2026-0001',
      profile: 'en16931',
      syntax: 'cii',
      issued_at: '2026-07-20T09:00:00Z',
    });
    expect(res.body.document.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.xml).toContain('<ram:ID>INV-2026-0001</ram:ID>');
    expect(res.body.replayed).toBe(false);
  });

  // The gate. An invalid document is not written, not stored, not returned —
  // the caller gets the rule identifiers while the invoice is still fixable.
  it('REFUSES an invoice that breaks a rule, and names the rules', async () => {
    const res = await issue({ source: SOURCE, invoice: invoice({ gross_cents: 9999 }) });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('INV-2026-0001');
    const messages = (res.body.details as { message: string }[]).map((d) => d.message);
    expect(messages.some((m) => m.startsWith('BR-CO-15:'))).toBe(true);

    // And nothing was stored — a refused document must leave no trace, or the
    // next attempt would replay the failure instead of issuing.
    expect((db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n).toBe(0);
  });

  it('refuses an unknown profile', async () => {
    const res = await issue({ source: SOURCE, invoice: invoice(), profile: 'zugferd-v9' });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('en16931');
  });

  it('requires a source', async () => {
    const res = await issue({ invoice: invoice() });
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe('source');
  });

  it('applies the XRechnung profile when asked', async () => {
    const res = await issue({ source: SOURCE, invoice: invoice(), profile: 'xrechnung' });
    expect(res.status).toBe(201);
    expect(res.body.document.profile).toBe('xrechnung');
    expect(res.body.xml).toContain('xrechnung_3.0');
  });

  it('refuses under XRechnung what it accepts under EN 16931', async () => {
    const thin = invoice({ buyer_reference: null, payment: null });
    expect((await issue({ source: SOURCE, invoice: thin })).status).toBe(201);

    const strict = await issue({ source: `${SOURCE}-2`, invoice: thin, profile: 'xrechnung' });
    expect(strict.status).toBe(422);
    const messages = (strict.body.details as { message: string }[]).map((d) => d.message);
    expect(messages.some((m) => m.startsWith('BR-DE-15:'))).toBe(true);
    expect(messages.some((m) => m.startsWith('BR-DE-1:'))).toBe(true);
  });
});

describe('issuing is idempotent per source and invoice number', () => {
  // An invoice number is legally unique and gapless for the business that
  // issued it. Two different documents under one number is not a state worth
  // being able to reach, so a retry after a timeout replays rather than issues.
  it('a retry returns the first document, byte for byte', async () => {
    const first = await issue({ source: SOURCE, invoice: invoice() });
    expect(first.status).toBe(201);

    const retry = await issue({ source: SOURCE, invoice: invoice({ note: 'changed my mind' }) });
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.document.id).toBe(first.body.document.id);
    expect(retry.body.xml).toBe(first.body.xml);
    // The later note did NOT sneak into the stored document.
    expect(retry.body.xml).not.toContain('changed my mind');
    expect((db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n).toBe(1);
  });

  it('refuses to re-issue the same number under a different profile', async () => {
    await issue({ source: SOURCE, invoice: invoice() });
    const res = await issue({ source: SOURCE, invoice: invoice(), profile: 'xrechnung' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('one invoice number two documents');
  });

  it('scopes idempotency to the source, so two modules can use one number', async () => {
    await issue({ source: 'mod-04-invoice-billing', invoice: invoice() });
    const other = await issue({ source: 'mod-13-offers', invoice: invoice() });
    expect(other.status).toBe(201);
  });
});

describe('reading documents back', () => {
  it('fetches one by source and number, and serves the bare XML', async () => {
    await issue({ source: SOURCE, invoice: invoice() });

    const one = await request(app).get(`/api/documents/${SOURCE}/INV-2026-0001`).set(svc());
    expect(one.status).toBe(200);
    expect(one.body.xml).toContain('CrossIndustryInvoice');

    const file = await request(app).get(`/api/documents/${SOURCE}/INV-2026-0001/xml`).set(svc());
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('application/xml');
    expect(file.headers['content-disposition']).toContain('INV-2026-0001.xml');
    expect(file.text).toBe(one.body.xml);
  });

  it('404s a document that was never issued', async () => {
    expect((await request(app).get(`/api/documents/${SOURCE}/NOPE`).set(svc())).status).toBe(404);
  });

  it('lists documents, newest first, filtered by source', async () => {
    await issue({ source: SOURCE, invoice: invoice({ number: 'INV-1' }) });
    await issue({ source: SOURCE, invoice: invoice({ number: 'INV-2' }) });
    await issue({ source: 'mod-13-offers', invoice: invoice({ number: 'OFR-1' }) });

    const all = await request(app).get('/api/documents').set(svc());
    expect(all.body.documents).toHaveLength(3);
    expect(all.body.documents[0].number).toBe('OFR-1');

    const mine = await request(app).get(`/api/documents?source=${SOURCE}`).set(svc());
    expect(mine.body.documents.map((d: { number: string }) => d.number)).toEqual(['INV-2', 'INV-1']);
  });

  it('never returns the stored XML on a list — that is what the detail route is for', async () => {
    await issue({ source: SOURCE, invoice: invoice() });
    const list = await request(app).get('/api/documents').set(svc());
    expect(list.body.documents[0]).not.toHaveProperty('xml');
  });
});

describe('validating without issuing', () => {
  // A module calls this while the invoice is still a draft, so the operator
  // sees what is missing BEFORE the number is assigned and the document
  // becomes immutable — the only moment the fix is still cheap.
  it('reports violations and stores nothing', async () => {
    const res = await request(app)
      .post('/api/validate')
      .set(svc())
      .send({ invoice: invoice({ gross_cents: 1 }), profile: 'xrechnung' });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.profile).toBe('xrechnung');
    expect(res.body.violations.map((v: { rule: string }) => v.rule)).toContain('BR-CO-15');
    expect((db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n).toBe(0);
  });

  it('says a good invoice is good', async () => {
    const res = await request(app).post('/api/validate').set(svc()).send({ invoice: invoice() });
    expect(res.body).toEqual({ valid: true, profile: 'en16931', violations: [] });
  });
});

describe('receiving a document somebody sent us', () => {
  const incoming = (): string =>
    buildCii(
      invoice({
        number: 'SUPPLIER-77',
        seller: { name: 'Auer & Söhne GmbH', vat_id: 'ATU87654321', address: { country_code: 'AT' } },
      }),
      'en16931',
    );

  it('accepts raw XML and reports what it read', async () => {
    const res = await request(app).post('/api/inbound').set(svc()).type('application/xml').send(incoming());
    expect(res.status).toBe(201);
    expect(res.body.duplicate).toBe(false);
    expect(res.body.invoice).toMatchObject({
      number: 'SUPPLIER-77',
      issue_date: '2026-07-20',
      seller_name: 'Auer & Söhne GmbH',
      seller_vat_id: 'ATU87654321',
      gross_cents: 2962,
    });
  });

  it('accepts JSON { xml } as well, for a caller holding a string', async () => {
    const res = await request(app).post('/api/inbound').set(svc()).send({ xml: incoming() });
    expect(res.status).toBe(201);
  });

  // The same invoice arriving twice — a resent mail, a retried webhook — is
  // one invoice, and booking it twice is the expensive mistake here.
  it('deduplicates by content', async () => {
    const first = await request(app).post('/api/inbound').set(svc()).send({ xml: incoming() });
    const again = await request(app).post('/api/inbound').set(svc()).send({ xml: incoming() });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.id).toBe(first.body.id);
    expect((db.prepare('SELECT COUNT(*) AS n FROM inbound').get() as { n: number }).n).toBe(1);
  });

  it('stores a document it can only partly read, rather than losing it', async () => {
    // Unrecognised but well-formed. This may be the only copy, and a human can
    // read XML — refusing it would be the one unrecoverable outcome.
    const res = await request(app)
      .post('/api/inbound')
      .set(svc())
      .send({ xml: '<?xml version="1.0"?><Something><Else>1</Else></Something>' });
    expect(res.status).toBe(201);
    expect(res.body.invoice.number).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM inbound').get() as { n: number }).n).toBe(1);
  });

  it('422s something that is not XML at all, rather than 500', async () => {
    const res = await request(app).post('/api/inbound').set(svc()).send({ xml: 'this is a PDF, honestly' });
    expect(res.status).toBe(422);
  });

  // Entity expansion in a document from an unknown sender is the
  // billion-laughs and XXE surface. The feature is declined, not sandboxed.
  it('refuses a DOCTYPE outright', async () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>`;
    const res = await request(app).post('/api/inbound').set(svc()).send({ xml: xxe });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('DOCTYPE');
    expect((db.prepare('SELECT COUNT(*) AS n FROM inbound').get() as { n: number }).n).toBe(0);
  });

  it('requires a document', async () => {
    expect((await request(app).post('/api/inbound').set(svc()).send({})).status).toBe(422);
  });

  it('lists what has been received, newest first', async () => {
    await request(app).post('/api/inbound').set(svc()).send({ xml: incoming() });
    await request(app)
      .post('/api/inbound')
      .set(svc())
      .send({ xml: buildCii(invoice({ number: 'SUPPLIER-78' }), 'en16931') });
    const res = await request(app).get('/api/inbound').set(svc());
    expect(res.body.invoices.map((i: { number: string }) => i.number)).toEqual(['SUPPLIER-78', 'SUPPLIER-77']);
  });
});

describe('metrics', () => {
  it('counts issued and received documents', async () => {
    await issue({ source: SOURCE, invoice: invoice() });
    await issue({ source: SOURCE, invoice: invoice({ number: 'INV-2' }), profile: 'xrechnung' });
    await request(app).post('/api/inbound').set(svc()).send({ xml: '<?xml version="1.0"?><x/>' });

    const res = await request(app).get('/api/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('einvoice_documents_total{service="ps-12"} 2');
    expect(res.text).toContain('einvoice_documents_xrechnung_total{service="ps-12"} 1');
    expect(res.text).toContain('einvoice_inbound_total{service="ps-12"} 1');
    // An inbound document whose number could not be read is one a human has to
    // look at; a rising count means a sender's format is not understood.
    expect(res.text).toContain('einvoice_inbound_unparsed_total{service="ps-12"} 1');
  });
});

describe('the ZUGFeRD hybrid route', () => {
  /** The smallest structurally real PDF a caller could hand over. */
  function tinyPdf(): Buffer {
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
    ];
    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((b, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${b}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }

  it('embeds the issued XML into the caller-supplied PDF', async () => {
    await issue({ source: SOURCE, invoice: invoice() });
    const pdf = tinyPdf();
    const res = await request(app)
      .post(`/api/documents/${SOURCE}/INV-2026-0001/hybrid`)
      .set(svc())
      .type('application/pdf')
      .send(pdf);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('INV-2026-0001.pdf');

    const hybrid = Buffer.from(res.body as Buffer);
    // The caller's bytes are the prefix — PS-12 appends, it never rewrites.
    expect(hybrid.subarray(0, pdf.length).equals(pdf)).toBe(true);
    expect(hybrid.toString('latin1')).toContain('/AFRelationship /Alternative');
    expect(hybrid.toString('latin1')).toContain('CrossIndustryInvoice');
  });

  // The hybrid route embeds what was ALREADY validated. It is not a second way
  // in past the gate.
  it('404s an invoice that was never issued', async () => {
    const res = await request(app)
      .post(`/api/documents/${SOURCE}/NEVER-ISSUED/hybrid`)
      .set(svc())
      .type('application/pdf')
      .send(tinyPdf());
    expect(res.status).toBe(404);
  });

  it('422s something that is not a PDF, rather than 500', async () => {
    await issue({ source: SOURCE, invoice: invoice() });
    const res = await request(app)
      .post(`/api/documents/${SOURCE}/INV-2026-0001/hybrid`)
      .set(svc())
      .type('application/pdf')
      .send(Buffer.from('I am a spreadsheet'));
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('could not embed');
  });

  it('requires a body', async () => {
    await issue({ source: SOURCE, invoice: invoice() });
    const res = await request(app).post(`/api/documents/${SOURCE}/INV-2026-0001/hybrid`).set(svc()).send();
    expect(res.status).toBe(422);
  });

  it('marks an XRechnung document as XRECHNUNG in the XMP', async () => {
    await issue({ source: SOURCE, invoice: invoice(), profile: 'xrechnung' });
    const res = await request(app)
      .post(`/api/documents/${SOURCE}/INV-2026-0001/hybrid`)
      .set(svc())
      .type('application/pdf')
      .send(tinyPdf());
    expect(Buffer.from(res.body as Buffer).toString('latin1')).toContain(
      '<fx:ConformanceLevel>XRECHNUNG</fx:ConformanceLevel>',
    );
  });

  it('needs a caller', async () => {
    const res = await request(app)
      .post(`/api/documents/${SOURCE}/INV-2026-0001/hybrid`)
      .type('application/pdf')
      .send(tinyPdf());
    expect(res.status).toBe(401);
  });
});
