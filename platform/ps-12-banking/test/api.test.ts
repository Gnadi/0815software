import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { Transport } from '../server/transport.js';
import type { AuthConfig } from '../server/auth.js';
import { MockBank } from './mock-bank.js';

/**
 * The HTTP surface, and above all the line drawn through it.
 *
 * A module's `X-Service-Token` may submit an order and read one. It may not
 * create a bank connection, may not activate one, and may not touch a key. At
 * signature class E a submitted order is money gone, so what bounds a leaked
 * service token is the ceilings a human set on a connection a human activated
 * — and that bound is only real if the token cannot reach those routes.
 *
 * So every operator route is checked twice: once for "no credential at all"
 * and once for "a valid service token", and the second is the one that would
 * quietly stop being true if someone swapped a middleware.
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};

const KEY_SECRET = '55'.repeat(32);
const SERVICE = { 'X-Service-Token': 'test-service' };

const BTF = { service_name: 'SCT', scope: 'AT', msg_name: 'pain.001', msg_version: '03', container: 'XML' };

let db: Database.Database;
let bank: MockBank;
let app: Express;
let session: string;

function pain001(msgId: string, total = '100.00', count = 1): string {
  const each = (Number(total) / count).toFixed(2);
  const tx = Array.from(
    { length: count },
    () => `<CdtTrfTxInf><Amt><InstdAmt Ccy="EUR">${each}</InstdAmt></Amt></CdtTrfTxInf>`,
  ).join('');
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn>` +
      `<GrpHdr><MsgId>${msgId}</MsgId><NbOfTxs>${count}</NbOfTxs><CtrlSum>${total}</CtrlSum></GrpHdr>` +
      `<PmtInf>${tx}</PmtInf></CstmrCdtTrfInitn></Document>`,
    'utf8',
  ).toString('base64');
}

/** Drive a connection to `ready` over HTTP, the way an operator would. */
async function bringUp(key = 'main', overrides: Record<string, unknown> = {}): Promise<void> {
  await request(app)
    .post('/api/connections')
    .set('Authorization', `Bearer ${session}`)
    .send({
      key,
      display_name: 'Test Bank',
      bank_key: 'at-sepa',
      url: 'https://bank.example/ebics',
      host_id: bank.hostId,
      partner_id: 'PARTNER1',
      user_id: 'USER1',
      ...overrides,
    })
    .expect(201);

  const as = (path: string) => request(app).post(path).set('Authorization', `Bearer ${session}`);
  await as(`/api/connections/${key}/keys`).expect(201);
  await as(`/api/connections/${key}/ini`).expect(200);
  await as(`/api/connections/${key}/hia`).expect(200);
  const hpb = await as(`/api/connections/${key}/hpb`).expect(200);

  const digest = (purpose: string): string =>
    (hpb.body.bank_keys as { purpose: string; digestFormatted: string }[]).find((k) => k.purpose === purpose)!
      .digestFormatted;
  await as(`/api/connections/${key}/verify-bank-keys`)
    .send({ auth_digest: digest('AUTH'), enc_digest: digest('ENC') })
    .expect(200);
}

beforeEach(async () => {
  db = openDb(':memory:');
  bank = new MockBank();
  app = createApp({
    db,
    auth,
    keySecret: KEY_SECRET,
    transport: new Transport({ post: async (_url, body) => bank.post(body) }),
  });
  const login = await request(app).post('/api/login').send({ username: 'admin', password: 'test-pass' }).expect(200);
  session = login.body.token as string;
});

// ── The credential line ───────────────────────────────────────────────

