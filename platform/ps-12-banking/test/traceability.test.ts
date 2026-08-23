import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { Transport } from '../server/transport.js';
import { loadKeySecret } from '../server/keystore.js';
import { listExchanges, exchangeDetail, pruneExchanges, sqliteRecorder } from '../server/exchanges.js';
import {
  connectionDetail,
  createConnection,
  fetchBankKeys,
  generateKeys,
  sendHia,
  sendIni,
  type ExchangeContext,
} from '../server/connections.js';
import { orderDetail, submitOrder, type OrderContext } from '../server/orders.js';
import { verifyBankKeys } from '../server/connections.js';
import { MockBank } from './mock-bank.js';
import type { AuthConfig } from '../server/auth.js';
import type { BtfInput } from '../shared/types.js';

/**
 * Can a human reconstruct one transfer, months later, from what we kept?
 *
 * This is the suite for the question a bank asks when something goes wrong,
 * and it is a different question from "does the payment work". A working
 * payment leaves a folded status behind — `accepted` — and that word settles
 * nothing in the conversation that actually happens: *we have no record of
 * that file*, or *your signature did not verify*, about money that has already
 * left. What answers it is the bytes, the moment each step happened, and who
 * caused it.
 *
 * So four properties, each of which was false before this suite existed:
 *
 *  1. **Every step carries its own timestamp.** The whole submission used to
 *     share one, so a twelve-segment upload read as twelve things happening in
 *     the same instant and nobody could say where it stopped.
 *  2. **Every step names an actor.** `connection_events` had one from the
 *     start; `order_events` did not, so the ticker and an operator retrying by
 *     hand were indistinguishable in the record.
 *  3. **Every round-trip is kept whole** — request and response, including the
 *     one that never came back, which is the only case that ever needs it.
 *  4. **Keeping it adds no secret.** An envelope carries signatures and
 *     encrypted data; a private key must never appear in one.
 */

const KEY_SECRET = loadKeySecret('33'.repeat(32));

const BTF: BtfInput = {
  service_name: 'SCT',
  scope: 'AT',
  msg_name: 'pain.001',
  msg_version: '03',
  container: 'XML',
};

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};

let db: Database.Database;
let bank: MockBank;
let ctx: OrderContext & ExchangeContext;

/** A clock that moves a second per reading, so "same instant" is detectable. */
function movingClock(): () => string {
  let tick = 0;
  return () => `2026-08-20T10:00:${String(tick++ % 60).padStart(2, '0')}Z`;
}

