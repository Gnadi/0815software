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
import { orderDetail, submitOrder, type OrderContext } from '../server/orders.js';
import {
  applyReports,
  downloadContent,
  downloadDetail,
  fetchOne,
  listDownloads,
  tick,
  type DownloadContext,
} from '../server/downloads.js';
import { readStatusReports, verdictOfReports } from '../server/reports.js';
import { MockBank } from './mock-bank.js';
import { deflateRawSync } from 'node:zlib';
import type { BtfInput } from '../shared/types.js';

/**
 * Downloads, and the reconciliation they feed.
 *
 * The property this suite exists for is the ordering one, and it is the kind
 * of bug that only shows up as missing data weeks later:
 *
 * **A positive receipt is what tells the bank to stop offering a file.** So it
 * must not be sent until the bytes are committed. A client that acknowledges
 * first and stores second loses a bank statement permanently the one time it
 * crashes in between — there is no second copy anywhere. The mock bank keeps
 * a real queue so that mistake is visible here rather than in production.
 *
 * The others: a bank with nothing to give is not an error, re-offered bytes
 * are absorbed rather than duplicated, and a pain.002 rejection reaches the
 * order it is about — including when it contradicts an earlier acceptance.
 */

const KEY_SECRET = loadKeySecret('66'.repeat(32));

const SCT: BtfInput = { service_name: 'SCT', scope: 'AT', msg_name: 'pain.001', msg_version: '03', container: 'XML' };
// REP with ServiceOption SCT, per the published mapping table — this was
// `PSR`, a service name that does not exist anywhere in it.
const PSR: BtfInput = { service_name: 'REP', scope: 'AT', option: 'SCT', msg_name: 'pain.002', container: 'ZIP' };
const EOP: BtfInput = { service_name: 'EOP', scope: 'AT', msg_name: 'camt.053', msg_version: '04', container: 'ZIP' };

let db: Database.Database;
let bank: MockBank;
let ctx: ExchangeContext & OrderContext & DownloadContext;

function fixedClock(): () => string {
  let tick = 0;
  return () => `2026-08-22T11:${String(tick++ % 60).padStart(2, '0')}:00Z`;
}

function pain001(msgId: string, total = '100.00'): Buffer {
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn>` +
      `<GrpHdr><MsgId>${msgId}</MsgId><NbOfTxs>1</NbOfTxs><CtrlSum>${total}</CtrlSum></GrpHdr>` +
      `<PmtInf><CdtTrfTxInf><Amt><InstdAmt Ccy="EUR">${total}</InstdAmt></Amt></CdtTrfTxInf></PmtInf>` +
      `</CstmrCdtTrfInitn></Document>`,
    'utf8',
  );
}

/** A pain.002 about one original file. */
function pain002(
  originalMsgId: string,
  groupStatus: string,
  opts: { txStatus?: string; reasonCode?: string; reason?: string } = {},
): string {
  const reason =
    opts.reasonCode === undefined && opts.reason === undefined
      ? ''
      : `<StsRsnInf>${opts.reasonCode ? `<Rsn><Cd>${opts.reasonCode}</Cd></Rsn>` : ''}` +
        `${opts.reason ? `<AddtlInf>${opts.reason}</AddtlInf>` : ''}</StsRsnInf>`;
  const tx =
    opts.txStatus === undefined
      ? ''
      : `<OrgnlPmtInfAndSts><OrgnlPmtInfId>P1</OrgnlPmtInfId>` +
        `<TxInfAndSts><OrgnlEndToEndId>E1</OrgnlEndToEndId><TxSts>${opts.txStatus}</TxSts>${reason}</TxInfAndSts>` +
        `</OrgnlPmtInfAndSts>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.002.001.03"><CstmrPmtStsRpt>` +
    `<GrpHdr><MsgId>PSR-1</MsgId></GrpHdr>` +
    `<OrgnlGrpInfAndSts><OrgnlMsgId>${originalMsgId}</OrgnlMsgId><GrpSts>${groupStatus}</GrpSts>` +
    `${opts.txStatus === undefined ? reason : ''}</OrgnlGrpInfAndSts>` +
    tx +
    `</CstmrPmtStsRpt></Document>`
  );
}