describe('who may do what', () => {
  const OPERATOR_ROUTES: [string, string][] = [
    ['post', '/api/connections'],
    ['get', '/api/connections'],
    ['get', '/api/connections/main'],
    ['post', '/api/connections/main/keys'],
    ['post', '/api/connections/main/ini'],
    ['post', '/api/connections/main/hia'],
    ['post', '/api/connections/main/hpb'],
    ['get', '/api/connections/main/ini-letter.pdf'],
    ['post', '/api/connections/main/verify-bank-keys'],
    ['post', '/api/connections/main/suspend'],
    ['post', '/api/connections/main/resume'],
  ];

  it.each(OPERATOR_ROUTES)('%s %s needs a credential', async (method, path) => {
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
    expect(res.status).toBe(401);
  });

  it.each(OPERATOR_ROUTES)('%s %s refuses a service token — this is the whole boundary', async (method, path) => {
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)
      [method]!(path)
      .set(SERVICE);
    // 403, not 401: the caller IS authenticated, with the wrong credential for
    // a human's job. Saying so is what stops someone "fixing" it by adding the
    // service token to a module's config.
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin session/);
  });

  it.each([
    ['get', '/api/orders'],
    ['get', '/api/orders/ord_x'],
    ['post', '/api/orders'],
    ['post', '/api/tick'],
    ['get', '/api/banks'],
  ] as [string, string][])('%s %s accepts a service token', async (method, path) => {
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)
      [method]!(path)
      .set(SERVICE);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('leaves health, ready and metrics open', async () => {
    await request(app).get('/api/health').expect(200);
    await request(app).get('/api/ready').expect(200);
    await request(app).get('/api/metrics').expect(200);
  });
});

// ── The bank profile registry ─────────────────────────────────────────

