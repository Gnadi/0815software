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
  verifyBankKeys,
  type ExchangeContext,
} from '../server/connections.js';
import { applyCustomerProtocol, downloadDetail, fetchOne, type DownloadContext } from '../server/downloads.js';
import { orderDetail, submitOrder } from '../server/orders.js';
import { MockBank } from './mock-bank.js';

/** A minimal but real pain.001, so submitOrder's own checks are exercised. */
function pain001(msgId: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn>` +
    `<GrpHdr><MsgId>${msgId}</MsgId><NbOfTxs>1</NbOfTxs><CtrlSum>100.00</CtrlSum></GrpHdr>` +
    `<PmtInf><CdtTrfTxInf><Amt><InstdAmt Ccy="EUR">100.00</InstdAmt></Amt></CdtTrfTxInf></PmtInf>` +
    `</CstmrCdtTrfInitn></Document>`
  );
}
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  entriesForOrder,
  isCustomerAcknowledgement,
  readCustomerAcknowledgement,
  verdictOfEntries,
} from '../server/hac.js';
import { readStatusReports } from '../server/reports.js';

/**
 * `HAC` — the customer acknowledgement.
 *
 * The fixtures are the **EBICS Working Group's own four worked examples**,
 * unedited, and the first test validates them against the annotated schema
 * published beside them. Everything else measures the reader against documents
 * somebody outside this repository wrote — which is the whole reason `HAC` was
 * not implemented until they arrived.
 */

const SCHEMA = join(import.meta.dirname, 'schema', 'pain.002.001.03-hac.xsd');
const FIXTURES = join(import.meta.dirname, 'fixtures', 'hac');
const NAMES = [
  'example-1-upload-bad-then-good-signature',
  'example-2-eds-scope-and-display-file',
  'example-3a-eds-two-partners-kunde1',
  'example-3b-eds-two-partners-kunde2',
];

const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, `${name}.xml`));

const HAVE_SCHEMA = existsSync(SCHEMA);
const HAVE_XMLLINT = ((): boolean => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const describeIf = HAVE_SCHEMA && HAVE_XMLLINT ? describe : describe.skip;

describeIf('the fixtures are what a conforming bank may send', () => {
  it.each(NAMES)('%s', (name) => {
    execFileSync('xmllint', ['--noout', '--schema', SCHEMA, join(FIXTURES, `${name}.xml`)]);
  });
});

describe('telling a HAC apart from a payment status report', () => {
  it('recognises every published example', () => {
    for (const name of NAMES) expect(isCustomerAcknowledgement(fixture(name))).toBe(true);
  });

  it('does not mistake a real payment status report for one', () => {
    const report = Buffer.from(
      `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.002.001.03">` +
        `<CstmrPmtStsRpt><GrpHdr><MsgId>BANK-1</MsgId></GrpHdr>` +
        `<OrgnlGrpInfAndSts><OrgnlMsgId>RUN-2026-01</OrgnlMsgId><GrpSts>ACSC</GrpSts></OrgnlGrpInfAndSts>` +
        `</CstmrPmtStsRpt></Document>`,
      'utf8',
    );
    expect(isCustomerAcknowledgement(report)).toBe(false);
    expect(readCustomerAcknowledgement(report)).toBeNull();
    // And the other way round: it IS a status report, and reads as one.
    expect(readStatusReports(report)[0]?.msgId).toBe('RUN-2026-01');
  });

  it('is not fooled by a camt.053 or by bytes that are not XML at all', () => {
    expect(isCustomerAcknowledgement(Buffer.from('<Document xmlns="urn:x"/>', 'utf8'))).toBe(false);
    expect(isCustomerAcknowledgement(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
  });

  /**
   * The reason `downloads.ts` checks for a HAC before it reads status reports.
   *
   * Today this returns nothing, because the HAC profile omits the three status
   * elements `reports.ts` reads. That is luck, not safety: the msgId it would
   * carry is the literal string "EBICS", so a bank that added a GrpSts would
   * be attaching a verdict to whatever order happened to be filed under that
   * name.
   */
  it('yields no payment verdicts when read as a status report', () => {
    for (const name of NAMES) expect(readStatusReports(fixture(name))).toEqual([]);
  });
});