/**
 * Wrap documents in a ZIP the way a bank does — which is how camt.053 and
 * pain.002 actually arrive, per the BTF's `Container` element.
 */
function zipped(files: { name: string; content: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const plain = Buffer.from(file.content, 'utf8');
    const body = deflateRawSync(plain);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

async function bringUp(key = 'main'): Promise<void> {
  createConnection(
    db,
    {
      key,
      displayName: 'Test Bank',
      bankKey: 'at-sepa',
      url: 'https://bank.example/ebics',
      hostId: bank.hostId,
      partnerId: `P-${key}`,
      userId: `U-${key}`,
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
    transport: new Transport({ post: async (_url, body) => bank.post(body) }),
    actor: 'admin',
    now: fixedClock(),
  };
});

// ── Fetching ──────────────────────────────────────────────────────────

describe('fetching what the bank has', () => {
  it('answers "nothing waiting" without treating it as a failure', async () => {
    await bringUp();
    const result = await fetchOne(ctx, 'main', EOP);
    // 090005 is the ordinary answer on most polls. A service that raised on it
    // would paint an operator's screen red on a system that is working.
    expect(result.download).toBeNull();
    expect(listDownloads(db)).toEqual([]);
  });

  it('stores a statement whole, and does not try to understand it', async () => {
    await bringUp();
    const statement = '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.04"/>';
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, statement);

    const result = await fetchOne(ctx, 'main', EOP);

    expect(result.download).not.toBeNull();
    expect(result.download!.kind).toBe('statement');
    expect(result.download!.byte_length).toBe(Buffer.byteLength(statement));
    expect(downloadContent(db, result.download!.public_id).toString('utf8')).toBe(statement);
    // Matching bookings to invoices belongs to the module with the invoices.
    expect(downloadDetail(db, result.download!.public_id).reports).toEqual([]);
  });

  it('reassembles a file the bank sends in several segments', async () => {
    await bringUp();
    bank.configure({ downloadSegmentLimit: 40 });
    const statement = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.04">${'x'.repeat(4000)}</Document>`;
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, statement);

    const result = await fetchOne(ctx, 'main', EOP);
    expect(downloadContent(db, result.download!.public_id).toString('utf8')).toBe(statement);
  });

  it('refuses to fetch on a connection nobody verified', async () => {
    createConnection(
      db,
      {
        key: 'raw',
        displayName: 'Unverified',
        bankKey: 'at-sepa',
        url: 'https://bank.example/ebics',
        hostId: bank.hostId,
        partnerId: 'P1',
        userId: 'U1',
      },
      'admin',
    );
    await expect(fetchOne(ctx, 'raw', EOP)).rejects.toThrow(/cannot carry an order|confirmed/);
  });
});

// ── The receipt, and its ordering ─────────────────────────────────────

