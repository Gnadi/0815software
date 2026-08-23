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
import { fetchOne, tick, type DownloadContext } from '../server/downloads.js';
import { applyStatements, findEntries, listStatements, reparseStatements } from '../server/statements.js';
import { MockBank } from './mock-bank.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hundredths, isAccountMessage, isStatementMessage, readBankStatement } from '../server/camt.js';

/**
 * Reading a `camt.053`.
 *
 * The two fixtures are the same account on two consecutive days, in the two
 * schema versions the German and Austrian markets actually use — and they are
 * validated against the published ISO schemas before anything here parses
 * them. That order is the point: the schema already caught one error in the
 * fixture (`Refs` is a sequence, so `EndToEndId` cannot precede `MsgId`),
 * which a hand-written sample would have carried into every assertion below.
 */

const SCHEMA_DIR = join(import.meta.dirname, 'schema');
const FIXTURES = join(import.meta.dirname, 'fixtures', 'camt');
const CASES = [
  ['statement-v02', 'camt.053.001.02.xsd'],
  ['statement-v08', 'camt.053.001.08.xsd'],
] as const;

/**
 * The STUZZA schemas — a **stricter subset** of ISO, so a document passing one
 * of these passes the ISO original too. That is what makes them worth running:
 * they encode what an Austrian bank actually sends, which ISO does not.
 *
 * They carry their own target namespace (`ISO:camt.053.001.02:APC:STUZZA:…`)
 * rather than the ISO one, and the schema header says why: the ISO namespace is
 * what goes on the wire, and this one exists solely to validate against. So a
 * check means rewriting the namespace first — a documented step, not a
 * workaround, and the same one every Austrian validator performs.
 */
const AUSTRIAN = join(SCHEMA_DIR, 'austrian');
const AUSTRIAN_CASES = [
  ['statement-v02', '053'],
  ['report-052', '052'],
  ['notification-054', '054'],
] as const;

function toStuzzaNamespace(xml: string, message: string): string {
  return xml.replaceAll(
    `urn:iso:std:iso:20022:tech:xsd:camt.${message}.001.02`,
    `ISO:camt.${message}.001.02:APC:STUZZA:payments:004`,
  );
}

const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, `${name}.xml`));
const v02 = (): NonNullable<ReturnType<typeof readBankStatement>> => readBankStatement(fixture('statement-v02'))!;
const v08 = (): NonNullable<ReturnType<typeof readBankStatement>> => readBankStatement(fixture('statement-v08'))!;