describe('GET /api/banks', () => {
  it('says of every profile where its values came from', async () => {
    const res = await request(app).get('/api/banks').set(SERVICE).expect(200);
    expect(res.body.banks.length).toBeGreaterThan(0);
    for (const profile of res.body.banks) expect(profile.source).toBeTruthy();

    // Confirmed means "transcribed from that market's published mapping
    // table", nothing more. Anything shaped by analogy — the generic profile
    // — must say it is a guess.
    const byKey = Object.fromEntries(res.body.banks.map((b: { key: string }) => [b.key, b]));
    expect(byKey['de-sepa'].confirmed).toBe(true);
    expect(byKey['de-sepa'].source).toMatch(/ebics\.de/);
    expect(byKey['at-sepa'].confirmed).toBe(true);
    expect(byKey['at-sepa'].source).toMatch(/ebics\.psa\.at/);
    expect(byKey['generic'].confirmed).toBe(false);
  });

  it('keeps Austria and Germany apart where their tables disagree', async () => {
    const res = await request(app).get('/api/banks').set(SERVICE).expect(200);
    const byKey = Object.fromEntries(res.body.banks.map((b: { key: string }) => [b.key, b]));

    // The one difference that a copy-by-analogy gets wrong, and did: the
    // Austrian table sets Scope=AT on a plain SEPA credit transfer, the
    // German one leaves it off entirely. Same service name, different BTF.
    expect(byKey['at-sepa'].creditTransfer.scope).toBe('AT');
    expect(byKey['de-sepa'].creditTransfer.scope).toBeUndefined();

    // Austria's table gives no variant/version for pain.001 — the schema in
    // force is read from the file's ISO namespace. Inventing one here would
    // name a message the bank never published.
    expect(byKey['at-sepa'].creditTransfer.msg_variant).toBeUndefined();
    expect(byKey['at-sepa'].creditTransfer.msg_version).toBeUndefined();

    // And neither market puts a container on a single pain.001: adding one
    // names the several-files-in-one-container variant instead.
    expect(byKey['at-sepa'].creditTransfer.container).toBeUndefined();
    expect(byKey['de-sepa'].creditTransfer.container).toBeUndefined();
  });

  it('carries the EBICS 2.5 order types, because banks still talk in them', async () => {
    const res = await request(app).get('/api/banks').set(SERVICE).expect(200);
    const de = res.body.banks.find((b: { key: string }) => b.key === 'de-sepa');
    // "We've enabled CCT and C53 for you" is what an operator hears on the
    // phone; nothing sends these, but somebody has to be able to translate.
    expect(de.legacyOrderTypes).toEqual({ creditTransfer: 'CCT', statement: 'C53', paymentStatus: 'CRZ' });
  });

  it('carries no URLs and no host ids — those come from the contract', async () => {
    const res = await request(app).get('/api/banks').set(SERVICE).expect(200);
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toMatch(/https?:\/\//);
  });
});

// ── Distributed signature ─────────────────────────────────────────────

describe('what the attached signature is for', () => {
  it('tells the bank the order carries its own authorisation, by default', async () => {
    // Signature class E: the ES this service attaches IS the authorisation.
    // Saying nothing would have meant the opposite — "authorise this outside
    // EBICS" — and a bank would have parked the payment for a human.
    await bringUp('main');
    await request(app)
      .post('/api/orders')
      .set(SERVICE)
      .send({ connection: 'main', payload_base64: pain001('E1') })
      .expect(201);

    expect(bank.received[0]!.signature).toEqual({ flagPresent: true, requestEDS: false });
  });

  it('asks the bank to spool into its distributed-signature queue when the account needs it', async () => {
    // An account whose bank agreement wants two signatories: without this the
    // bank rejects a single-signature order outright rather than holding it.
    await bringUp('twosig', { request_eds: true });
    const detail = await request(app)
      .get('/api/connections/twosig')
      .set('Authorization', `Bearer ${session}`)
      .expect(200);
    expect(detail.body.request_eds).toBe(true);

    await request(app)
      .post('/api/orders')
      .set(SERVICE)
      .send({ connection: 'twosig', payload_base64: pain001('E2') })
      .expect(201);

    expect(bank.received[0]!.signature).toEqual({ flagPresent: true, requestEDS: true });
  });

  it('defaults to false, so nothing is spooled by accident', async () => {
    await bringUp('main');
    const detail = await request(app)
      .get('/api/connections/main')
      .set('Authorization', `Bearer ${session}`)
      .expect(200);
    expect(detail.body.request_eds).toBe(false);
  });
});

// ── The Product element ───────────────────────────────────────────────

describe('the client product identification', () => {
  it('names the client software on the wire when the connection carries a Product', async () => {
    // Optional in H005, and the service sent none for a long time. The
    // Austrian specification's own worked ebicsRequest example carries it,
    // and a bank uses it to tell one customer product from another when a
    // support call comes in.
    await bringUp('withprod', {
      product_name: '0815software PS-12',
      product_language: 'de',
      product_institute_id: 'INST0815',
    });

    const detail = await request(app)
      .get('/api/connections/withprod')
      .set('Authorization', `Bearer ${session}`)
      .expect(200);
    expect(detail.body.product_name).toBe('0815software PS-12');

    // Every message from the key exchange onwards, not just the first.
    expect(bank.requests.length).toBeGreaterThan(2);
    for (const body of bank.requests.slice(1)) {
      expect(body).toContain('<e:Product InstituteID="INST0815" Language="de">0815software PS-12</e:Product>');
    }

    // And on an actual upload.
    await request(app)
      .post('/api/orders')
      .set(SERVICE)
      .send({ connection: 'withprod', payload_base64: pain001('P1') })
      .expect(201);
    expect(bank.requests.at(-1)).toBeDefined();
    expect(bank.requests.some((b) => b.includes('BTUOrderParams') && b.includes('<e:Product '))).toBe(true);
  });

  it('sends no Product element at all when the connection names none', async () => {
    // The default, and what every message looked like before the element
    // existed here. An empty Product is not the same thing as no Product.
    await bringUp('noprod');
    for (const body of bank.requests) expect(body).not.toContain('<e:Product');
  });

  it('refuses a product name with no language, because the schema requires one', async () => {
    // Language is `use="required"` on the element. A name without it would
    // build a message the bank's own parser rejects — better to say so while
    // the operator still has the form open.
    const res = await request(app)
      .post('/api/connections')
      .set('Authorization', `Bearer ${session}`)
      .send({
        key: 'halfprod',
        display_name: 'Test Bank',
        bank_key: 'at-sepa',
        url: 'https://bank.example/ebics',
        host_id: bank.hostId,
        partner_id: 'PARTNER1',
        user_id: 'USER1',
        product_name: '0815software PS-12',
      })
      .expect(422);
    expect(res.body.details[0].field).toBe('product_language');
  });
});

// ── The lifecycle over HTTP ───────────────────────────────────────────

describe('bringing a connection up', () => {
  it('walks created → ready and only then accepts an order', async () => {
    await bringUp();
    const detail = await request(app)
      .get('/api/connections/main')
      .set('Authorization', `Bearer ${session}`)
      .expect(200);
    expect(detail.body.state).toBe('ready');

    const order = await request(app)
      .post('/api/orders')
      .set(SERVICE)
      .send({ connection: 'main', btf: BTF, payload_base64: pain001('M1') })
      .expect(201);
    expect(order.body.status).toBe('accepted');
  });

  it('refuses an order before a human confirmed the bank keys', async () => {
    const as = (path: string) => request(app).post(path).set('Authorization', `Bearer ${session}`);
    await as('/api/connections')
      .send({
        key: 'raw',
        display_name: 'Test',
        bank_key: 'generic',
        url: 'https://bank.example/ebics',
        host_id: bank.hostId,
        partner_id: 'P1',
        user_id: 'U1',
      })
      .expect(201);
    await as('/api/connections/raw/keys').expect(201);
    await as('/api/connections/raw/ini').expect(200);
    await as('/api/connections/raw/hia').expect(200);
    await as('/api/connections/raw/hpb').expect(200);

    const res = await request(app)
      .post('/api/orders')
      .set(SERVICE)
      .send({ connection: 'raw', btf: BTF, payload_base64: pain001('M1') })
      .expect(409);
    expect(res.body.error).toMatch(/nobody has confirmed/);
    expect(bank.received).toEqual([]);
  });

  it('refuses an unknown bank profile at creation, not at the first upload', async () => {
    const res = await request(app)
      .post('/api/connections')
      .set('Authorization', `Bearer ${session}`)
      .send({
        key: 'typo',
        display_name: 'Test',
        bank_key: 'at-sepax',
        url: 'https://bank.example/ebics',
        host_id: 'H',
        partner_id: 'P',
        user_id: 'U',
      })
      .expect(422);
    expect(res.body.details[0].field).toBe('bank_key');
  });

  it('never returns key material, on any route', async () => {
    await bringUp();
    for (const path of ['/api/connections', '/api/connections/main']) {
      const res = await request(app).get(path).set('Authorization', `Bearer ${session}`).expect(200);
      expect(JSON.stringify(res.body)).not.toMatch(/PRIVATE KEY/);
    }
  });
});

// ── The INI letter ────────────────────────────────────────────────────

describe('the INI letter', () => {
  it('is a PDF carrying the digests a human will compare', async () => {
    const as = (path: string) => request(app).post(path).set('Authorization', `Bearer ${session}`);
    await as('/api/connections')
      .send({
        key: 'main',
        display_name: 'Test Bank',
        bank_key: 'at-sepa',
        url: 'https://bank.example/ebics',
        host_id: 'MOCKHOST',
        partner_id: 'PARTNER1',
        user_id: 'USER1',
      })
      .expect(201);
    const keys = await as('/api/connections/main/keys').expect(201);

    const res = await request(app)
      .get('/api/connections/main/ini-letter.pdf')
      .set('Authorization', `Bearer ${session}`)
      .expect(200);

    expect(res.headers['content-type']).toContain('application/pdf');
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');

    // The digests have to actually be ON the page: a letter that renders but
    // omits them is worse than no letter, because it gets signed and posted.
    const text = pdf.toString('latin1');
    for (const key of keys.body.keys as { digestFormatted: string }[]) {
      expect(text).toContain(key.digestFormatted.slice(0, 8));
    }
    // Both letters — INI for the signature key, HIA for the other two.
    expect(text).toContain('EBICS INI Letter');
    expect(text).toContain('EBICS HIA Letter');
    expect(text).not.toMatch(/PRIVATE KEY/);

    // The cross-reference table is hand-written, and a wrong offset produces a
    // file that some viewers repair silently and others refuse. Check that
    // every offset really lands on the object it claims.
    const startxref = Number(/startxref\s+(\d+)/.exec(text)![1]);
    const xref = text.slice(startxref);
    expect(xref.startsWith('xref')).toBe(true);
    const offsets = [...xref.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets.length).toBeGreaterThan(4);
    offsets.forEach((offset, i) => {
      expect(text.slice(offset, offset + 20)).toMatch(new RegExp(`^${i + 1} 0 obj`));
    });
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('refuses to print before there are keys', async () => {
    await request(app)
      .post('/api/connections')
      .set('Authorization', `Bearer ${session}`)
      .send({
        key: 'bare',
        display_name: 'Test',
        bank_key: 'generic',
        url: 'https://bank.example/ebics',
        host_id: 'H',
        partner_id: 'P',
        user_id: 'U',
      })
      .expect(201);
    await request(app)
      .get('/api/connections/bare/ini-letter.pdf')
      .set('Authorization', `Bearer ${session}`)
      .expect(409);
  });
});

// ── Orders over HTTP ──────────────────────────────────────────────────

describe('POST /api/orders', () => {
  beforeEach(async () => {
    await bringUp();
  });

  it('answers 201 for a new order and 200 for a replay of the same one', async () => {
    const payload = { connection: 'main', btf: BTF, payload_base64: pain001('M1'), idempotency_key: 'run:M1' };
    const first = await request(app).post('/api/orders').set(SERVICE).send(payload).expect(201);
    const second = await request(app).post('/api/orders').set(SERVICE).send(payload).expect(200);

    expect(second.body.public_id).toBe(first.body.public_id);
    expect(bank.received).toHaveLength(1);
  });

  it('?validate=1 signs nothing and stores nothing', async () => {
    const before = bank.requests.length;
    const res = await request(app)
      .post('/api/orders?validate=1')
      .set(SERVICE)
      .send({ connection: 'main', btf: BTF, payload_base64: pain001('M1', '250.00', 2) })
      .expect(200);

    expect(res.body).toMatchObject({ msg_id: 'M1', amount_minor: 25_000, tx_count: 2, problems: [] });
    expect(bank.requests).toHaveLength(before);
    const list = await request(app).get('/api/orders').set(SERVICE).expect(200);
    expect(list.body.orders).toEqual([]);
  });

  it('reports ceiling problems in a preview rather than throwing', async () => {
    await bringUp('capped', { partner_id: 'P2', user_id: 'U2', max_amount_minor: 1_000, max_transfers: 1 });
    const res = await request(app)
      .post('/api/orders?validate=1')
      .set(SERVICE)
      .send({ connection: 'capped', btf: BTF, payload_base64: pain001('M9', '500.00', 3) })
      .expect(200);
    expect(res.body.problems).toHaveLength(2);
  });

  it('refuses a payload that is not really base64', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set(SERVICE)
      .send({ connection: 'main', btf: BTF, payload_base64: 'this is not base64 !!!' })
      .expect(422);
    // Buffer.from silently drops non-base64 characters, so an unchecked decode
    // would sign bytes the caller never sent.
    expect(res.body.details[0].field).toBe('payload_base64');
    expect(bank.received).toEqual([]);
  });

  it('takes the BTF from the connection’s bank profile when none is given', async () => {
    // The ordinary case. A module knows it produced a pain.001; which scope
    // this particular bank wants is the operator's business, decided once when
    // they picked the profile with the bank's documentation in front of them.
    const res = await request(app)
      .post('/api/orders')
      .set(SERVICE)
      .send({ connection: 'main', payload_base64: pain001('M1') })
      .expect(201);

    expect(res.body.status).toBe('accepted');
    // This connection is on the Austrian profile, so: Scope=AT, and no
    // container — the published tables are explicit that adding a container
    // names a DIFFERENT order type (the several-files variant) than the
    // single pain.001 MOD-04 produces.
    expect(res.body.btf).toEqual({
      service_name: 'SCT',
      scope: 'AT',
      msg_name: 'pain.001',
    });
    expect(bank.received[0]!.btf.scope).toBe('AT');
  });

  it('lets a caller override the profile’s BTF', async () => {
    // A bank that needs something different for one message must stay
    // reachable without editing the registry.
    const res = await request(app)
      .post('/api/orders')
      .set(SERVICE)
      .send({ connection: 'main', btf: { ...BTF, scope: 'BIL' }, payload_base64: pain001('M1') })
      .expect(201);
    expect(res.body.btf.scope).toBe('BIL');
    expect(bank.received[0]!.btf.scope).toBe('BIL');
  });

  it('refuses a BTF that is present but not an object', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set(SERVICE)
      .send({ connection: 'main', btf: 'SCT', payload_base64: pain001('M1') })
      .expect(422);
    expect(res.body.details[0].field).toBe('btf');
  });

  it('returns the order — not an error — when the bank refuses it', async () => {
    bank.configure({ rejectUploadsWith: '091303' });
    const res = await request(app)
      .post('/api/orders')
      .set(SERVICE)
      .send({ connection: 'main', btf: BTF, payload_base64: pain001('M1') })
      .expect(201);

    // A caller has to be able to record WHICH order was refused against its own
    // record; an exception would lose the id it needs to do that.
    expect(res.body.status).toBe('rejected');
    expect(res.body.ebics_code).toBe('091303');
    expect(res.body.public_id).toMatch(/^ord_/);
  });

  it('shows the event stream on the detail route', async () => {
    const created = await request(app)
      .post('/api/orders')
      .set(SERVICE)
      .send({ connection: 'main', btf: BTF, payload_base64: pain001('M1') })
      .expect(201);

    const res = await request(app).get(`/api/orders/${created.body.public_id}`).set(SERVICE).expect(200);
    expect(res.body.events.map((e: { type: string }) => e.type)).toEqual([
      'queued',
      'initialised',
      'segment_sent',
      'transferred',
      'accepted',
    ]);
    await request(app).get('/api/orders/ord_missing').set(SERVICE).expect(404);
  });

  it('filters the list by connection', async () => {
    await bringUp('second', { partner_id: 'P3', user_id: 'U3' });
    await request(app)
      .post('/api/orders')
      .set(SERVICE)
      .send({ connection: 'main', btf: BTF, payload_base64: pain001('M1') })
      .expect(201);
    await request(app)
      .post('/api/orders')
      .set(SERVICE)
      .send({ connection: 'second', btf: BTF, payload_base64: pain001('M2') })
      .expect(201);

    const res = await request(app).get('/api/orders?connection=second').set(SERVICE).expect(200);
    expect(res.body.orders.map((o: { msg_id: string }) => o.msg_id)).toEqual(['M2']);
  });
});

// ── The tick ──────────────────────────────────────────────────────────

describe('POST /api/tick', () => {
  it('is a quiet no-op on a stack with no connections', async () => {
    const res = await request(app).post('/api/tick').set(SERVICE).expect(200);
    expect(res.body).toEqual({ downloads_fetched: 0, orders_updated: 0, problems: [] });
  });

  it('fetches what is waiting and reports what it did', async () => {
    await bringUp();
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, '<camt/>');

    const res = await request(app).post('/api/tick').set(SERVICE).expect(200);
    expect(res.body.downloads_fetched).toBe(1);
    expect(res.body.problems).toEqual([]);

    const list = await request(app).get('/api/downloads').set(SERVICE).expect(200);
    expect(list.body.downloads).toHaveLength(1);
    expect(list.body.downloads[0].kind).toBe('statement');
  });
});

