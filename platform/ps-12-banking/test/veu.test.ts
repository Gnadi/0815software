import { beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  verifyBankKeys,
  type ExchangeContext,
} from '../server/connections.js';
import { cancel, detail, overview, sign, transactions, type VeuContext } from '../server/veu.js';
import { sha256 } from '../server/ebics/crypto.js';
import { MockBank } from './mock-bank.js';

/**
 * The distributed-signature queue, end to end against a bank that checks.
 *
 * The property worth proving here is not "HVE returns 200". It is that the
 * signature this service sends over a digest it fetched **verifies against the
 * order's own bytes at the counterparty**. The mock bank runs
 * `verifyOrderData(esPublicKey, order.content, signature)` — the order data it
 * holds, not anything derived from what we sent it — so a co-signature over
 * the wrong preimage fails here rather than at a real bank.
 */

const KEY_SECRET = loadKeySecret('22'.repeat(32));
const SCHEMA_DIR = join(import.meta.dirname, 'schema');
const HAVE_SCHEMAS = existsSync(join(SCHEMA_DIR, 'ebics_orders_H005.xsd'));
const HAVE_XMLLINT = ((): boolean => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let db: Database.Database;
let bank: MockBank;
let ctx: ExchangeContext & VeuContext;

const ORDER_CONTENT = Buffer.from('<?xml version="1.0"?><Document>the collective order</Document>', 'utf8');
const BTF = { service_name: 'SCT', scope: 'AT', msg_name: 'pain.001' };

function fixedClock(): () => string {
  let tick = 0;
  return () => `2026-08-21T09:${String(tick++).padStart(2, '0')}:00Z`;
}

function queueOne(orderId = 'A1B2', overrides: Record<string, unknown> = {}): void {
  bank.veuQueue.push({
    orderId,
    service: { serviceName: 'SCT', scope: 'AT', msgName: 'pain.001' },
    content: ORDER_CONTENT,
    signaturesRequired: 2,
    signaturesDone: 1,
    readyToBeSigned: true,
    originator: { partnerId: 'PARTNER1', userId: 'USER2' },
    signatures: [],
    ...overrides,
  } as never);
}

async function bringUp(): Promise<void> {
  createConnection(
    db,
    {
      key: 'main',
      displayName: 'Test Bank',
      bankKey: 'at-sepa',
      url: 'https://bank.example/ebics',
      hostId: bank.hostId,
      partnerId: 'PARTNER1',
      userId: 'USER1',
    },
    'admin',
  );
  generateKeys(ctx, 'main');
  await sendIni(ctx, 'main');
  await sendHia(ctx, 'main');
  await fetchBankKeys(ctx, 'main');
  const d = connectionDetail(db, 'main');
  verifyBankKeys(ctx, 'main', {
    authDigest: d.bank_keys.find((k) => k.purpose === 'AUTH')!.digestFormatted,
    encDigest: d.bank_keys.find((k) => k.purpose === 'ENC')!.digestFormatted,
  });
}

beforeEach(async () => {
  db = openDb(':memory:');
  bank = new MockBank();
  ctx = {
    db,
    keySecret: KEY_SECRET,
    transport: new Transport({ post: async (_url, body) => bank.post(body) }),
    actor: 'admin',
    now: fixedClock(),
  };
  await bringUp();
});

describe('reading the queue', () => {
  it('answers with an empty list when nothing is waiting', async () => {
    // The ordinary case on most polls. The bank says EBICS_NO_DOWNLOAD_DATA
    // and that is not an error.
    expect(await overview(ctx, 'main')).toEqual([]);
  });

  it('lists what needs a signature, with the counts that decide the UI', async () => {
    queueOne();
    const [order] = await overview(ctx, 'main');
    expect(order!.orderId).toBe('A1B2');
    expect(order!.signing).toEqual({ required: 2, done: 0, readyToBeSigned: true });
    expect(order!.service.serviceName).toBe('SCT');
    expect(order!.service.scope).toBe('AT');
  });

  it('adds the payment summary when asked for HVZ', async () => {
    queueOne();
    const [plain] = await overview(ctx, 'main', { orderType: 'HVU' });
    const [rich] = await overview(ctx, 'main', { orderType: 'HVZ' });
    expect(plain!.summary).toBeNull();
    expect(plain!.dataDigest).toBeNull();
    expect(rich!.summary).toMatchObject({ totalOrders: 3, totalAmount: '2214.80', currency: 'EUR' });
    expect(rich!.dataDigest).toBe(sha256(ORDER_CONTENT).toString('base64'));
  });

  it('gives one order’s digest and display file', async () => {
    queueOne();
    const found = await detail(ctx, 'main', { btf: BTF, orderId: 'A1B2' });
    expect(found.dataDigest).toBe(sha256(ORDER_CONTENT).toString('base64'));
    expect(found.displayFile?.toString('utf8')).toBe('order A1B2');
  });

  it('404s on an order the bank does not have', async () => {
    await expect(detail(ctx, 'main', { btf: BTF, orderId: 'NOPE' })).rejects.toThrow(/no such order/);
  });

  it('reads the payments inside a collective order', async () => {
    queueOne();
    const result = await transactions(ctx, 'main', { btf: BTF, orderId: 'A1B2' });
    const roles = result.transactions[0]!.accounts.map((a) => a.role);
    expect(roles).toEqual(['Originator', 'Recipient']);
    expect(result.transactions[0]!.amount).toBe('421.80');
  });
});

describe('co-signing', () => {
  it('sends a signature the bank verifies against the ORDER’s own bytes', async () => {
    // The assertion this whole file exists for. The mock verifies with
    // `verifyOrderData(publicKey, order.content, signature)` — its own copy of
    // the order data. A signature over the wrong preimage cannot pass.
    queueOne();
    const result = await sign(ctx, 'main', { btf: BTF, orderId: 'A1B2' });

    expect(result.dataDigest).toBe(sha256(ORDER_CONTENT).toString('base64'));
    expect(bank.veuQueue[0]!.signatures).toHaveLength(1);
    expect(bank.veuQueue[0]!.signatures[0]).toMatchObject({ partnerId: 'PARTNER1', userId: 'USER1', valid: true });
  });

  it('fetches the digest itself rather than taking one from the caller', async () => {
    // Signing a caller-supplied digest would make this service an oracle for
    // our own ES key: hand it 32 bytes, get a signature over any document.
    // The API has no field for one, and this pins that.
    queueOne();
    await sign(ctx, 'main', { btf: BTF, orderId: 'A1B2', ...({ dataDigest: 'AAAA' } as object) });
    expect(bank.veuQueue[0]!.signatures[0]!.valid).toBe(true);
  });

  it('counts the signature towards what the order still needs', async () => {
    queueOne('A1B2', { signaturesRequired: 1 });
    await sign(ctx, 'main', { btf: BTF, orderId: 'A1B2' });
    expect(bank.veuQueue[0]!.signaturesDone).toBe(1);
    expect(bank.veuQueue[0]!.readyToBeSigned).toBe(false);
  });

  it('refuses an order that is not in the queue', async () => {
    await expect(sign(ctx, 'main', { btf: BTF, orderId: 'GONE' })).rejects.toThrow(/no such order/);
  });
});

describe('cancelling', () => {
  it('names the digest, so it cannot be aimed at an unseen order', async () => {
    queueOne();
    const result = await cancel(ctx, 'main', { btf: BTF, orderId: 'A1B2' });
    expect(result.dataDigest).toBe(sha256(ORDER_CONTENT).toString('base64'));
    expect(bank.veuQueue[0]!.cancelled).toBe(true);
  });

  it('takes a cancelled order out of the overview', async () => {
    queueOne();
    await cancel(ctx, 'main', { btf: BTF, orderId: 'A1B2' });
    expect(await overview(ctx, 'main')).toEqual([]);
  });
});

const describeIf = HAVE_SCHEMAS && HAVE_XMLLINT ? describe : describe.skip;

describeIf('the counterpart answers in shapes the schema allows', () => {
  // A mock that invented its own dialect would agree with the parser that
  // reads it and with nothing else — which is exactly how the AuthSignature
  // was wrong in both directions for weeks.
  const workdir = mkdtempSync(join(tmpdir(), 'ps12-veu-'));

  it.each(['HVU', 'HVZ', 'HVD', 'HVT'])('%s response order data', (orderType) => {
    bank.veuQueue.push({
      orderId: 'A1B2',
      service: { serviceName: 'SCT', scope: 'AT', msgName: 'pain.001' },
      content: ORDER_CONTENT,
      signaturesRequired: 2,
      signaturesDone: 1,
      readyToBeSigned: true,
      originator: { partnerId: 'PARTNER1', userId: 'USER2' },
      signatures: [{ partnerId: 'PARTNER1', userId: 'USER2', valid: true }],
    } as never);

    const xml = (bank as unknown as { veuDocument(t: string, id: string): string | null }).veuDocument(
      orderType,
      'A1B2',
    );
    expect(xml).not.toBeNull();
    const file = join(workdir, `${orderType}.xml`);
    writeFileSync(file, xml!);
    execFileSync('xmllint', ['--noout', '--schema', join(SCHEMA_DIR, 'ebics_orders_H005.xsd'), file]);
  });
});