describe('reading the log', () => {
  it('reads the header the bank wrote', () => {
    const log = readCustomerAcknowledgement(fixture('example-1-upload-bad-then-good-signature'))!;
    expect(log.messageId).toBe('3491725');
    expect(log.createdAt).toBe('2018-05-17T13:43:30.997Z');
    // The schema's annotation says only Id/OrgId/Othr/Id is used here, and
    // that it holds the HostID.
    expect(log.hostId).toBe('BANKFRPPXXX');
  });

  it('reads every logged action in order', () => {
    const log = readCustomerAcknowledgement(fixture('example-1-upload-bad-then-good-signature'))!;
    expect(log.entries.map((e) => e.action)).toEqual([
      'FILE_UPLOAD',
      'ES_VERIFICATION',
      'ORDER_HAC_FINAL',
      'FILE_DOWNLOAD',
      'FILE_UPLOAD',
      'ES_VERIFICATION',
      'ORDER_HAC_FINAL',
    ]);
  });

  it('reads the name/value pairs by name, not by position', () => {
    const log = readCustomerAcknowledgement(fixture('example-1-upload-bad-then-good-signature'))!;
    const upload = log.entries[0]!;
    expect(upload).toMatchObject({
      customerName: 'Company Miller',
      userId: 'USER1234',
      partnerId: 'CUSTO456',
      orderId: 'A445',
      adminOrderType: 'BTU',
      serviceName: 'SCT',
      msgName: 'pain.001',
      timestamp: '2018-05-17T14:00:00.000Z',
      reasonCode: 'TS01',
    });
  });

  /**
   * The EBICS Working Group's own example file spells the key `OrderID`
   * twenty-one times and `OrderId` twice, in the same document. A
   * case-sensitive reader loses the order number on exactly those two entries
   * — in the file published to demonstrate the format.
   */
  it('matches key names case-insensitively, because the published example is not consistent', () => {
    const raw = fixture('example-1-upload-bad-then-good-signature').toString('utf8');
    expect(raw).toContain('<Prtry>OrderId</Prtry>');
    expect(raw).toContain('<Prtry>OrderID</Prtry>');

    const log = readCustomerAcknowledgement(fixture('example-1-upload-bad-then-good-signature'))!;
    // The fifth entry is the one spelled `OrderId`.
    expect(log.entries[4]!.orderId).toBe('A446');
    expect(log.entries.every((e) => e.action === 'FILE_DOWNLOAD' || e.orderId !== null)).toBe(true);
  });

  it('reads the failure the bank recorded, not just the successes', () => {
    const log = readCustomerAcknowledgement(fixture('example-1-upload-bad-then-good-signature'))!;
    const refused = log.entries[1]!;
    expect(refused.action).toBe('ES_VERIFICATION');
    expect(refused.userId).toBe('USER1235');
    // DS11: the certificate used for the signature is revoked.
    expect(refused.reasonCode).toBe('DS11');
  });

  it('reads the scope and the service option where a bank sends them', () => {
    const log = readCustomerAcknowledgement(fixture('example-2-eds-scope-and-display-file'))!;
    const direct = log.entries[0]!;
    expect(direct.serviceName).toBe('SDD');
    expect(direct.serviceOption).toBe('COR');
    expect(direct.msgName).toBe('pain.008');
    const download = log.entries.find((e) => e.msgName === 'mt940')!;
    expect(download.scope).toBe('DE');
  });

  it('reads the order a co-signature refers to, not just its own', () => {
    const log = readCustomerAcknowledgement(fixture('example-2-eds-scope-and-display-file'))!;
    const cosign = log.entries.find((e) => e.action === 'ES_UPLOAD')!;
    // A HVE has its OWN order number and refers to the payment it signs.
    // Without the Ref keys it looks like an unrelated order.
    expect(cosign.orderId).toBe('A446');
    expect(cosign.adminOrderType).toBe('HVE');
    expect(cosign.references.orderId).toBe('A445');
    expect(cosign.references.adminOrderType).toBe('BTU');
    expect(cosign.references.msgName).toBe('pain.008');
  });

  it('reads the display file the bank puts on the final entry', () => {
    const log = readCustomerAcknowledgement(fixture('example-2-eds-scope-and-display-file'))!;
    const final = log.entries.find((e) => e.action === 'ORDER_HAC_FINAL')!;
    expect(final.additionalInfo).toBe('L A S T S C H R I F T E N');
    // A marker, not a result: it carries no reason code of its own.
    expect(final.reasonCode).toBeNull();
  });
});

