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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hundredths, isStatementMessage, readBankStatement } from '../server/camt.js';

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
    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
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
    expect(incoming!.msgId).toBe('CUST-MSG-9');
    // The structured creditor reference: where an invoice number belongs, and
    // what to match on before falling back to reading free text.
    expect(incoming!.creditorReference).toBe('RF18539007547034');
  });

  it('keeps every remittance line — a reference split across two is common', () => {
    const [incoming] = v02().statements[0]!.entries;
    // Ustrd repeats at 140 characters. Keeping only the first loses the second
    // half of a long invoice reference.
    expect(incoming!.remittance).toBe('Rechnung 2026-0042 vom 01.08.2026\nTeilzahlung 1 von 2');
  });

  it('reads the transaction code both as ISO domain and as a bank’s own', () => {
    const entries = v02().statements[0]!.entries;
    expect(entries[0]!.bankTransactionCode).toBe('PMNT/RCDT/ESCT');
    expect(entries[1]!.bankTransactionCode).toBe('NSTO+117');
  });

  it('flags a reversal and reads why it came back', () => {
    const returned = v02().statements[0]!.entries[2]!;
    // A consumer summing bookings must be able to see this one undoes another.
    expect(returned.reversal).toBe(true);
    expect(returned.returnReason).toBe('AM04');
    expect(returned.mandateId).toBe('MANDATE-77');
  });

  it('distinguishes a booked entry from a pending one', () => {
    const entries = v02().statements[0]!.entries;
    expect(entries[0]!.status).toBe('BOOK');
    // Not money yet. A consumer treating this as settled is paying twice.
    expect(entries[3]!.status).toBe('PDNG');
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
    expect(statement!.entry_count).toBe(4);
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
    expect(findEntries(db, {}).map((e) => e.status)).toEqual(['BOOK', 'BOOK', 'BOOK']);
    expect(findEntries(db, { status: 'PDNG' })).toHaveLength(1);
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

  it('reads statements as part of the tick', async () => {
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, fixture('statement-v02'));
    const result = await tick(ctx);
    expect(result.statements_read).toBe(1);
    expect(findEntries(db, {})).toHaveLength(3);
  });
});