describe('the positive receipt', () => {
  it('is what takes the file out of the bank’s queue', async () => {
    await bringUp();
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, '<camt/>');
    expect(bank.pending).toBe(1);

    const result = await fetchOne(ctx, 'main', EOP);
    expect(result.download!.acknowledged_at).not.toBeNull();
    expect(bank.pending).toBe(0);

    // And the bank has nothing more to give.
    expect((await fetchOne(ctx, 'main', EOP)).download).toBeNull();
  });

  it('goes out AFTER the bytes are stored, so a crash between the two loses nothing', async () => {
    await bringUp();
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, '<camt>the only copy</camt>');

    // Simulate the process dying immediately after the download is written and
    // before the receipt lands: the receipt request never reaches the bank.
    const honest = ctx.transport;
    ctx.transport = new Transport({
      post: async (url, body) => {
        if (body.includes('TransferReceipt')) throw new Error('process died');
        return { status: 200, body: await honest.send(url, body) };
      },
    });

    const result = await fetchOne(ctx, 'main', EOP);

    // The file is safe on our side...
    expect(downloadContent(db, result.download!.public_id).toString('utf8')).toBe('<camt>the only copy</camt>');
    expect(result.download!.acknowledged_at).toBeNull();
    // ...and still offered by the bank, because it never heard otherwise.
    // That is the safe direction: a duplicate, not a lost statement.
    expect(bank.pending).toBe(1);
  });

  it('absorbs the re-offered file instead of storing it twice', async () => {
    await bringUp();
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, '<camt>same bytes</camt>');
    const honest = ctx.transport;
    ctx.transport = new Transport({
      post: async (url, body) => {
        if (body.includes('TransferReceipt')) throw new Error('process died');
        return { status: 200, body: await honest.send(url, body) };
      },
    });
    const first = await fetchOne(ctx, 'main', EOP);

    // The next poll is offered the same file again — correct of the bank.
    ctx.transport = honest;
    const second = await fetchOne(ctx, 'main', EOP);

    expect(second.duplicate).toBe(true);
    expect(second.download!.public_id).toBe(first.download!.public_id);
    expect(listDownloads(db)).toHaveLength(1);
    // And this time the receipt landed, so the bank is done with it.
    expect(bank.pending).toBe(0);
  });
});

// ── Reading a pain.002 ────────────────────────────────────────────────

describe('reading a payment status report', () => {
  it('finds the ORIGINAL file’s MsgId, not the report’s own', () => {
    const reports = readStatusReports(Buffer.from(pain002('MOD04-20260822-AAAA', 'ACCP'), 'utf8'));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.msgId).toBe('MOD04-20260822-AAAA');
    expect(reports[0]!.statusCode).toBe('ACCP');
  });

  it('collects group, payment-info and transaction statuses', () => {
    const reports = readStatusReports(
      Buffer.from(pain002('M1', 'PART', { txStatus: 'RJCT', reasonCode: 'AC04', reason: 'account closed' }), 'utf8'),
    );
    expect(reports.map((r) => r.statusCode)).toEqual(['PART', 'RJCT']);
    expect(reports[1]!.reasonCode).toBe('AC04');
    expect(reports[1]!.reason).toBe('account closed');
  });

  it('returns nothing for a file it cannot read, rather than throwing', () => {
    // The bytes are already stored and the bank is the authority on their
    // validity; refusing them here would lose the only copy we are offered.
    expect(readStatusReports(Buffer.from('not xml', 'utf8'))).toEqual([]);
    expect(readStatusReports(Buffer.from('<Document xmlns="urn:something:else"/>', 'utf8'))).toEqual([]);
  });

  it('lets ANY rejection decide the verdict', () => {
    const r = (statusCode: string) => ({ msgId: 'M1', statusCode, reasonCode: null, reason: null });
    // Three transfers through and one bounced is not "accepted" to the person
    // who has to go and pay that fourth supplier.
    expect(verdictOfReports([r('ACSC'), r('ACSC'), r('RJCT')])).toBe('rejected');
    expect(verdictOfReports([r('ACSC')])).toBe('settled');
    expect(verdictOfReports([r('ACCP')])).toBe('accepted');
    expect(verdictOfReports([r('PDNG')])).toBe('pending');
    expect(verdictOfReports([])).toBe('unknown');
    expect(verdictOfReports([r('WEIRD')])).toBe('unknown');
  });
});

// ── Reconciliation ────────────────────────────────────────────────────

