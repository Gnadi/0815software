import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import { Transport } from '../server/transport.js';
import { loadKeySecret } from '../server/keystore.js';
import {
  connectionDetail,
  createConnection,
  fetchBankKeys,
  generateKeys,
  sendHia,
  sendIni,
  suspend,
  verifyBankKeys,
  type ExchangeContext,
} from '../server/connections.js';
import {
  foldStatus,
  listOrders,
  orderDetail,
  previewOrder,
  splitSegments,
  submitOrder,
  SEGMENT_LIMIT,
  type OrderContext,
} from '../server/orders.js';
import { inspectPayload, parseDecimalToMinor } from '../server/payload.js';
import { DomainError } from '../server/errors.js';
import { MockBank } from './mock-bank.js';
import type { BtfInput, FieldError } from '../shared/types.js';

/**
 * Uploading a payment file, against a bank that checks what it is sent.
 *
 * The properties this suite exists for, in the order they matter:
 *
 *  1. **A file is submitted at most once** — on the caller's key, and again on
 *     the file's own MsgId for a caller that forgot one.
 *  2. **Nothing is signed before every refusal has had its chance.** At
 *     signature class E the signature *is* the payment, so a ceiling that only
 *     triggered after signing would be no ceiling at all. The assertion for
 *     this is `bank.requests` staying empty.
 *  3. **`rejected` and `failed` stay apart** — a decision versus an unknown.
 */

const KEY_SECRET = loadKeySecret('22'.repeat(32));

const BTF: BtfInput = {
  service_name: 'SCT',
  scope: 'AT',
  msg_name: 'pain.001',
  msg_version: '03',
  container: 'XML',
};

let db: Database.Database;
let bank: MockBank;
let ctx: OrderContext & ExchangeContext;

function fixedClock(): () => string {
  let tick = 0;
  return () => `2026-08-20T10:${String(tick++ % 60).padStart(2, '0')}:00Z`;
}

/**
 * A pain.001 with real numbers in it — enough for `payload.ts` to read, which
 * is what the ceilings are checked against.
 */
