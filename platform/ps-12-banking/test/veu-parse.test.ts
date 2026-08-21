import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseVeuOverview, parseVeuDetail, parseVeuTransactions } from '../server/ebics/parse.js';

/**
 * Reading the distributed-signature queue.
 *
 * The fixtures here are not invented shapes: each one is validated against the
 * published `ebics_orders_H005.xsd` by the first test in this file, and only
 * then parsed. That order matters. Four of the field names in the first draft
 * of these parsers were wrong — `TotalOrderAmount` for `TotalAmount`, a
 * `Currency` attribute that is actually a sibling element, an `OrderAccount`
 * that does not exist, an `ExecutionDate` that is not in that group at all —
 * and every one of them would have produced a plausible null rather than an
 * error. A fixture the schema has vouched for is what turns that into a
 * failing test.
 */

const SCHEMA_DIR = join(import.meta.dirname, 'schema');
const FIXTURES = join(import.meta.dirname, 'fixtures', 'veu');
const HAVE_SCHEMAS = existsSync(join(SCHEMA_DIR, 'ebics_orders_H005.xsd'));
const HAVE_XMLLINT = ((): boolean => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.xml`), 'utf8');

const describeIf = HAVE_SCHEMAS && HAVE_XMLLINT ? describe : describe.skip;

describeIf('the fixtures are what a conforming bank may send', () => {
  it.each(['hvu-response', 'hvz-response', 'hvd-response', 'hvt-response'])('%s', (name) => {
    // If this fails the fixture is wrong, and every parse assertion below is
    // measuring the parser against a document no bank would produce.
    execFileSync('xmllint', [
      '--noout',
      '--schema',
      join(SCHEMA_DIR, 'ebics_orders_H005.xsd'),
      join(FIXTURES, `${name}.xml`),
    ]);
  });
});

describe('HVU — what is waiting for a signature', () => {
  it('reads every queued order, not just the first', () => {
    const orders = parseVeuOverview(fixture('hvu-response'));
    expect(orders).toHaveLength(2);
    expect(orders.map((o) => o.orderId)).toEqual(['A1B2', 'C3D4']);
  });

  it('reads the BTF each order was submitted under', () => {
    const [transfer, debit] = parseVeuOverview(fixture('hvu-response'));
    expect(transfer!.service).toEqual({
      serviceName: 'SCT',
      scope: 'AT',
      option: null,
      msgName: 'pain.001',
      container: null,
    });
    expect(debit!.service.serviceName).toBe('SDD');
    expect(debit!.service.option).toBe('COR');
  });

  it('reads how many signatures are needed and how many are done', () => {
    const [transfer, debit] = parseVeuOverview(fixture('hvu-response'));
    expect(transfer!.signing).toEqual({ required: 2, done: 1, readyToBeSigned: true });
    expect(debit!.signing).toEqual({ required: 2, done: 0, readyToBeSigned: false });
  });

  it('treats a missing readyToBeSigned as false, never as "probably yes"', () => {
    // The flag is the bank saying whether OUR subscriber may sign. Guessing
    // would put a sign button on screen for an order the bank will refuse.
    const stripped = fixture('hvu-response').replace(/ readyToBeSigned="true"/, '');
    expect(parseVeuOverview(stripped)[0]!.signing.readyToBeSigned).toBe(false);
  });

  it('lists who has signed already, with their authorisation level', () => {
    const [transfer, debit] = parseVeuOverview(fixture('hvu-response'));
    expect(transfer!.signers).toHaveLength(1);
    expect(transfer!.signers[0]).toMatchObject({ userId: 'USER1', authorisationLevel: 'E' });
    // An order nobody has signed yet has no SignerInfo at all.
    expect(debit!.signers).toEqual([]);
  });

  it('carries no digest and no summary — that is what HVZ adds', () => {
    const orders = parseVeuOverview(fixture('hvu-response'));
    expect(orders[0]!.dataDigest).toBeNull();
    expect(orders[0]!.summary).toBeNull();
  });
});

describe('HVZ — the same queue, with the payment details', () => {
  it('reads the digest a co-signature will be computed over', () => {
    const [order] = parseVeuOverview(fixture('hvz-response'));
    expect(order!.dataDigest).toBe('2jmj7l5rSw0yVb/vlWAYkK/YBwk=');
  });

  it('reads the amount and the currency, which live in different elements', () => {
    // Currency is a SIBLING of TotalAmount, not an attribute on it. Reading it
    // as an attribute gave a currency that was always null next to an amount
    // that looked perfectly fine.
    const [order] = parseVeuOverview(fixture('hvz-response'));
    expect(order!.summary).toMatchObject({
      totalOrders: 3,
      totalAmount: '2214.80',
      currency: 'EUR',
      isCredit: false,
    });
  });

  it('reads the ordering party and the account the money leaves', () => {
    const [order] = parseVeuOverview(fixture('hvz-response'));
    expect(order!.summary!.orderPartyInfo).toBe('0815software GmbH');
    expect(order!.summary!.firstAccount).toMatchObject({
      number: 'AT611904300234573201',
      international: true,
      bankCode: 'BKAUATWW',
    });
  });

  it('reads the free-text note the originator attached', () => {
    expect(parseVeuOverview(fixture('hvz-response'))[0]!.additionalOrderInfo).toBe('Zahllauf August');
  });
});

describe('HVD — one order, and the digest to sign', () => {
  it('reads the digest, the display file and the availability flags', () => {
    const detail = parseVeuDetail(fixture('hvd-response'));
    expect(detail.dataDigest).toBe('2jmj7l5rSw0yVb/vlWAYkK/YBwk=');
    expect(detail.displayFile?.toString('utf8')).toBe('Zahllauf August');
    expect(detail.orderDataAvailable).toBe(true);
    expect(detail.orderDetailsAvailable).toBe(true);
    expect(detail.orderDataSize).toBe(3074);
  });

  it('refuses a response with no DataDigest rather than signing nothing', () => {
    // Without the digest there is nothing to co-sign, and a parser that
    // returned an empty string here would hand `signDigest` a hash of "".
    const stripped = fixture('hvd-response').replace(/<DataDigest[^>]*>[^<]*<\/DataDigest>/, '');
    expect(() => parseVeuDetail(stripped)).toThrow(/no DataDigest/);
  });
});

describe('HVT — the payments inside a collective order', () => {
  it('reads the total, which is not how many came back', () => {
    const result = parseVeuTransactions(fixture('hvt-response'));
    expect(result.total).toBe(3);
    expect(result.transactions).toHaveLength(1);
  });

  it('tells payer from payee by the account Role', () => {
    // Without the role there is no way to say who is paying whom, which is
    // the entire question a co-signatory is answering.
    const [tx] = parseVeuTransactions(fixture('hvt-response')).transactions;
    const byRole = Object.fromEntries(tx!.accounts.map((a) => [a.role, a]));
    expect(byRole.Originator).toMatchObject({
      number: 'AT611904300234573201',
      holder: '0815software GmbH',
      description: 'Geschaeftskonto',
    });
    expect(byRole.Recipient).toMatchObject({
      number: 'AT483200000012345864',
      holder: 'Stadtwerke Wien Energie GmbH',
    });
  });

  it('reads the amount, currency, direction and date', () => {
    const [tx] = parseVeuTransactions(fixture('hvt-response')).transactions;
    expect(tx!.amount).toBe('421.80');
    expect(tx!.currency).toBe('EUR');
    expect(tx!.isCredit).toBe(false);
    expect(tx!.executionDate).toBe('2026-08-21');
  });

  it('keeps each description under its own type', () => {
    const [tx] = parseVeuTransactions(fixture('hvt-response')).transactions;
    expect(tx!.descriptions).toEqual([
      { type: 'Purpose', text: 'Stromabrechnung 08/2026' },
      { type: 'Comment', text: 'Rechnung 2026-0815' },
    ]);
  });
});