describe('folding a report back into its order', () => {
  async function submitted(msgId: string): Promise<string> {
    const { order } = await submitOrder(ctx, { connection: 'main', btf: SCT, payload: pain001(msgId) });
    expect(order.status).toBe('accepted');
    return order.public_id;
  }

  it('settles an order the bank reports as ACSC', async () => {
    await bringUp();
    const id = await submitted('MOD04-1');
    bank.enqueue({ serviceName: 'REP', msgName: 'pain.002' }, pain002('MOD04-1', 'ACSC'));

    await fetchOne(ctx, 'main', PSR);
    expect(applyReports(db, ctx.now!)).toBe(1);

    const order = orderDetail(db, id);
    expect(order.status).toBe('settled');
    expect(order.events.at(-1)!.type).toBe('settled');
  });

  it('rejects an order the bank later refuses, overriding the acceptance', async () => {
    await bringUp();
    const id = await submitted('MOD04-2');
    expect(orderDetail(db, id).status).toBe('accepted');

    bank.enqueue(
      { serviceName: 'REP', msgName: 'pain.002' },
      pain002('MOD04-2', 'RJCT', { reasonCode: 'AC04', reason: 'creditor account closed' }),
    );
    await fetchOne(ctx, 'main', PSR);
    applyReports(db, ctx.now!);

    // The bank taking a FILE is not the bank having PAID it, so a later word
    // has to be able to overtake the earlier one.
    const order = orderDetail(db, id);
    expect(order.status).toBe('rejected');
    expect(order.ebics_code).toBe('AC04');
    expect(order.message).toBe('creditor account closed');
  });

  it('ignores a report about a file this service never sent', async () => {
    await bringUp();
    await submitted('MOD04-3');
    bank.enqueue({ serviceName: 'REP', msgName: 'pain.002' }, pain002('SOMEONE-ELSE', 'RJCT'));

    await fetchOne(ctx, 'main', PSR);
    expect(applyReports(db, ctx.now!)).toBe(0);
    // Kept on the download, not invented onto an order.
    expect(listDownloads(db, { kind: 'status' })).toHaveLength(1);
  });

  it('does not repeat itself when the same download is processed again', async () => {
    await bringUp();
    const id = await submitted('MOD04-4');
    bank.enqueue({ serviceName: 'REP', msgName: 'pain.002' }, pain002('MOD04-4', 'RJCT'));
    await fetchOne(ctx, 'main', PSR);
    applyReports(db, ctx.now!);
    const before = orderDetail(db, id).events.length;

    db.prepare('UPDATE downloads SET processed_at = NULL').run();
    expect(applyReports(db, ctx.now!)).toBe(0);
    expect(orderDetail(db, id).events).toHaveLength(before);
  });

  it('marks a status download processed even when it changes nothing', async () => {
    await bringUp();
    bank.enqueue({ serviceName: 'REP', msgName: 'pain.002' }, pain002('UNKNOWN', 'ACCP'));
    await fetchOne(ctx, 'main', PSR);
    applyReports(db, ctx.now!);
    expect(listDownloads(db, { kind: 'status' })[0]!.processed_at).not.toBeNull();
  });
});

// ── The tick ──────────────────────────────────────────────────────────