const HAVE_SCHEMAS = existsSync(join(SCHEMA_DIR, 'camt.053.001.02.xsd'));
const HAVE_XMLLINT = ((): boolean => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const describeIf = HAVE_SCHEMAS && HAVE_XMLLINT ? describe : describe.skip;

describeIf('the fixtures are what a conforming bank may send', () => {
  it.each(CASES)('%s', (name, schema) => {
    execFileSync('xmllint', ['--noout', '--schema', join(SCHEMA_DIR, schema), join(FIXTURES, `${name}.xml`)]);
  });

  /**
   * The same fixtures against the Austrian subset — which caught six things
   * about them that no amount of reading ISO would have:
   *
   *   GrpHdr/MsgRcpt          required
   *   Stmt/LglSeqNb           required
   *   Ntry/BookgDt, AcctSvcrRef  required
   *   BkTxCd/Domn AND /Prtry  BOTH required, and Prtry/Issr is fixed to "APC"
   *   TxDtls/Refs, /AmtDtls   both required; Refs allows only five of its ten
   *                           fields; RmtInf/Ustrd is a SINGLE line
   *   Sts                     BOOK only on a camt.053
   */
  it.each(AUSTRIAN_CASES)('%s, against the stricter Austrian subset', (name, message) => {
    const file = join(mkdtempSync(join(tmpdir(), 'camt-at-')), `${name}.xml`);
    writeFileSync(file, toStuzzaNamespace(readFileSync(join(FIXTURES, `${name}.xml`), 'utf8'), message));
    execFileSync('xmllint', [
      '--noout',
      '--schema',
      join(AUSTRIAN, `camt.${message}.001.02.austrian.004.xsd`),
      file,
    ]);
  });
});

/**
 * What the Austrian schemas say about the three messages, encoded as tests so
 * the reader cannot quietly stop honouring it.
 */
describe('what the Austrian subset requires', () => {
  it('keeps the bank’s OWN transaction code, not only the ISO one', () => {
    // Domn and Prtry are BOTH mandatory in Austria, so an Austrian bank always
    // sends both. A reader that preferred the ISO code and fell back to the
    // proprietary one would drop the proprietary code on every single booking
    // — in the market where it is the code the bank keys on.
    const [entry] = v02().statements[0]!.entries;
    expect(entry!.bankTransactionCode).toBe('PMNT/RCDT/ESCT');
    expect(entry!.proprietaryTransactionCode).toBe('NTRF+051');
  });

  it('finds no pending entry on a statement, because Austria forbids one', () => {
    // AT_EntryStatus2Code is {BOOK} for camt.053 and {BOOK, PDNG} for camt.052
    // and camt.054. A pending item lives in the intraday report — which is
    // exactly why querying across both would count money that has not moved.
    expect(v02().statements[0]!.entries.every((e) => e.status === 'BOOK')).toBe(true);
    const report = readBankStatement(fixture('report-052'))!;
    expect(report.statements[0]!.entries.map((e) => e.status)).toContain('PDNG');
  });
});

/**
 * The three account messages, and the one thing that must not be assumed
 * about them.
 *
 * They share `ReportEntry2` and `EntryTransaction2` — identical element for
 * element in all three Austrian schemas, which is what one reader for all
 * three rests on. They do NOT share a meaning: an intraday report and a
 * notification carry bookings the day's statement carries again.
 */
describe('camt.052 and camt.054, which share the entry structure', () => {
  const r052 = (): NonNullable<ReturnType<typeof readBankStatement>> => readBankStatement(fixture('report-052'))!;
  const n054 = (): NonNullable<ReturnType<typeof readBankStatement>> =>
    readBankStatement(fixture('notification-054'))!;

  it('reads each through its own envelope and container', () => {
    expect(r052().kind).toBe('report');
    expect(r052().messageName).toBe('camt.052.001.02');
    expect(n054().kind).toBe('notification');
    expect(n054().messageName).toBe('camt.054.001.02');
    expect(v02().kind).toBe('statement');
  });

  it('reads the bookings out of them with the same reader', () => {
    const [entry] = r052().statements[0]!.entries;
    expect(entry).toMatchObject({
      amount: '299.99',
      credit: true,
      endToEndId: 'INV-2026-0042',
      counterpartyName: 'Muster Handels GmbH',
      bankTransactionCode: 'PMNT/RCDT/ESCT',
    });
    expect(n054().statements[0]!.entries[0]!.endToEndId).toBe('INV-2026-0044');
  });

  it('copes with a notification having no balances at all', () => {
    // AccountNotification2 omits Bal: there is no balance to report on a list
    // of individual items.
    expect(n054().statements[0]!.balances).toEqual([]);
    expect(r052().statements[0]!.balances[0]!.type).toBe('ITBD');
  });

  it('knows all three from a BTF, and the definitive one apart from them', () => {
    expect(['camt.052', 'camt.053', 'camt.054'].every(isAccountMessage)).toBe(true);
    expect(isAccountMessage('camt.086')).toBe(false);
    // Only camt.053 is the end-of-day record.
    expect(isStatementMessage('camt.052')).toBe(false);
    expect(isStatementMessage('camt.053')).toBe(true);
  });
});

describe('recognising a statement', () => {
  it('reads any version of the message', () => {
    expect(v02().version).toBe('02');
    expect(v08().version).toBe('08');
  });

  it('refuses anything that is not one, rather than guessing', () => {
    expect(readBankStatement(Buffer.from('<Document xmlns="urn:x"/>', 'utf8'))).toBeNull();
    expect(readBankStatement(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
    // A pain.002 is XML, ISO 20022 and a bank document — and not a statement.
    expect(
      readBankStatement(
        Buffer.from('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.002.001.03"/>', 'utf8'),
      ),
    ).toBeNull();
  });

  it('knows a statement BTF from its message name', () => {
    expect(isStatementMessage('camt.053')).toBe(true);
    expect(isStatementMessage('CAMT.053.001.08')).toBe(true);
    expect(isStatementMessage('camt.052')).toBe(false);
  });
});

describe('the account and its balances', () => {
  it('reads the account, the period and the sequence numbers', () => {
    const [statement] = v02().statements;
    expect(statement!.statementId).toBe('AT-STMT-000123');
    expect(statement!.electronicSequence).toBe(123);
    expect(statement!.legalSequence).toBe(44);
    expect(statement!.account.iban).toBe('AT611904300234573201');
    expect(statement!.account.currency).toBe('EUR');
    expect(statement!.account.owner).toBe('0815 Software GmbH');
    expect(statement!.fromDate).toBe('2026-08-15T00:00:00');
    expect(statement!.toDate).toBe('2026-08-15T23:59:59');
  });

  it('reads the opening and closing balances with their direction', () => {
    const balances = v02().statements[0]!.balances;
    expect(balances.map((b) => b.type)).toEqual(['OPBD', 'CLBD']);
    expect(balances[1]).toMatchObject({ amount: '1230.51', currency: 'EUR', credit: true, date: '2026-08-15' });
  });

  it('tolerates the CreDtTm that .08 made optional', () => {
    // Required in .02, optional in .08 — an absent one is not a defect.
    expect(v08().statements[0]!.createdAt).toBe('2026-08-16T23:59:00');
  });
});

describe('the bookings', () => {
  it('reads every entry, in the order the bank wrote them', () => {
    const entries = v02().statements[0]!.entries;
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('keeps the amount exactly as sent, and never signs it', () => {
    const [incoming, outgoing] = v02().statements[0]!.entries;
    // ISO puts the direction in CdtDbtInd, never a minus on the amount.
    expect(incoming!.amount).toBe('299.99');
    expect(incoming!.credit).toBe(true);
    expect(outgoing!.amount).toBe('69.48');
    expect(outgoing!.credit).toBe(false);
  });

  it('reads the counterparty from the DEBTOR on money in and the CREDITOR on money out', () => {
    const [incoming, outgoing] = v02().statements[0]!.entries;
    expect(incoming!.counterpartyName).toBe('Muster Handels GmbH');
    expect(incoming!.counterpartyIban).toBe('AT022050302101023600');
    expect(outgoing!.counterpartyName).toBe('Lieferant AG');
    expect(outgoing!.counterpartyIban).toBe('DE02120300000000202051');
  });

  it('reads the references a payment can be matched on', () => {
    const [incoming] = v02().statements[0]!.entries;
    expect(incoming!.endToEndId).toBe('INV-2026-0042');
    // Austria's Refs allows only AcctSvcrRef, EndToEndId, TxId, MndtId and
    // ChqNb — so MsgId is null HERE and read only where a market sends it.
    expect(incoming!.msgId).toBeNull();
    expect(incoming!.accountServicerRef).toBe('BANKREF-0001');
    // The structured creditor reference: where an invoice number belongs, and
    // what to match on before falling back to reading free text.
    expect(incoming!.creditorReference).toBe('RF18539007547034');
  });

  it('keeps every remittance line — a reference split across two is common', () => {
    // The Austrian subset caps Ustrd at ONE line, so the fixture carries one.
    // Elsewhere it repeats at 140 characters, and keeping only the first line
    // loses the second half of a long invoice reference — hence the join.
    expect(v02().statements[0]!.entries[0]!.remittance).toBe('Rechnung 2026-0042 vom 01.08.2026');
    const twoLines = readBankStatement(
      Buffer.from(
        `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">` +
          `<BkToCstmrStmt><GrpHdr><MsgId>M</MsgId></GrpHdr><Stmt><Id>S</Id><Acct><Id><IBAN>AT61</IBAN></Id></Acct>` +
          `<Ntry><Amt Ccy="EUR">1.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BkTxCd/>` +
          `<NtryDtls><TxDtls><RmtInf><Ustrd>first half</Ustrd><Ustrd>second half</Ustrd></RmtInf></TxDtls></NtryDtls>` +
          `</Ntry></Stmt></BkToCstmrStmt></Document>`,
        'utf8',
      ),
    )!;
    expect(twoLines.statements[0]!.entries[0]!.remittance).toBe('first half\nsecond half');
  });

  it('reads the ISO transaction code and the bank’s own SIDE BY SIDE', () => {
    const entries = v02().statements[0]!.entries;
    expect(entries[1]!.bankTransactionCode).toBe('PMNT/ICDT/ESCT');
    expect(entries[1]!.proprietaryTransactionCode).toBe('NSTO+117');
  });

  it('flags a reversal and reads why it came back', () => {
    const returned = v02().statements[0]!.entries[2]!;
    // A consumer summing bookings must be able to see this one undoes another.
    expect(returned.reversal).toBe(true);
    expect(returned.returnReason).toBe('AM04');
    expect(returned.mandateId).toBe('MANDATE-77');
  });

  it('distinguishes a booked entry from a pending one', () => {
    expect(v02().statements[0]!.entries[0]!.status).toBe('BOOK');
    // Not money yet. A consumer treating this as settled is paying twice — and
    // in Austria a pending entry can only reach us on a camt.052, never on a
    // statement, because the schema's status enumeration says so.
    const pending = readBankStatement(fixture('report-052'))!.statements[0]!.entries.find(
      (e) => e.status === 'PDNG',
    );
    expect(pending).toBeDefined();
  });

  it('reads the purpose code where the bank passes it through', () => {
    expect(v02().statements[0]!.entries[1]!.purpose).toBe('SUPP');
  });
});

/**
 * The three version differences, each of which fails SILENTLY when got wrong.
 *
 * None of them throws, none is visible in a single sample file, and all three
 * come back as a plausible null. They are the whole reason both schemas are
 * vendored.
 */
describe('the version differences between .02 and .08', () => {
  it('reads Sts as a plain code in .02 and as a Cd choice in .08', () => {
    expect(v02().statements[0]!.entries[0]!.status).toBe('BOOK');
    expect(v08().statements[0]!.entries[0]!.status).toBe('BOOK');
  });

  it('reads a proprietary status, which only the .08 choice allows', () => {
    expect(v08().statements[0]!.entries[1]!.status).toBe('VORGEMERKT');
  });

  it('finds the counterparty under Pty in .08, where .02 has it directly', () => {
    // THE most likely silent failure in the reader: .08 wraps the party in a
    // Party40Choice, so a reader looking only at Dbtr/Nm returns null for
    // EVERY booking — which reads as "the bank did not send a name".
    expect(v08().statements[0]!.entries[0]!.counterpartyName).toBe('Grosskunde AG');
    expect(v02().statements[0]!.entries[0]!.counterpartyName).toBe('Muster Handels GmbH');
  });

  it('reads the entry amount from the ENTRY, which both versions always carry', () => {
    // .02 has no transaction-level Amt at all; .08 has both. Reading the entry
    // is the only thing that works on both, and is also the correct level:
    // the entry is what hit the account.
    expect(v08().statements[0]!.entries[0]!.amount).toBe('1000.00');
    expect(v02().statements[0]!.entries[0]!.amount).toBe('299.99');
  });
});

/**
 * A collective credit — one movement on the account, many customer payments.
 *
 * The reader used to expose the FIRST transaction's reference, counterparty
 * and remittance as though they belonged to the entry. A 10 000,00 credit
 * covering forty customers was then reported as a 10 000,00 payment from the
 * first of them, quoting the first one's invoice number — which is the
 * strongest evidence a matcher can be given, for a conclusion that is wrong
 * about thirty-nine fortieths of the money.
 */
describe('a collective booking', () => {
  const collective = (): NonNullable<ReturnType<typeof readBankStatement>> =>
    readBankStatement(
      Buffer.from(
        `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">` +
          `<BkToCstmrStmt><GrpHdr><MsgId>M</MsgId></GrpHdr><Stmt><Id>S</Id>` +
          `<Acct><Id><IBAN>AT611904300234573201</IBAN></Id></Acct>` +
          `<Ntry><Amt Ccy="EUR">10000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BkTxCd/>` +
          `<NtryDtls><Btch><MsgId>SAMMEL-1</MsgId><NbOfTxs>3</NbOfTxs></Btch>` +
          `<TxDtls><Refs><EndToEndId>INV-0001</EndToEndId></Refs>` +
          `<RltdPties><Dbtr><Nm>Kunde Eins</Nm></Dbtr></RltdPties>` +
          `<RmtInf><Ustrd>Rechnung 0001</Ustrd></RmtInf></TxDtls>` +
          `<TxDtls><Refs><EndToEndId>INV-0002</EndToEndId></Refs></TxDtls>` +
          `<TxDtls><Refs><EndToEndId>INV-0003</EndToEndId></Refs></TxDtls>` +
          `</NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>`,
        'utf8',
      ),
    )!;

  it('reports the whole movement, which is what hit the account', () => {
    expect(collective().statements[0]!.entries[0]!.amount).toBe('10000.00');
  });

  it('does NOT borrow the first payment’s identity for the whole entry', () => {
    const entry = collective().statements[0]!.entries[0]!;
    expect(entry.endToEndId).toBeNull();
    expect(entry.counterpartyName).toBeNull();
    expect(entry.remittance).toBeNull();
  });

  it('says instead how many payments it covers', () => {
    expect(collective().statements[0]!.entries[0]!.batch).toEqual({
      count: 3,
      messageId: 'SAMMEL-1',
      paymentInfoId: null,
    });
  });

  it('trusts the stated count over the transactions actually sent', () => {
    // A bank may state NbOfTxs without repeating every transaction.
    const one = readBankStatement(
      Buffer.from(
        `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">` +
          `<BkToCstmrStmt><GrpHdr><MsgId>M</MsgId></GrpHdr><Stmt><Id>S</Id>` +
          `<Acct><Id><IBAN>AT61</IBAN></Id></Acct>` +
          `<Ntry><Amt Ccy="EUR">99.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BkTxCd/>` +
          `<NtryDtls><Btch><NbOfTxs>12</NbOfTxs></Btch>` +
          `<TxDtls><Refs><EndToEndId>ONLY-ONE</EndToEndId></Refs></TxDtls>` +
          `</NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>`,
        'utf8',
      ),
    )!.statements[0]!.entries[0]!;
    expect(one.batch?.count).toBe(12);
    expect(one.endToEndId).toBeNull();
  });

  it('leaves an ordinary single payment exactly as it was', () => {
    const [incoming] = v02().statements[0]!.entries;
    expect(incoming!.batch).toBeNull();
    expect(incoming!.endToEndId).toBe('INV-2026-0042');
    expect(incoming!.counterpartyName).toBe('Muster Handels GmbH');
  });
});

describe('amounts', () => {
  it('multiplies by a hundred exactly, without floating point', () => {
    // Number('19.99') * 100 is 1998.9999999999998. Rounding that works on
    // every amount anyone tests with and loses a cent on a real one.
    expect(hundredths('19.99')).toBe(1999);
    expect(hundredths('299.99')).toBe(29999);
    expect(hundredths('0.01')).toBe(1);
    expect(hundredths('1000')).toBe(100000);
    expect(hundredths('7.5')).toBe(750);
  });

  it('declines rather than rounds when the bank sent finer granularity', () => {
    // Silently rounding an amount is worse than saying "I will not convert
    // this"; the exact string is kept either way.
    expect(hundredths('1.005')).toBeNull();
    expect(hundredths('-5.00')).toBeNull();
    expect(hundredths('abc')).toBeNull();
  });

  it('is exposed on every entry beside the exact string', () => {
    const [incoming] = v02().statements[0]!.entries;
    expect(incoming!.amount).toBe('299.99');
    expect(incoming!.amountHundredths).toBe(29999);
    // Deliberately NOT called amountMinor: that needs the currency's exponent,
    // which is 2 for EUR, 0 for JPY and 3 for KWD.
    expect(v08().statements[0]!.entries[1]!.amountHundredths).toBe(750);
  });
});

// ── Through the download path ─────────────────────────────────────────

describe('a statement that arrives as a download', () => {
  let db: Database.Database;
  let bank: MockBank;
  let ctx: DownloadContext & ExchangeContext;

  beforeEach(async () => {
    db = openDb(':memory:');
    bank = new MockBank();
    let clock = 0;
    ctx = {
      db,
      keySecret: loadKeySecret('44'.repeat(32)),
      transport: new Transport({ post: async (_url, body) => bank.post(body) }),
      actor: 'admin',
      now: () => `2026-08-22T10:${String(clock++).padStart(2, '0')}:00Z`,
    };
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
    const detail = connectionDetail(db, 'main');
    verifyBankKeys(ctx, 'main', {
      authDigest: detail.bank_keys.find((k) => k.purpose === 'AUTH')!.digestFormatted,
      encDigest: detail.bank_keys.find((k) => k.purpose === 'ENC')!.digestFormatted,
    });
  });

  const STATEMENT_BTF = { service_name: 'EOP', scope: 'AT', msg_name: 'camt.053', container: 'ZIP' };

  async function collect(name: 'statement-v02' | 'statement-v08'): Promise<void> {
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, fixture(name));
    await fetchOne(ctx, 'main', STATEMENT_BTF);
    applyStatements(db, ctx.now!);
  }

  it('reads the bookings out of a fetched statement', async () => {
    await collect('statement-v02');
    const [statement] = listStatements(db, { connection: 'main' });
    expect(statement!.statement_id).toBe('AT-STMT-000123');
    expect(statement!.entry_count).toBe(3);
    expect(statement!.account.iban).toBe('AT611904300234573201');
    // The bytes stay reachable, so a better reader can be re-run over them.
    expect(statement!.download).toMatch(/^dl_/);
  });

  it('keeps the balances signed, unlike an entry’s amount', async () => {
    await collect('statement-v02');
    const [statement] = listStatements(db);
    expect(statement!.opening_balance).toBe('1000.00');
    expect(statement!.closing_balance).toBe('1230.51');
  });

  it('answers the question a payment matcher actually asks', async () => {
    await collect('statement-v02');
    // "Did anyone pay invoice 2026-0042?"
    const byReference = findEntries(db, { connection: 'main', reference: 'RF18539007547034' });
    expect(byReference).toHaveLength(1);
    expect(byReference[0]).toMatchObject({
      amount: '299.99',
      amount_hundredths: 29999,
      credit: true,
      counterparty_name: 'Muster Handels GmbH',
    });

    // Or by the reference our own pain.001 put on it.
    expect(findEntries(db, { endToEndId: 'INV-2026-0042' })).toHaveLength(1);
    // Or by amount, which is what is left when nobody quoted a reference.
    expect(findEntries(db, { credit: true, amountHundredths: 29999 })).toHaveLength(1);
  });

  it('searches the remittance text and the counterparty', async () => {
    await collect('statement-v02');
    expect(findEntries(db, { search: 'Rechnung 2026-0042' })).toHaveLength(1);
    expect(findEntries(db, { search: 'Lieferant' })).toHaveLength(1);
  });

  it('does not let a % in the search term match everything', async () => {
    await collect('statement-v02');
    // A LIKE built by concatenation turns a reference containing % into a
    // query that matches every booking on the account.
    expect(findEntries(db, { search: '%' })).toHaveLength(0);
  });

  /**
   * The default that stops an invoice being settled against money that is not
   * there yet.
   */
  it('leaves pending entries out unless they are asked for', async () => {
    await collect('statement-v02');
    bank.enqueue({ serviceName: 'STM', msgName: 'camt.052' }, fixture('report-052'));
    await fetchOne(ctx, 'main', { service_name: 'STM', scope: 'AT', msg_name: 'camt.052' });
    applyStatements(db, ctx.now!);

    expect(findEntries(db, {}).map((e) => e.status)).toEqual(['BOOK', 'BOOK', 'BOOK']);
    // The pending item is on the intraday report, which is where Austria puts
    // it — so seeing it means asking for both, deliberately.
    expect(findEntries(db, { status: 'PDNG', source: 'any' })).toHaveLength(1);
  });

  it('can exclude reversals, which undo an earlier booking', async () => {
    await collect('statement-v02');
    expect(findEntries(db, {})).toHaveLength(3);
    expect(findEntries(db, { excludeReversals: true })).toHaveLength(2);
  });

  it('narrows by booking date', async () => {
    await collect('statement-v02');
    expect(findEntries(db, { from: '2026-08-15', to: '2026-08-15' })).toHaveLength(3);
    expect(findEntries(db, { from: '2026-08-16' })).toHaveLength(0);
  });

  /**
   * The invariant migration 12 exists for: a bank re-offering a statement whose
   * receipt it never saw must not double every booking on it.
   */
  it('stores a statement once, however often the bank sends it', async () => {
    await collect('statement-v02');
    // Same statement, different bytes — so the download digest does not catch
    // it and the statement identity has to.
    const altered = Buffer.from(fixture('statement-v02').toString('utf8').replace('BANKREF-0001', 'BANKREF-0001X'));
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, altered);
    await fetchOne(ctx, 'main', STATEMENT_BTF);
    expect(applyStatements(db, ctx.now!)).toBe(0);

    expect(listStatements(db)).toHaveLength(1);
    expect(findEntries(db, {})).toHaveLength(3);
  });

  it('reads a .08 statement through the same path', async () => {
    await collect('statement-v08');
    const entries = findEntries(db, {});
    expect(entries[0]!.counterparty_name).toBe('Grosskunde AG');
    expect(entries[0]!.creditor_reference).toBe('RF81ABC1234567');
  });

  it('re-reads stored statements when the parser is fixed', async () => {
    await collect('statement-v02');
    const before = findEntries(db, {}).length;

    expect(reparseStatements(db, 'main')).toBe(1);
    expect(listStatements(db)).toHaveLength(0);
    // The bytes were the record all along.
    expect(applyStatements(db, ctx.now!)).toBe(1);
    expect(findEntries(db, {})).toHaveLength(before);
  });

  it('marks an unreadable download processed rather than retrying it forever', async () => {
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, '<Document xmlns="urn:not-a-statement"/>');
    await fetchOne(ctx, 'main', STATEMENT_BTF);
    expect(applyStatements(db, ctx.now!)).toBe(0);
    // Second pass finds nothing pending: the file is stored and a human can
    // look at it, but the tick does not report it every minute forever.
    expect(applyStatements(db, ctx.now!)).toBe(0);
  });

  /**
   * The reason `source` is a column and `findEntries` defaults to statements.
   *
   * An intraday report carries the booking the day's statement will carry
   * again. Summing across both counts the money twice — and it is the same
   * booking, from the same bank, on the same day, so nothing about the rows
   * themselves would give it away.
   */
  it('does not count an intraday booking twice when the statement repeats it', async () => {
    bank.enqueue({ serviceName: 'STM', msgName: 'camt.052' }, fixture('report-052'));
    await fetchOne(ctx, 'main', { service_name: 'STM', scope: 'AT', msg_name: 'camt.052' });
    await collect('statement-v02');

    // Both are stored — the report is real data and is not thrown away.
    expect(listStatements(db)).toHaveLength(2);
    expect(listStatements(db).map((s) => s.source).sort()).toEqual(['report', 'statement']);

    // But the default query sees the booking ONCE, from the definitive record.
    const matched = findEntries(db, { endToEndId: 'INV-2026-0042' });
    expect(matched).toHaveLength(1);
    expect(matched[0]!.source).toBe('statement');

    // A caller wanting to see money arriving before end of day asks for it,
    // and then gets both — knowingly.
    expect(findEntries(db, { endToEndId: 'INV-2026-0042', source: 'any' })).toHaveLength(2);
    expect(findEntries(db, { endToEndId: 'INV-2026-0042', source: 'report' })).toHaveLength(1);
  });

  it('reads a notification through the same path', async () => {
    bank.enqueue({ serviceName: 'STM', msgName: 'camt.054' }, fixture('notification-054'));
    await fetchOne(ctx, 'main', { service_name: 'STM', scope: 'AT', msg_name: 'camt.054' });
    expect(applyStatements(db, ctx.now!)).toBe(1);
    expect(listStatements(db)[0]!.source).toBe('notification');
    // Not in the default query, for the same reason as an intraday report.
    expect(findEntries(db, {})).toHaveLength(0);
    expect(findEntries(db, { source: 'notification' })).toHaveLength(1);
  });

  it('reads statements as part of the tick', async () => {
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, fixture('statement-v02'));
    const result = await tick(ctx);
    expect(result.statements_read).toBe(1);
    expect(findEntries(db, {})).toHaveLength(3);
  });
});