function pain001(opts: { msgId: string; total: string; count: number; ccy?: string }): Buffer {
  const ccy = opts.ccy ?? 'EUR';
  const each = (Number.parseInt(parseDecimalToMinor(opts.total)!.toString(), 10) / opts.count / 100).toFixed(2);
  const tx = Array.from(
    { length: opts.count },
    (_unused, i) => `<CdtTrfTxInf><PmtId><EndToEndId>E2E-${i}</EndToEndId></PmtId>` +
      `<Amt><InstdAmt Ccy="${ccy}">${each}</InstdAmt></Amt>` +
      `<Cdtr><Nm>Creditor ${i}</Nm></Cdtr>` +
      `<CdtrAcct><Id><IBAN>AT611904300234573201</IBAN></Id></CdtrAcct></CdtTrfTxInf>`,
  ).join('');
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn>` +
      `<GrpHdr><MsgId>${opts.msgId}</MsgId><CreDtTm>2026-08-20T10:00:00</CreDtTm>` +
      `<NbOfTxs>${opts.count}</NbOfTxs><CtrlSum>${opts.total}</CtrlSum>` +
      `<InitgPty><Nm>Test Debtor</Nm></InitgPty></GrpHdr>` +
      `<PmtInf><PmtInfId>P1</PmtInfId><PmtMtd>TRF</PmtMtd>${tx}</PmtInf>` +
      `</CstmrCdtTrfInitn></Document>`,
    'utf8',
  );
}

/** The field problems behind a 422, which is where the readable message is. */
async function refusal(promise: Promise<unknown>): Promise<FieldError[]> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).status).toBe(422);
    return (err as DomainError).details;
  }
  throw new Error('expected the submission to be refused');
}

async function bringUp(overrides: Record<string, unknown> = {}): Promise<void> {
  createConnection(
    db,
    {
      key: 'main',
      displayName: 'Test Bank',
      bankKey: 'generic',
      url: 'https://bank.example/ebics',
      hostId: bank.hostId,
      partnerId: 'PARTNER1',
      userId: 'USER1',
      ...overrides,
    },
    'admin',
  );
  const key = (overrides.key as string | undefined) ?? 'main';
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
    transport: new Transport({ post: async (_url, body) => bank.post(body) }),
    actor: 'mod-04',
    now: fixedClock(),
  };
});

// ── The happy path ────────────────────────────────────────────────────

describe('submitting a payment file', () => {
  it('gets the file to the bank, signed, and comes back accepted', async () => {
    await bringUp();
    const payload = pain001({ msgId: 'MOD04-20260820-abcdef01', total: '1234.56', count: 2 });

    const { order, replayed } = await submitOrder(ctx, { connection: 'main', btf: BTF, payload });

    expect(replayed).toBe(false);
    expect(order.status).toBe('accepted');
    expect(order.msg_id).toBe('MOD04-20260820-abcdef01');
    expect(order.amount_minor).toBe(123_456);
    expect(order.tx_count).toBe(2);
    expect(order.transaction_id).toBe('MOCKTX-1');

    // The bank's own view: the plaintext it reassembled is byte-identical to
    // what the caller handed over, and the ES signature held over those bytes.
    expect(bank.received).toHaveLength(1);
    expect(bank.received[0]!.orderData.equals(payload)).toBe(true);
    expect(bank.received[0]!.signatureValid).toBe(true);
  });

  it('sends the BTF the caller asked for, which is what routes the file', async () => {
    await bringUp();
    await submitOrder(ctx, {
      connection: 'main',
      btf: BTF,
      payload: pain001({ msgId: 'M1', total: '10.00', count: 1 }),
    });

    expect(bank.received[0]!.btf).toEqual({
      serviceName: 'SCT',
      scope: 'AT',
      option: null,
      msgName: 'pain.001',
      msgVersion: '03',
    });
  });

  it('walks the event stream in order, and folds it to `accepted`', async () => {
    await bringUp();
    const { order } = await submitOrder(ctx, {
      connection: 'main',
      btf: BTF,
      payload: pain001({ msgId: 'M1', total: '10.00', count: 1 }),
    });

    expect(order.events.map((e) => e.type)).toEqual([
      'queued',
      'initialised',
      'segment_sent',
      'transferred',
      'accepted',
    ]);
    expect(order.ebics_code).toBe('000000');
  });

  it('lists orders newest first, and 404s on an unknown id', async () => {
    await bringUp();
    await submitOrder(ctx, { connection: 'main', btf: BTF, payload: pain001({ msgId: 'M1', total: '1.00', count: 1 }) });
    await submitOrder(ctx, { connection: 'main', btf: BTF, payload: pain001({ msgId: 'M2', total: '2.00', count: 1 }) });

    expect(listOrders(db).map((o) => o.msg_id)).toEqual(['M2', 'M1']);
    expect(listOrders(db, { connection: 'main' })).toHaveLength(2);
    expect(() => orderDetail(db, 'ord_nope')).toThrow(DomainError);
  });
});

// ── Submitted at most once ────────────────────────────────────────────

describe('a payment file is submitted at most once', () => {
  it('returns the first order for a repeated idempotency key', async () => {
    await bringUp();
    const input = {
      connection: 'main',
      btf: BTF,
      payload: pain001({ msgId: 'M1', total: '500.00', count: 1 }),
      idempotencyKey: 'payment-run:M1',
    };

    const first = await submitOrder(ctx, input);
    const second = await submitOrder(ctx, input);

    expect(second.replayed).toBe(true);
    expect(second.order.public_id).toBe(first.order.public_id);
    expect(bank.received).toHaveLength(1);
  });

  it('catches the same file under a DIFFERENT key, on its MsgId', async () => {
    await bringUp();
    const payload = pain001({ msgId: 'M1', total: '500.00', count: 1 });

    const first = await submitOrder(ctx, { connection: 'main', btf: BTF, payload, idempotencyKey: 'a' });
    // A caller that retried through a different code path, or invented a
    // second key for the same run. The bank must still see one file.
    const second = await submitOrder(ctx, { connection: 'main', btf: BTF, payload, idempotencyKey: 'b' });

    expect(second.replayed).toBe(true);
    expect(second.order.public_id).toBe(first.order.public_id);
    expect(bank.received).toHaveLength(1);
  });

  it('catches it with no key at all', async () => {
    await bringUp();
    const payload = pain001({ msgId: 'M1', total: '500.00', count: 1 });
    await submitOrder(ctx, { connection: 'main', btf: BTF, payload });
    const again = await submitOrder(ctx, { connection: 'main', btf: BTF, payload });

    expect(again.replayed).toBe(true);
    expect(bank.received).toHaveLength(1);
  });

  it('catches an EDITED file that kept the same MsgId', async () => {
    await bringUp();
    await submitOrder(ctx, {
      connection: 'main',
      btf: BTF,
      payload: pain001({ msgId: 'M1', total: '500.00', count: 1 }),
    });
    // Same MsgId, different money: the dangerous case, because a caller could
    // believe it had corrected a file when the bank will refuse the id.
    const edited = await submitOrder(ctx, {
      connection: 'main',
      btf: BTF,
      payload: pain001({ msgId: 'M1', total: '9000.00', count: 1 }),
    });

    expect(edited.replayed).toBe(true);
    expect(edited.order.amount_minor).toBe(50_000);
    expect(bank.received).toHaveLength(1);
  });

  it('names the fix when the earlier attempt was refused', async () => {
    await bringUp();
    bank.configure({ rejectUploadsWith: '091303' });
    const payload = pain001({ msgId: 'M1', total: '500.00', count: 1 });
    const first = await submitOrder(ctx, { connection: 'main', btf: BTF, payload });
    expect(first.order.status).toBe('rejected');

    // Resubmitting under the same MsgId would be refused by the bank's own
    // duplicate check, so saying so beats a bare 409.
    await expect(submitOrder(ctx, { connection: 'main', btf: BTF, payload })).rejects.toThrow(/new MsgId/);
  });

  it('lets the same MsgId through on a DIFFERENT connection', async () => {
    await bringUp();
    await bringUp({ key: 'second', partnerId: 'PARTNER2', userId: 'USER2' });
    const payload = pain001({ msgId: 'M1', total: '10.00', count: 1 });

    await submitOrder(ctx, { connection: 'main', btf: BTF, payload });
    const other = await submitOrder(ctx, { connection: 'second', btf: BTF, payload });

    // Uniqueness is per connection: two banks are two duplicate checks.
    expect(other.replayed).toBe(false);
    expect(bank.received).toHaveLength(2);
  });

  it('gives an opaque file the hash of its bytes as its identity', () => {
    // An unreadable payload cannot pass the ceilings, so it never reaches a
    // submission — but the identity it WOULD be filed under still has to be
    // stable, because that is the layer that catches a resend.
    const opaque = Buffer.from('not xml at all', 'utf8');
    const facts = inspectPayload(opaque, { ...BTF, msg_name: 'camt.999' });

    expect(facts.inspected).toBe(false);
    expect(facts.msgId).toBe(`sha256:${facts.sha256}`);
    expect(inspectPayload(opaque, { ...BTF, msg_name: 'camt.999' }).msgId).toBe(facts.msgId);
  });
});

// ── Refusals that happen before anything is signed ────────────────────

describe('nothing is signed until every refusal has had its chance', () => {
  it('refuses an order on a connection nobody has verified', async () => {
    createConnection(
      db,
      {
        key: 'raw',
        displayName: 'Unverified',
        bankKey: 'generic',
        url: 'https://bank.example/ebics',
        hostId: bank.hostId,
        partnerId: 'P1',
        userId: 'U1',
      },
      'admin',
    );
    generateKeys(ctx, 'raw');
    await sendIni(ctx, 'raw');
    await sendHia(ctx, 'raw');
    await fetchBankKeys(ctx, 'raw');

    const before = bank.requests.length;
    await expect(
      submitOrder(ctx, { connection: 'raw', btf: BTF, payload: pain001({ msgId: 'M1', total: '1.00', count: 1 }) }),
    ).rejects.toThrow(/nobody has confirmed them/);
    expect(bank.requests).toHaveLength(before);
    expect(listOrders(db)).toEqual([]);
  });

  it('refuses an order on a suspended connection', async () => {
    await bringUp();
    suspend(ctx, 'main', 'card lost');
    await expect(
      submitOrder(ctx, { connection: 'main', btf: BTF, payload: pain001({ msgId: 'M1', total: '1.00', count: 1 }) }),
    ).rejects.toThrow(/suspended/);
    expect(bank.received).toEqual([]);
  });

  it('refuses a file over the amount ceiling, without talking to the bank', async () => {
    await bringUp({ key: 'capped', partnerId: 'P2', userId: 'U2', maxAmountMinor: 100_000, maxTransfers: 50 });
    const before = bank.requests.length;

    await expect(
      submitOrder(ctx, {
        connection: 'capped',
        btf: BTF,
        payload: pain001({ msgId: 'M1', total: '1000.01', count: 1 }),
      }),
    ).rejects.toMatchObject({ status: 422 });

    expect(bank.requests).toHaveLength(before);
    expect(listOrders(db)).toEqual([]);
  });

  it('refuses a file over the transfer-count ceiling', async () => {
    await bringUp({ key: 'capped', partnerId: 'P2', userId: 'U2', maxAmountMinor: 10_000_000, maxTransfers: 3 });
    const problems = await refusal(
      submitOrder(ctx, {
        connection: 'capped',
        btf: BTF,
        payload: pain001({ msgId: 'M1', total: '40.00', count: 4 }),
      }),
    );
    expect(problems[0]!.message).toMatch(/4 transfers/);
    expect(bank.received).toEqual([]);
  });

  it('accepts a file exactly ON the ceiling — the limit is inclusive', async () => {
    await bringUp({ key: 'capped', partnerId: 'P2', userId: 'U2', maxAmountMinor: 100_000, maxTransfers: 2 });
    const { order } = await submitOrder(ctx, {
      connection: 'capped',
      btf: BTF,
      payload: pain001({ msgId: 'M1', total: '1000.00', count: 2 }),
    });
    expect(order.status).toBe('accepted');
  });

  it('refuses a payload it cannot read, rather than signing it blind', async () => {
    await bringUp({ key: 'capped', partnerId: 'P2', userId: 'U2', maxAmountMinor: 100_000, maxTransfers: 5 });
    const problems = await refusal(
      submitOrder(ctx, {
        connection: 'capped',
        btf: BTF,
        payload: Buffer.from('<Document>not what the BTF says</Document>', 'utf8'),
      }),
    );
    expect(problems[0]!.message).toMatch(/could not be read/);
    expect(bank.received).toEqual([]);
  });
});

// ── The dry run ───────────────────────────────────────────────────────

describe('previewing an order', () => {
  it('reports what would be sent and stores nothing', async () => {
    await bringUp();
    const before = bank.requests.length;
    const payload = pain001({ msgId: 'M1', total: '77.77', count: 3 });
    const preview = previewOrder(db, { connection: 'main', btf: BTF, payload });

    expect(preview.msg_id).toBe('M1');
    expect(preview.amount_minor).toBe(7_777);
    expect(preview.tx_count).toBe(3);
    expect(preview.problems).toEqual([]);
    expect(listOrders(db)).toEqual([]);
    expect(bank.requests).toHaveLength(before);
  });

  it('reports the ceiling problems a submission would throw on', async () => {
    await bringUp({ key: 'capped', partnerId: 'P2', userId: 'U2', maxAmountMinor: 1_000, maxTransfers: 1 });
    const preview = previewOrder(db, {
      connection: 'capped',
      btf: BTF,
      payload: pain001({ msgId: 'M1', total: '500.00', count: 2 }),
    });
    expect(preview.problems).toHaveLength(2);
  });
});

// ── Segmentation ──────────────────────────────────────────────────────

describe('segmentation', () => {
  it('leaves a file that fits in one segment alone', () => {
    expect(splitSegments('abcd', 4)).toEqual(['abcd']);
    expect(splitSegments('', 4)).toEqual(['']);
  });

  it('splits on the boundary, keeping every character exactly once', () => {
    const packed = 'x'.repeat(2_500);
    const parts = splitSegments(packed, 1_000);
    expect(parts.map((p) => p.length)).toEqual([1_000, 1_000, 500]);
    expect(parts.join('')).toBe(packed);
  });

  it('defaults to the protocol limit', () => {
    expect(SEGMENT_LIMIT).toBe(1_000_000);
    expect(splitSegments('y'.repeat(SEGMENT_LIMIT))).toHaveLength(1);
    expect(splitSegments('y'.repeat(SEGMENT_LIMIT + 1))).toHaveLength(2);
  });

  it('carries a multi-segment file to the bank intact', async () => {
    await bringUp();
    // A small limit rather than a megabyte of test data — the bank still
    // reassembles, decrypts and checks the digest over the whole file.
    ctx.segmentLimit = 64;
    const payload = pain001({ msgId: 'M1', total: '2000.00', count: 20 });

    const { order } = await submitOrder(ctx, { connection: 'main', btf: BTF, payload });

    expect(order.status).toBe('accepted');
    const sent = order.events.filter((e) => e.type === 'segment_sent');
    expect(sent.length).toBeGreaterThan(1);
    // 1-based, in order, and the last one is marked as such.
    expect(sent.map((e) => e.meta.segment)).toEqual(sent.map((_unused, i) => i + 1));
    expect(sent.at(-1)!.meta.last).toBe(true);
    expect(bank.received[0]!.orderData.equals(payload)).toBe(true);
  });
});

// ── What the bank says, and what it means ─────────────────────────────

describe('the bank’s answer', () => {
  it('records a business rejection as `rejected`, under the code that decided it', async () => {
    await bringUp();
    bank.configure({ rejectUploadsWith: '091303' });

    const { order } = await submitOrder(ctx, {
      connection: 'main',
      btf: BTF,
      payload: pain001({ msgId: 'M1', total: '10.00', count: 1 }),
    });

    expect(order.status).toBe('rejected');
    // Not '000000': a business rejection travels with an OK technical code,
    // and filing it under that would read as success in the order list.
    expect(order.ebics_code).toBe('091303');
    expect(order.message).toMatch(/refused/i);
  });

  it('rejects at initialisation without sending a single segment', async () => {
    await bringUp();
    bank.configure({ rejectInitWith: '091303' });

    const { order } = await submitOrder(ctx, {
      connection: 'main',
      btf: BTF,
      payload: pain001({ msgId: 'M1', total: '10.00', count: 1 }),
    });

    expect(order.status).toBe('rejected');
    expect(order.events.map((e) => e.type)).toEqual(['queued', 'rejected']);
    expect(order.transaction_id).toBeNull();
  });

  it('treats a technical fault that might not recur as `failed`, not `rejected`', async () => {
    await bringUp();
    // 061099 is in the technical range: retryable, and whether the bank has
    // the file is unknown — which is exactly the difference from a rejection.
    bank.configure({ rejectInitWith: undefined });
    ctx.transport = new Transport({
      post: async () => ({
        status: 200,
        body: bank.post(
          '<?xml version="1.0" encoding="UTF-8"?><nope xmlns="urn:org:ebics:H005"/>',
        ).body,
      }),
    });

    const { order } = await submitOrder(ctx, {
      connection: 'main',
      btf: BTF,
      payload: pain001({ msgId: 'M1', total: '10.00', count: 1 }),
    });
    expect(order.status).toBe('failed');
  });

  it('records `failed` when the conversation breaks, because the outcome is unknown', async () => {
    await bringUp();
    ctx.transport = new Transport({
      post: async () => {
        throw new Error('socket hang up');
      },
    });

    const { order } = await submitOrder(ctx, {
      connection: 'main',
      btf: BTF,
      payload: pain001({ msgId: 'M1', total: '10.00', count: 1 }),
    });

    expect(order.status).toBe('failed');
    expect(order.message).toMatch(/socket hang up/);
    // The order still exists: a caller has to be able to find out that this
    // file may or may not be at the bank.
    expect(orderDetail(db, order.public_id).status).toBe('failed');
  });

  it('refuses to act on a response it cannot attribute to the bank', async () => {
    await bringUp();
    const honest = ctx.transport;
    ctx.transport = new Transport({
      post: async (url, body) => {
        const answer = await honest.send(url, body);
        // One byte of the signed document changed: the AuthSignature must no
        // longer verify, and an unverifiable answer is not an answer.
        return { status: 200, body: answer.replace('<e:ReportText>OK<', '<e:ReportText>Ok<') };
      },
    });

    const { order } = await submitOrder(ctx, {
      connection: 'main',
      btf: BTF,
      payload: pain001({ msgId: 'M1', total: '10.00', count: 1 }),
    });

    expect(order.status).toBe('failed');
    expect(order.message).toMatch(/could not be verified/);
  });

  it('fails an initialisation that returns no transaction id', async () => {
    await bringUp();
    bank.configure({ omitTransactionId: true });

    const { order } = await submitOrder(ctx, {
      connection: 'main',
      btf: BTF,
      payload: pain001({ msgId: 'M1', total: '10.00', count: 1 }),
    });

    expect(order.status).toBe('failed');
    expect(order.message).toMatch(/no transaction id/);
  });
});

// ── Folding ───────────────────────────────────────────────────────────

describe('folding an order’s events into a status', () => {
  const ev = (type: string) => ({ type, ebics_code: null, meta: {}, created_at: '2026-08-20T10:00:00Z' });

  it('starts at `queued` and follows the stream', () => {
    expect(foldStatus([])).toBe('queued');
    expect(foldStatus([ev('queued'), ev('initialised')])).toBe('initialised');
    expect(foldStatus([ev('queued'), ev('initialised'), ev('segment_sent'), ev('transferred')])).toBe('transferred');
  });

  it('will not walk an order back out of a decision', () => {
    // A late progress event — a retry that raced, a replayed webhook — must
    // not turn a rejection back into work in progress.
    expect(foldStatus([ev('rejected'), ev('initialised')])).toBe('rejected');
    expect(foldStatus([ev('accepted'), ev('segment_sent')])).toBe('accepted');
    expect(foldStatus([ev('failed'), ev('transferred')])).toBe('failed');
  });

  it('ignores events it does not know', () => {
    expect(foldStatus([ev('queued'), ev('something_new')])).toBe('queued');
  });
});

// ── The key never leaves ──────────────────────────────────────────────

describe('a private key never leaves the service', () => {
  it('keeps key material out of the order record and its events', async () => {
    await bringUp();
    const { order } = await submitOrder(ctx, {
      connection: 'main',
      btf: BTF,
      payload: pain001({ msgId: 'M1', total: '10.00', count: 1 }),
    });

    const serialised = JSON.stringify(orderDetail(db, order.public_id));
    expect(serialised).not.toMatch(/PRIVATE KEY/);
    expect(serialised).not.toMatch(/BEGIN/);
  });

  it('keeps it off the wire, too', async () => {
    await bringUp();
    await submitOrder(ctx, {
      connection: 'main',
      btf: BTF,
      payload: pain001({ msgId: 'M1', total: '10.00', count: 1 }),
    });
    for (const body of bank.requests) expect(body).not.toMatch(/PRIVATE KEY/);
  });
});