describe('a report inside a ZIP container — how banks actually send them', () => {
  async function submitted(msgId: string): Promise<string> {
    const { order } = await submitOrder(ctx, { connection: 'main', btf: SCT, payload: pain001(msgId) });
    return order.public_id;
  }

  it('opens the archive and settles the order inside it', async () => {
    await bringUp();
    const id = await submitted('MOD04-Z1');
    // The profiles all say `container: 'ZIP'`, and until the reader existed
    // this stored the archive, parsed zero reports, stamped it processed and
    // left the run sitting at `submitted` forever.
    bank.enqueue(
      { serviceName: 'REP', msgName: 'pain.002' },
      zipped([{ name: 'psr-20260822-1.xml', content: pain002('MOD04-Z1', 'ACSC') }]),
    );

    await fetchOne(ctx, 'main', PSR);
    expect(applyReports(db, ctx.now!)).toBe(1);
    expect(orderDetail(db, id).status).toBe('settled');
  });

  it('reads every document in a multi-file archive', async () => {
    await bringUp();
    const first = await submitted('MOD04-Z2');
    const second = await submitted('MOD04-Z3');
    bank.enqueue(
      { serviceName: 'REP', msgName: 'pain.002' },
      zipped([
        { name: 'a.xml', content: pain002('MOD04-Z2', 'ACSC') },
        { name: 'b.xml', content: pain002('MOD04-Z3', 'RJCT', { reasonCode: 'AC01' }) },
      ]),
    );

    await fetchOne(ctx, 'main', PSR);
    expect(applyReports(db, ctx.now!)).toBe(2);
    expect(orderDetail(db, first).status).toBe('settled');
    expect(orderDetail(db, second).status).toBe('rejected');
  });

  it('stores the archive as the bank sent it, not the documents inside', async () => {
    await bringUp();
    const archive = zipped([{ name: 'a.xml', content: pain002('MOD04-Z4', 'ACSC') }]);
    bank.enqueue({ serviceName: 'REP', msgName: 'pain.002' }, archive);

    const result = await fetchOne(ctx, 'main', PSR);
    // The file of record is what arrived. Keeping the archive is what makes a
    // parser bug a re-run rather than an unrecoverable loss.
    expect(downloadContent(db, result.download!.public_id).equals(archive)).toBe(true);
  });

  it('keeps an unreadable archive rather than abandoning the fetch', async () => {
    await bringUp();
    // Truncated: the reader refuses it. The bytes still have to be stored,
    // because the receipt has not gone out and this is the only copy offered.
    bank.enqueue({ serviceName: 'REP', msgName: 'pain.002' }, Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(40)]));

    const result = await fetchOne(ctx, 'main', PSR);
    expect(result.download).not.toBeNull();
    expect(downloadDetail(db, result.download!.public_id).reports).toEqual([]);
  });
});

describe('the tick', () => {
  it('fetches for every ready connection and applies what it finds', async () => {
    await bringUp();
    const { order } = await submitOrder(ctx, { connection: 'main', btf: SCT, payload: pain001('MOD04-9') });
    bank.enqueue({ serviceName: 'REP', msgName: 'pain.002' }, pain002('MOD04-9', 'ACSC'));
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, '<camt/>');

    const result = await tick(ctx);

    expect(result.downloads_fetched).toBe(2);
    expect(result.orders_updated).toBe(1);
    expect(result.problems).toEqual([]);
    expect(orderDetail(db, order.public_id).status).toBe('settled');
  });

  it('skips a connection that is not ready', async () => {
    await bringUp();
    suspend(ctx, 'main', 'card lost');
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, '<camt/>');

    const result = await tick(ctx);
    expect(result.downloads_fetched).toBe(0);
    expect(result.problems).toEqual([]);
    expect(bank.pending).toBe(1);
  });

  it('reports one unreachable bank instead of failing the whole pass', async () => {
    await bringUp('first');
    await bringUp('second');
    let calls = 0;
    const honest = ctx.transport;
    ctx.transport = new Transport({
      post: async (url, body) => {
        // Fail only the download requests of the first connection.
        if (body.includes('BTD') && body.includes('P-first')) {
          calls += 1;
          throw new Error('connect ETIMEDOUT');
        }
        return { status: 200, body: await honest.send(url, body) };
      },
    });
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, '<camt/>');

    const result = await tick(ctx);

    expect(calls).toBeGreaterThan(0);
    expect(result.problems.map((p) => p.connection)).toEqual(['first', 'first']);
    // The second connection was still polled — one bank being down must not
    // stop the others.
    expect(result.downloads_fetched).toBe(1);
  });

  it('is a no-op on a stack with no connections at all', async () => {
    expect(await tick(ctx)).toEqual({ downloads_fetched: 0, orders_updated: 0, statements_read: 0, problems: [] });
  });
});