describe('downloads', () => {
  beforeEach(async () => {
    await bringUp();
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, '<camt>hello</camt>');
  });

  it('serves the file itself on its own route, not in the listing', async () => {
    await request(app).post('/api/tick').set(SERVICE).expect(200);
    const list = await request(app).get('/api/downloads').set(SERVICE).expect(200);
    const id = list.body.downloads[0].public_id as string;

    // A listing must never carry megabytes of XML.
    expect(JSON.stringify(list.body)).not.toContain('hello');

    const content = await request(app).get(`/api/downloads/${id}/content`).set(SERVICE).expect(200);
    expect(content.headers['content-type']).toContain('xml');
    expect(content.text).toBe('<camt>hello</camt>');
  });

  it('lets an operator fetch one BTF now', async () => {
    const res = await request(app)
      .post('/api/connections/main/fetch')
      .set('Authorization', `Bearer ${session}`)
      .send({ btf: { service_name: 'EOP', scope: 'AT', msg_name: 'camt.053' } })
      .expect(200);
    expect(res.body.download.kind).toBe('statement');
  });

  it('keeps the fetch route away from a service token', async () => {
    const res = await request(app)
      .post('/api/connections/main/fetch')
      .set(SERVICE)
      .send({ btf: { service_name: 'EOP', msg_name: 'camt.053' } });
    expect(res.status).toBe(403);
  });

  it('404s an unknown download', async () => {
    await request(app).get('/api/downloads/dl_nope').set(SERVICE).expect(404);
  });
});