describe('what the log says happened to one order', () => {
  it('gathers the entries about an order, including where it is only referenced', () => {
    const log = readCustomerAcknowledgement(fixture('example-2-eds-scope-and-display-file'))!;
    const actions = entriesForOrder(log, 'A445').map((e) => e.action);
    expect(actions).toContain('FILE_UPLOAD');
    // The co-signature names A446 and REFERS to A445 — it belongs to A445's story.
    expect(actions).toContain('ES_UPLOAD');
    expect(actions).toContain('ORDER_HAC_FINAL');
  });

  it('calls an order processed once the bank has closed it', () => {
    const log = readCustomerAcknowledgement(fixture('example-2-eds-scope-and-display-file'))!;
    expect(verdictOfEntries(entriesForOrder(log, 'A445'))).toBe('processed');
  });

  it('calls an order failed when any step failed, even beside successes', () => {
    const log = readCustomerAcknowledgement(fixture('example-1-upload-bad-then-good-signature'))!;
    // A445: uploaded fine (TS01), signature refused (DS11), then closed.
    expect(verdictOfEntries(entriesForOrder(log, 'A445'))).toBe('failed');
    // A446: uploaded and signed, then closed.
    expect(verdictOfEntries(entriesForOrder(log, 'A446'))).toBe('processed');
  });

  it('calls an order in progress while the bank has not closed it', () => {
    const log = readCustomerAcknowledgement(fixture('example-3a-eds-two-partners-kunde1'))!;
    const open = log.entries.filter((e) => e.orderId !== null && e.action !== 'ORDER_HAC_FINAL');
    expect(verdictOfEntries(open.slice(0, 1))).toBe('in_progress');
    expect(verdictOfEntries([])).toBe('in_progress');
  });

  it('reads a log that covers several subscribers of one customer', () => {
    const log = readCustomerAcknowledgement(fixture('example-3a-eds-two-partners-kunde1'))!;
    const users = new Set(log.entries.map((e) => e.userId));
    expect(users.size).toBeGreaterThan(1);
  });
});

// ── Through the download path ─────────────────────────────────────────