describe('a report that names no original file', () => {
  it('is kept but attached to nothing', async () => {
    await bringUp();
    await submitOrder(ctx, { connection: 'main', btf: SCT, payload: pain001('MOD04-X') });
    // No OrgnlMsgId at all. There used to be a fallback to the REPORT's own
    // GrpHdr/MsgId — the bank's id for the report, which has nothing to do
    // with any order and on a collision would have applied a stranger's
    // verdict to a real payment.
    bank.enqueue(
      { serviceName: 'REP', msgName: 'pain.002' },
      '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.002.001.03">' +
        '<CstmrPmtStsRpt><GrpHdr><MsgId>MOD04-X</MsgId></GrpHdr>' +
        '<OrgnlGrpInfAndSts><GrpSts>RJCT</GrpSts></OrgnlGrpInfAndSts></CstmrPmtStsRpt></Document>',
    );

    await fetchOne(ctx, 'main', PSR);
    expect(applyReports(db, ctx.now!)).toBe(0);
    // Stored, readable by a human, attached to nothing.
    const stored = listDownloads(db, { kind: 'status' })[0]!;
    expect(downloadDetail(db, stored.public_id).reports[0]).toMatchObject({ msg_id: null, status_code: 'RJCT' });
  });
});

// ── CIM: a notice meant for a person ──────────────────────────────────

describe('customer information messages', () => {
  const CIM: BtfInput = { service_name: 'CIM', scope: 'AT', msg_name: 'cimresp' };
  const NOTICE = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="http://www.psa.at/EBICS/CIMResp">
  <GrpHdr>
    <MsgId>2026082114300012ABCD</MsgId>
    <CreDtTm>2026-08-21T14:30:00</CreDtTm>
  </GrpHdr>
  <CIM>
    <CIMTmStmp>2026-08-20T18:00:00</CIMTmStmp>
    <CIMId>f81d4fae-7dec-11d0-a765-00a0c91e6bf6</CIMId>
    <HdLine>Serviceintervall</HdLine>
    <CIMTxt>Am 24.08.2026 steht EBICS zwischen 02:00 und 04:00 nicht zur Verfügung.</CIMTxt>
  </CIM>
</Document>`;

  it('files a CIM as "info" rather than as an opaque blob', async () => {
    await bringUp();
    bank.enqueue({ serviceName: 'CIM', msgName: 'cimresp' }, NOTICE);

    const result = await fetchOne(ctx, 'main', CIM);
    expect(result.download!.kind).toBe('info');
  });

  it('shows the notice on the detail route, read out of the stored bytes', async () => {
    await bringUp();
    bank.enqueue({ serviceName: 'CIM', msgName: 'cimresp' }, NOTICE);
    const result = await fetchOne(ctx, 'main', CIM);

    const detail = downloadDetail(db, result.download!.public_id);
    expect(detail.customer_info!.message_id).toBe('2026082114300012ABCD');
    expect(detail.customer_info!.notices).toHaveLength(1);
    expect(detail.customer_info!.notices[0]!.id).toBe('f81d4fae-7dec-11d0-a765-00a0c91e6bf6');
    expect(detail.customer_info!.notices[0]!.headline).toBe('Serviceintervall');
    expect(detail.customer_info!.notices[0]!.text).toMatch(/24.08.2026/);
  });

  it('keeps the bytes whole, whatever the reader made of them', async () => {
    // The reader has already been rewritten once, against a schema that
    // arrived after it. The stored document must not move when that happens,
    // or every notice fetched beforehand becomes unreadable at exactly the
    // moment the parser gets better.
    await bringUp();
    bank.enqueue({ serviceName: 'CIM', msgName: 'cimresp' }, NOTICE);
    const result = await fetchOne(ctx, 'main', CIM);

    expect(downloadContent(db, result.download!.public_id).toString('utf8')).toBe(NOTICE);
  });

  it('says so plainly when a CIM cannot be read, rather than inventing one', async () => {
    await bringUp();
    bank.enqueue({ serviceName: 'CIM', msgName: 'cimresp' }, '<Document xmlns="urn:x"><Nonsense/></Document>');
    const result = await fetchOne(ctx, 'main', CIM);
    expect(downloadDetail(db, result.download!.public_id).customer_info).toBeNull();
  });

  it('leaves other downloads with no customer_info at all', async () => {
    await bringUp();
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, zipped([{ name: 'statement.xml', content: '<Document/>' }]));
    const result = await fetchOne(ctx, 'main', EOP);
    expect(downloadDetail(db, result.download!.public_id).customer_info).toBeUndefined();
  });
});
