import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { loginModeOf } from '../server/sso.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildPlatform, noopPlatform, type InvoiceIssuedInfo } from '../server/platform.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';

const auth: AuthConfig = { username: 'admin', password: 'test-password', secret: 'test-secret', ttlHours: 1, secureCookie: false };
const seller: SellerConfig = {
  name: '0815software GmbH',
  addressLines: ['Beispielgasse 8/15', '1010 Wien', 'Austria'],
  vatId: 'ATU00000000',
  iban: 'AT00 0000 0000 0000 0000',
  bic: 'EXAMPLEX',
};

let db: Database.Database;

async function login(app: Express): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

/** Issue a fresh invoice and return its id + admin cookie. */
async function issueInvoice(app: Express): Promise<{ id: number; cookie: string }> {
  const cookie = await login(app);
  const draft = await request(app)
    .post('/api/invoices')
    .set('Cookie', cookie)
    .send({ customer_id: 1, payment_terms_days: 14, lines: [{ description: 'Svc', quantity: 1, unit_price_cents: 10_000, vat_rate: 20 }] });
  await request(app).post(`/api/invoices/${draft.body.id}/finalize`).set('Cookie', cookie).send({}).expect(200);
  return { id: draft.body.id, cookie };
}

async function issueFirstDraft(app: Express): Promise<void> {
  await issueInvoice(app);
}

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
});