describe('a HAC that arrives as a download', () => {
  let db: Database.Database;
  let bank: MockBank;
  let ctx: DownloadContext & ExchangeContext;

  const hacFor = (orderId: string, failing: boolean): string =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.002.001.03"><CstmrPmtStsRpt>` +
    `<GrpHdr><MsgId>PROT-1</MsgId><CreDtTm>2026-08-22T09:00:00.000Z</CreDtTm>` +
    `<InitgPty><Id><OrgId><Othr><Id>MOCKHOST</Id></Othr></OrgId></Id></InitgPty></GrpHdr>` +
    `<OrgnlGrpInfAndSts><OrgnlMsgId>EBICS</OrgnlMsgId><OrgnlMsgNmId>EBICS</OrgnlMsgNmId></OrgnlGrpInfAndSts>` +
    entry('FILE_UPLOAD', orderId, 'TS01') +
    entry('ES_VERIFICATION', orderId, failing ? 'DS11' : 'DS01') +
    entry('ORDER_HAC_FINAL', orderId, null) +
    `</CstmrPmtStsRpt></Document>`;

  const entry = (action: string, orderId: string, code: string | null): string =>
    `<OrgnlPmtInfAndSts><OrgnlPmtInfId>${action}</OrgnlPmtInfId><StsRsnInf><Orgtr><Nm>Test</Nm><Id><OrgId>` +
    `<Othr><Id>USER1</Id><SchmeNm><Prtry>UserID</Prtry></SchmeNm></Othr>` +
    `<Othr><Id>PARTNER1</Id><SchmeNm><Prtry>PartnerID</Prtry></SchmeNm></Othr>` +
    `<Othr><Id>${orderId}</Id><SchmeNm><Prtry>OrderID</Prtry></SchmeNm></Othr>` +
    `<Othr><Id>BTU</Id><SchmeNm><Prtry>AdminOrderType</Prtry></SchmeNm></Othr>` +
    `<Othr><Id>SCT</Id><SchmeNm><Prtry>ServiceName</Prtry></SchmeNm></Othr>` +
    `<Othr><Id>pain.001</Id><SchmeNm><Prtry>MsgName</Prtry></SchmeNm></Othr>` +
    `<Othr><Id>2026-08-22T09:00:00.000Z</Id><SchmeNm><Prtry>TimeStamp</Prtry></SchmeNm></Othr>` +
    `</OrgId></Id></Orgtr>${code === null ? '' : `<Rsn><Cd>${code}</Cd></Rsn>`}</StsRsnInf></OrgnlPmtInfAndSts>`;

  const HAC_BTF = { service_name: 'HAC', scope: 'DE', msg_name: 'pain.002', container: 'ZIP' };

  beforeEach(async () => {
    db = openDb(':memory:');
    bank = new MockBank();
    let clock = 0;
    ctx = {
      db,
      keySecret: loadKeySecret('33'.repeat(32)),
      transport: new Transport({ post: async (_url, body) => bank.post(body) }),
      actor: 'admin',
      now: () => `2026-08-22T09:${String(clock++).padStart(2, '0')}:00Z`,
    };
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
      },
      'admin',
    );
    generateKeys(ctx, 'main');
    await sendIni(ctx, 'main');
    await sendHia(ctx, 'main');
    await fetchBankKeys(ctx, 'main');
    const detail = connectionDetail(db, 'main');
    verifyBankKeys(ctx, 'main', {
      authDigest: detail.bank_keys.find((k) => k.purpose === 'AUTH')!.digestFormatted,
      encDigest: detail.bank_keys.find((k) => k.purpose === 'ENC')!.digestFormatted,
    });
  });

  /**
   * The reason `kindOf` looks at the bytes and not only at the BTF.
   *
   * Both a HAC and a payment status report are `pain.002`. Classifying on the
   * message name alone would file the bank's activity log as a set of payment
   * verdicts and hand it to the code that settles and rejects orders.
   */
  it('is filed as a protocol, not as a payment status report', async () => {
    bank.enqueue({ serviceName: 'HAC', msgName: 'pain.002' }, hacFor('A401', false));
    const fetched = await fetchOne(ctx, 'main', HAC_BTF);
    expect(fetched.download!.kind).toBe('protocol');

    // And no payment verdicts were stored from it.
    const reports = db.prepare('SELECT COUNT(*) AS n FROM download_reports').get() as { n: number };
    expect(reports.n).toBe(0);
  });

  it('a real pain.002 through the same BTF is still a status report', async () => {
    bank.enqueue(
      { serviceName: 'HAC', msgName: 'pain.002' },
      `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.002.001.03">` +
        `<CstmrPmtStsRpt><GrpHdr><MsgId>B-1</MsgId></GrpHdr>` +
        `<OrgnlGrpInfAndSts><OrgnlMsgId>RUN-1</OrgnlMsgId><GrpSts>ACSC</GrpSts></OrgnlGrpInfAndSts>` +
        `</CstmrPmtStsRpt></Document>`,
    );
    const fetched = await fetchOne(ctx, 'main', HAC_BTF);
    expect(fetched.download!.kind).toBe('status');
  });

  it('hands over the log folded by order number', async () => {
    bank.enqueue({ serviceName: 'HAC', msgName: 'pain.002' }, hacFor('A401', true));
    const fetched = await fetchOne(ctx, 'main', HAC_BTF);
    const detail = downloadDetail(db, fetched.download!.public_id);
    expect(detail.customer_protocol!.message_id).toBe('PROT-1');
    expect(detail.customer_protocol!.host_id).toBe('MOCKHOST');
    expect(detail.customer_protocol!.orders).toEqual([
      expect.objectContaining({ order_id: 'A401', verdict: 'failed' }),
    ]);
  });

  it('records the bank’s order number on an upload, which is what the log keys on', async () => {
    const { order } = await submitOrder(ctx, {
      connection: 'main',
      btf: { service_name: 'SCT', msg_name: 'pain.001' },
      payload: Buffer.from(pain001('RUN-1'), 'utf8'),
    });
    const row = db.prepare('SELECT ebics_order_id FROM orders WHERE public_id = ?').get(order.public_id) as {
      ebics_order_id: string | null;
    };
    expect(row.ebics_order_id).toBe(bank.assignedOrderIds[0]);
  });

  it('rejects an order the bank’s log says failed, which no pain.002 would ever say', async () => {
    // An order refused at the SIGNATURE step never reaches a status report at
    // all. Without the protocol it sits at "accepted" while nothing moves.
    const { order } = await submitOrder(ctx, {
      connection: 'main',
      btf: { service_name: 'SCT', msg_name: 'pain.001' },
      payload: Buffer.from(pain001('RUN-1'), 'utf8'),
    });
    expect(orderDetail(db, order.public_id).status).toBe('accepted');

    bank.enqueue({ serviceName: 'HAC', msgName: 'pain.002' }, hacFor(bank.assignedOrderIds[0]!, true));
    await fetchOne(ctx, 'main', HAC_BTF);
    expect(applyCustomerProtocol(db, ctx.now!)).toBe(1);

    const after = orderDetail(db, order.public_id);
    expect(after.status).toBe('rejected');
    expect(after.events.at(-1)!.ebics_code).toBe('DS11');
  });

  it('does not call an order settled just because the bank finished with it', async () => {
    // A HAC "processed" means the bank handled the file at the EBICS level. It
    // says nothing about whether the payment executed — only a pain.002 does.
    const { order } = await submitOrder(ctx, {
      connection: 'main',
      btf: { service_name: 'SCT', msg_name: 'pain.001' },
      payload: Buffer.from(pain001('RUN-1'), 'utf8'),
    });
    bank.enqueue({ serviceName: 'HAC', msgName: 'pain.002' }, hacFor(bank.assignedOrderIds[0]!, false));
    await fetchOne(ctx, 'main', HAC_BTF);
    expect(applyCustomerProtocol(db, ctx.now!)).toBe(0);
    expect(orderDetail(db, order.public_id).status).toBe('accepted');
  });

  it('does not fill the event stream when the same protocol is applied twice', async () => {
    const { order } = await submitOrder(ctx, {
      connection: 'main',
      btf: { service_name: 'SCT', msg_name: 'pain.001' },
      payload: Buffer.from(pain001('RUN-1'), 'utf8'),
    });
    bank.enqueue({ serviceName: 'HAC', msgName: 'pain.002' }, hacFor(bank.assignedOrderIds[0]!, true));
    await fetchOne(ctx, 'main', HAC_BTF);
    applyCustomerProtocol(db, ctx.now!);
    const before = orderDetail(db, order.public_id).events.length;

    db.prepare("UPDATE downloads SET processed_at = NULL WHERE kind = 'protocol'").run();
    expect(applyCustomerProtocol(db, ctx.now!)).toBe(0);
    expect(orderDetail(db, order.public_id).events).toHaveLength(before);
  });

  it('leaves a failure it cannot attribute on the download, not on a stranger', async () => {
    await submitOrder(ctx, {
      connection: 'main',
      btf: { service_name: 'SCT', msg_name: 'pain.001' },
      payload: Buffer.from(pain001('RUN-1'), 'utf8'),
    });
    // An order number this connection has never seen.
    bank.enqueue({ serviceName: 'HAC', msgName: 'pain.002' }, hacFor('ZZ99', true));
    const fetched = await fetchOne(ctx, 'main', HAC_BTF);
    expect(applyCustomerProtocol(db, ctx.now!)).toBe(0);
    // Still stored and still readable — a human can go and look.
    expect(downloadDetail(db, fetched.download!.public_id).customer_protocol!.orders[0]!.order_id).toBe('ZZ99');
  });
});