function pain001(msgId: string, count = 1): Buffer {
  const tx = Array.from(
    { length: count },
    (_unused, i) =>
      `<CdtTrfTxInf><PmtId><EndToEndId>E2E-${i}</EndToEndId></PmtId>` +
      `<Amt><InstdAmt Ccy="EUR">10.00</InstdAmt></Amt>` +
      `<Cdtr><Nm>Creditor ${i}</Nm></Cdtr></CdtTrfTxInf>`,
  ).join('');
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn>` +
      `<GrpHdr><MsgId>${msgId}</MsgId><CreDtTm>2026-08-20T10:00:00</CreDtTm>` +
      `<NbOfTxs>${count}</NbOfTxs><CtrlSum>${(count * 10).toFixed(2)}</CtrlSum>` +
      `<InitgPty><Nm>Test Debtor</Nm></InitgPty></GrpHdr>` +
      `<PmtInf><PmtInfId>P1</PmtInfId><PmtMtd>TRF</PmtMtd>${tx}</PmtInf>` +
      `</CstmrCdtTrfInitn></Document>`,
    'utf8',
  );
}

async function bringUp(key = 'main'): Promise<void> {
  createConnection(
    db,
    {
      key,
      displayName: 'Test Bank',
      bankKey: 'generic',
      url: 'https://bank.example/ebics',
      hostId: bank.hostId,
      partnerId: 'PARTNER1',
      userId: 'USER1',
    },
    'admin',
  );
  generateKeys(ctx, key);
  await sendIni(ctx, key);
  await sendHia(ctx, key);
  await fetchBankKeys(ctx, key);
  const detail = connectionDetail(db, key);
  verifyBankKeys(ctx, key, {
    authDigest: detail.bank_keys.find((k) => k.purpose === 'AUTH')!.digestFormatted,
    encDigest: detail.bank_keys.find((k) => k.purpose === 'ENC')!.digestFormatted,
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  bank = new MockBank();
  ctx = {
    db,
    keySecret: KEY_SECRET,
    transport: new Transport({
      post: async (_url, body) => bank.post(body),
      record: sqliteRecorder(db),
      now: movingClock(),
    }),
    actor: 'mod-04',
    now: movingClock(),
  };
});

// ── The history of one order ──────────────────────────────────────────

describe('the history of one transfer', () => {
  it('gives every step its own moment, so a duration can be read off it', async () => {
    await bringUp();
    const { order } = await submitOrder(ctx, { connection: 'main', btf: BTF, payload: pain001('TRACE-0001') });

    const events = orderDetail(db, order.public_id).events;
    expect(events.map((e) => e.type)).toEqual([
      'queued',
      'initialised',
      'segment_sent',
      'transferred',
      'accepted',
    ]);

    // The property: distinct moments, in order. Before the fix these were all
    // one string, which is what made "when did the bank stop answering"
    // unanswerable.
    const stamps = events.map((e) => e.created_at);
    expect(new Set(stamps).size).toBe(stamps.length);
    expect([...stamps].sort()).toEqual(stamps);
  });

  it('names who caused each step', async () => {
    await bringUp();
    const { order } = await submitOrder(ctx, { connection: 'main', btf: BTF, payload: pain001('TRACE-0002') });

    const events = orderDetail(db, order.public_id).events;
    expect(events.every((e) => e.actor === 'mod-04')).toBe(true);
  });

  it('keeps the connection lifecycle under the operator who drove it', async () => {
    await bringUp();
    const actors = new Set(connectionDetail(db, 'main').events.map((e) => e.actor));
    // `created` was recorded under `admin`; everything the exchange context
    // drove is `mod-04`. Both are named — neither is null.
    expect(actors.has(null)).toBe(false);
  });
});

// ── The bytes ─────────────────────────────────────────────────────────

describe('the conversation with the bank', () => {
  it('records every round-trip of an upload, tied to the order and named', async () => {
    await bringUp();
    const { order } = await submitOrder(ctx, { connection: 'main', btf: BTF, payload: pain001('TRACE-0003') });

    const mine = listExchanges(db, { order: order.public_id });
    expect(mine.map((e) => e.phase).sort()).toEqual(['order.initialisation', 'order.transfer.segment-1']);
    for (const summary of mine) {
      expect(summary.connection).toBe('main');
      expect(summary.http_status).toBe(200);
      expect(summary.error).toBeNull();
      expect(summary.request_bytes).toBeGreaterThan(0);
      expect(summary.response_bytes).toBeGreaterThan(0);
    }
  });

  it('keeps the bytes, so what was sent can be shown and not just described', async () => {
    await bringUp();
    const { order } = await submitOrder(ctx, { connection: 'main', btf: BTF, payload: pain001('TRACE-0004') });

    const init = listExchanges(db, { order: order.public_id }).find((e) => e.phase === 'order.initialisation')!;
    const detail = exchangeDetail(db, init.id);

    // The request is the envelope as signed: it names the host and carries the
    // authentication signature the bank checked.
    expect(detail.request).toContain('ebicsRequest');
    expect(detail.request).toContain(bank.hostId);
    expect(detail.request).toContain('AuthSignature');
    // The response is the bank's, verbatim, including the transaction id the
    // order row now quotes.
    expect(detail.response).toContain('ebicsResponse');
    expect(detail.response).toContain(orderDetail(db, order.public_id).transaction_id!);
  });

  it('records the key exchange too, not only the payments', async () => {
    await bringUp();
    const phases = listExchanges(db, { connection: 'main' }).map((e) => e.phase);
    expect(phases).toContain('ini');
    expect(phases).toContain('hia');
    expect(phases).toContain('hpb');
  });

  it('keeps the request that never came back — the only one anybody needs', async () => {
    await bringUp();
    // From here the bank is a black hole: the request leaves, nothing returns.
    // Whether it arrived is unknowable, which is exactly why the bytes matter.
    ctx.transport = new Transport({
      post: () => Promise.reject(new Error('connection reset by peer')),
      record: sqliteRecorder(db),
      now: movingClock(),
    });

    const { order } = await submitOrder(ctx, { connection: 'main', btf: BTF, payload: pain001('TRACE-0005') });
    expect(orderDetail(db, order.public_id).status).toBe('failed');

    const mine = listExchanges(db, { order: order.public_id });
    expect(mine).toHaveLength(1);
    expect(mine[0]!.phase).toBe('order.initialisation');
    expect(mine[0]!.error).toBe('connection reset by peer');
    expect(mine[0]!.response_bytes).toBeNull();
    expect(exchangeDetail(db, mine[0]!.id).request).toContain('ebicsRequest');
  });

  it('records a refusal by the egress policy as a conversation that did not happen', async () => {
    const record = sqliteRecorder(db);
    const transport = new Transport({
      post: () => {
        throw new Error('the post should never have been reached');
      },
      egress: { mode: 'block', allowHosts: new Set<string>() },
      record,
      now: movingClock(),
    });
    await expect(transport.send('http://127.0.0.1:4001/ebics', '<x/>', { phase: 'probe' })).rejects.toThrow();

    const [only] = listExchanges(db, {});
    expect(only!.phase).toBe('probe');
    expect(only!.error).toContain('egress');
    expect(only!.http_status).toBeNull();
  });

  it('never lets a bank exchange break the payment it is recording', async () => {
    await bringUp();
    // A recorder that always throws — a full disk, a locked table. The order
    // must still complete: the log is the record of the payment, not a
    // precondition for it.
    ctx.transport = new Transport({
      post: async (_url, body) => bank.post(body),
      record: () => {
        throw new Error('the audit table is gone');
      },
      now: movingClock(),
    });
    const { order } = await submitOrder(ctx, { connection: 'main', btf: BTF, payload: pain001('TRACE-0006') });
    expect(orderDetail(db, order.public_id).status).toBe('accepted');
  });
});

// ── What keeping the bytes must not cost ──────────────────────────────

describe('what an exchange may contain', () => {
  it('carries no private key material, because an envelope never does', async () => {
    await bringUp();
    await submitOrder(ctx, { connection: 'main', btf: BTF, payload: pain001('TRACE-0007') });

    const rows = db.prepare('SELECT request, response FROM bank_exchanges').all() as {
      request: string;
      response: string | null;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const body of [row.request, row.response ?? '']) {
        expect(body).not.toContain('PRIVATE KEY');
        expect(body).not.toContain('BEGIN RSA');
      }
    }
  });

  it('ages the evidence out on the retention window and leaves the record alone', async () => {
    await bringUp();
    const { order } = await submitOrder(ctx, { connection: 'main', btf: BTF, payload: pain001('TRACE-0008') });
    expect(listExchanges(db, {}).length).toBeGreaterThan(0);

    // Two years on, everything recorded today is past a 365-day window.
    const pruned = pruneExchanges(db, 365, () => '2028-08-20T10:00:00Z');
    expect(pruned).toBeGreaterThan(0);
    expect(listExchanges(db, {})).toEqual([]);

    // The history of what happened is not evidence and does not expire.
    expect(orderDetail(db, order.public_id).events.map((e) => e.type)).toContain('accepted');
    expect(orderDetail(db, order.public_id).status).toBe('accepted');
  });

  it('keeps everything when the window is switched off', async () => {
    await bringUp();
    await submitOrder(ctx, { connection: 'main', btf: BTF, payload: pain001('TRACE-0009') });
    const before = listExchanges(db, {}).length;
    expect(pruneExchanges(db, 0, () => '2099-01-01T00:00:00Z')).toBe(0);
    expect(listExchanges(db, {})).toHaveLength(before);
  });
});

// ── The route, and who may walk it ────────────────────────────────────

describe('reading the conversation over HTTP', () => {
  let app: Express;
  let session: string;

  beforeEach(async () => {
    app = createApp({
      db,
      auth,
      keySecret: '33'.repeat(32),
      transport: ctx.transport as Transport,
    });
    const login = await request(app).post('/api/login').send({ username: 'admin', password: 'test-pass' }).expect(200);
    session = login.body.token as string;
  });

  it('shows an operator the round-trips behind an order', async () => {
    await bringUp();
    const { order } = await submitOrder(ctx, { connection: 'main', btf: BTF, payload: pain001('TRACE-0010') });

    const res = await request(app)
      .get(`/api/orders/${order.public_id}/exchanges`)
      .set('Authorization', `Bearer ${session}`)
      .expect(200);
    const phases = (res.body.exchanges as { phase: string }[]).map((e) => e.phase);
    expect(phases).toContain('order.initialisation');

    const id = (res.body.exchanges as { id: number }[])[0]!.id;
    const one = await request(app).get(`/api/exchanges/${id}`).set('Authorization', `Bearer ${session}`).expect(200);
    expect(one.body.request).toContain('ebicsRequest');
  });

  it('refuses a service token — a module may submit a payment, not read the file back', async () => {
    await bringUp();
    const { order } = await submitOrder(ctx, { connection: 'main', btf: BTF, payload: pain001('TRACE-0011') });

    for (const path of [`/api/orders/${order.public_id}/exchanges`, '/api/exchanges', '/api/exchanges/1']) {
      await request(app).get(path).set('X-Service-Token', 'test-service').expect(403);
      await request(app).get(path).expect(401);
    }
  });

  it('404s an unknown order rather than answering with a convincing empty list', async () => {
    await request(app)
      .get('/api/orders/ord_doesnotexist/exchanges')
      .set('Authorization', `Bearer ${session}`)
      .expect(404);
  });
});