describe('platform integration on invoice finalize', () => {
  it('invokes the platform hook with the issued invoice and the PDF its customer receives', async () => {
    const calls: InvoiceIssuedInfo[] = [];
    const app = createApp({
      db,
      auth,
      seller,
      platform: {
        ...noopPlatform,
        async invoiceIssued(info) {
          calls.push(info);
        },
      },
    });
    await issueFirstDraft(app);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.number).toMatch(/^INV-\d{4}-\d+$/); // issued number, not a draft
    expect(calls[0]!.totalFormatted).toContain('€');
    // The seeded customer takes no e-invoice: the archive gets the PDF.
    const document = calls[0]!.document();
    expect(document).toMatchObject({ filename: `${calls[0]!.number}.pdf`, contentType: 'application/pdf' });
    expect(document.content.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('is a no-op when no platform services are configured (standalone)', async () => {
    // buildPlatform with an empty config returns the shared no-op instance.
    expect(buildPlatform({})).toBe(noopPlatform);
    const app = createApp({ db, auth, seller }); // no platform option → noop
    await issueFirstDraft(app); // must not throw
  });

  it('a failing platform hook never fails the finalize (best-effort)', async () => {
    const app = createApp({
      db,
      auth,
      seller,
      platform: {
        ...noopPlatform,
        async invoiceIssued() {
          throw new Error('notification hub is down');
        },
      },
    });
    // The route swallows hook errors, so finalize still returns 200.
    await issueFirstDraft(app);
  });
});

describe('pay-an-invoice via PS-08', () => {
  it('records the payment when the intent settles synchronously', async () => {
    const app = createApp({
      db,
      auth,
      seller,
      platform: {
        ...noopPlatform,
        async payInvoice() {
          return { status: 'succeeded', public_id: 'pi_test' };
        },
      },
    });
    const { id, cookie } = await issueInvoice(app);
    const pay = await request(app).post(`/api/invoices/${id}/pay`).set('Cookie', cookie);
    expect(pay.status).toBe(200);
    expect(pay.body.payment.status).toBe('succeeded');
    expect(pay.body.invoice.payment_status).toBe('paid');
    expect(pay.body.invoice.open_cents).toBe(0);
  });

  it('leaves the invoice open when the intent is still processing', async () => {
    const app = createApp({
      db,
      auth,
      seller,
      platform: {
        ...noopPlatform,
        async payInvoice() {
          return { status: 'processing', public_id: 'pi_test' };
        },
      },
    });
    const { id, cookie } = await issueInvoice(app);
    const pay = await request(app).post(`/api/invoices/${id}/pay`).set('Cookie', cookie);
    expect(pay.body.payment.status).toBe('processing');
    expect(pay.body.invoice.payment_status).not.toBe('paid');
  });

  it('returns 501 when Payments is not configured', async () => {
    const app = createApp({ db, auth, seller }); // noop platform
    const { id, cookie } = await issueInvoice(app);
    expect((await request(app).post(`/api/invoices/${id}/pay`).set('Cookie', cookie)).status).toBe(501);
  });
});

describe('invoice numbering via PS-10', () => {
  it('uses the number from PS-10 when configured', async () => {
    const app = createApp({
      db,
      auth,
      seller,
      platform: {
        ...noopPlatform,
        async nextInvoiceNumber() {
          return 'INV-CUSTOM-0007';
        },
      },
    });
    const { id, cookie } = await issueInvoice(app);
    const detail = await request(app).get(`/api/invoices/${id}`).set('Cookie', cookie);
    expect(detail.body.number).toBe('INV-CUSTOM-0007');
  });

  it('falls back to the local gapless counter when PS-10 is unconfigured', async () => {
    const app = createApp({ db, auth, seller }); // noop
    const { id, cookie } = await issueInvoice(app);
    const detail = await request(app).get(`/api/invoices/${id}`).set('Cookie', cookie);
    expect(detail.body.number).toMatch(/^INV-\d{4}-\d{4}$/);
  });
});


describe('SSO login-exchange', () => {
  it('tells the login form which credentials this deployment accepts', async () => {
    // Public on purpose: the form reads it before anyone is signed in.
    await request(createApp({ db, auth, seller }))
      .get('/api/auth-mode')
      .expect(200)
      .expect({ sso: false });
    await request(createApp({ db, auth, seller, loginMode: { sso: true, org: 'acme' } }))
      .get('/api/auth-mode')
      .expect(200)
      .expect({ sso: true, org: 'acme' });
  });

  it('reads the login mode off the same config the verifier switches on', () => {
    expect(loginModeOf({})).toEqual({ sso: false });
    expect(loginModeOf({ identityUrl: 'http://ps01:4001' })).toEqual({ sso: false });
    expect(loginModeOf({ identityUrl: 'http://ps01:4001', identityOrg: 'acme' })).toEqual({
      sso: true,
      org: 'acme',
    });
  });

  it('lets PS-01 decide the login, bypassing local credentials', async () => {
    // The injected verifier stands in for a configured PS-01: it approves
    // despite a wrong local password, so the module must still issue a session.
    const app = createApp({ db, auth, seller, verifyLogin: async () => ({ ok: true, actor: 'ada@acme.test' }) });
    await request(app).post('/api/login').send({ username: 'admin', password: 'wrong-password' }).expect(200);
  });

  it('rejects when PS-01 rejects, even with correct local credentials', async () => {
    const app = createApp({ db, auth, seller, verifyLogin: async () => ({ ok: false }) });
    await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' }).expect(401);
  });

  it('falls back to local credentials when SSO is unconfigured (null)', async () => {
    const app = createApp({ db, auth, seller, verifyLogin: async () => null });
    await request(app).post('/api/login').send({ username: 'admin', password: 'nope' }).expect(401);
    await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' }).expect(200);
  });
});

describe('who issued this invoice', () => {
  it('reaches the audit trail as the PS-01 identity, not "admin"', async () => {
    const actors: string[] = [];
    const app = createApp({
      db,
      auth,
      seller,
      verifyLogin: async () => ({ ok: true, actor: 'ada@acme.test' }),
      platform: {
        ...noopPlatform,
        async invoiceIssued(info) {
          actors.push(info.actor);
        },
      },
    });
    const login = await request(app).post('/api/login').send({ username: 'x', password: 'y' }).expect(200);
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;

    const draft = await request(app)
      .post('/api/invoices')
      .set('Cookie', cookie)
      .send({ customer_id: 1, lines: [{ description: 'Work', quantity: 1, unit_price_cents: 10_000, vat_rate: 20 }] });
    expect(draft.status).toBe(201);
    await request(app).post(`/api/invoices/${draft.body.id}/finalize`).set('Cookie', cookie).expect(200);

    expect(actors).toEqual(['ada@acme.test']);
  });
});

// ── What leaves at issue, through stand-ins for PS-03 and PS-06 ─────────

/** A German seller with everything an XRechnung needs. */
const germanSeller: SellerConfig = {
  name: 'Beispiel GmbH',
  addressLines: ['Hauptstraße 1', '80331 München', 'Deutschland'],
  vatId: 'DE123456789',
  iban: 'DE02 1203 0000 0000 2020 51',
  bic: 'BYLADEM1001',
  contactName: 'Erika Mustermann',
  phone: '+49 89 123456',
  email: 'rechnung@beispiel.de',
};

/** PS-06 objects and PS-03 messages, as the clients send them. */
async function standIns() {
  const puts: { key: string; content_type?: string; content: Buffer }[] = [];
  const sends: { to: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, string>) : {};
      const object = /^\/api\/objects\/invoices\/([^/]+)$/.exec(req.url ?? '');
      if (req.method === 'PUT' && object) {
        puts.push({ key: decodeURIComponent(object[1]!), content_type: body.content_type, content: Buffer.from(body.content_base64!, 'base64') });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ bucket: 'invoices', key: object[1] }));
      } else if (req.method === 'POST' && req.url === '/api/send') {
        sends.push({ to: body.to!, body: body.body! });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: { id: '1', channel: body.channel, status: 'queued' } }));
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, puts, sends, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('what goes out at issue', () => {
  it('archives what the customer receives — its XRechnung, as every download serves it — and claims no attachment', async () => {
    const stub = await standIns();
    try {
      const own = openDb(':memory:');
      const app = createApp({ db: own, auth, seller: germanSeller, platform: buildPlatform({ notificationUrl: stub.url, filesUrl: stub.url, serviceToken: 't' }) });
      const cookie = await login(app);
      const issue = async (customer: object): Promise<number> => {
        const c = await request(app).post('/api/customers').set('Cookie', cookie).send(customer).expect(201);
        const d = await request(app).post('/api/invoices').set('Cookie', cookie)
          .send({ customer_id: c.body.id, lines: [{ description: 'Beratung', quantity: 2, unit: 'HUR', unit_price_cents: 9500, vat_rate: 19 }] });
        await request(app).post(`/api/invoices/${d.body.id}/finalize`).set('Cookie', cookie).send({ issue_date: '2026-10-21' }).expect(200);
        return d.body.id as number;
      };
      const kunde = { name: 'Kunde AG', email: 'ap@kunde.de', address: 'Kundenweg 5\n10115 Berlin', country_code: 'DE', buyer_reference: 'PO-1' };

      const xr = await issue({ ...kunde, einvoice_format: 'xrechnung' });
      const stored = own.prepare('SELECT filename, content FROM issued_documents WHERE invoice_id = ?').get(xr) as { filename: string; content: Buffer };
      expect(stub.puts[0]).toMatchObject({ key: stored.filename, content_type: 'application/xml; charset=utf-8' });
      expect(stub.puts[0]!.content.equals(stored.content)).toBe(true);
      const download = await request(app).get(`/api/invoices/${xr}/xrechnung.xml`).set('Cookie', cookie).expect(200);
      expect(download.text).toBe(stub.puts[0]!.content.toString('utf8'));

      const plain = await issue({ ...kunde, name: 'Privatkundin', einvoice_format: 'none' });
      const number = (own.prepare('SELECT number FROM invoices WHERE id = ?').get(plain) as { number: string }).number;
      expect(stub.puts[1]).toMatchObject({ key: `${number}.pdf`, content_type: 'application/pdf' });
      expect(own.prepare('SELECT COUNT(*) AS n FROM issued_documents WHERE invoice_id = ?').get(plain)).toEqual({ n: 0 });

      expect(stub.sends).toHaveLength(2);
      for (const sent of stub.sends) {
        expect(sent.body).toContain('has been issued');
        expect(sent.body).not.toContain('attached');
      }
    } finally {
      await stub.close();
    }
  });
});
