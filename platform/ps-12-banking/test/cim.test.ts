import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCustomerInfo, readCustomerInfo } from '../server/cim.js';

/**
 * Reading a customer information message.
 *
 * The fixture is validated against the published `EBICS.CIM.Response.V.1.0.xsd`
 * by the first test here, and only then parsed. That order is the whole point.
 * The first version of this reader was written without the schema, from the
 * guideline's prose mentioning `<CIMMsgType>` — which is a TYPE name, not an
 * element — and it produced one notice containing the entire document's text
 * rather than failing. The tests it had all passed, because they were written
 * against the same misreading.
 */

const SCHEMA = join(import.meta.dirname, 'schema', 'EBICS.CIM.Response.V.1.0.xsd');
const FIXTURE = join(import.meta.dirname, 'fixtures', 'cim', 'cimresp.xml');
const HAVE_SCHEMA = existsSync(SCHEMA);
const HAVE_XMLLINT = ((): boolean => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const response = (): string => readFileSync(FIXTURE, 'utf8');

const describeIf = HAVE_SCHEMA && HAVE_XMLLINT ? describe : describe.skip;

describeIf('the fixture is what a conforming bank sends', () => {
  it('validates against the published CIMResp schema', () => {
    // If this fails the fixture is wrong, and every assertion below measures
    // the parser against a document no bank would produce.
    execFileSync('xmllint', ['--noout', '--schema', SCHEMA, FIXTURE]);
  });
});

describe('which BTF is a customer information message', () => {
  it('accepts both names the two Austrian documents give', () => {
    // The mapping table says cimresp; the guideline's worked example says
    // BRCResp. An operator whose bank follows the older one should not get an
    // opaque blob for it.
    expect(isCustomerInfo('cimresp')).toBe(true);
    expect(isCustomerInfo('BRCResp')).toBe(true);
  });

  it('does not claim anything else', () => {
    expect(isCustomerInfo('camt.053')).toBe(false);
    expect(isCustomerInfo('pain.002')).toBe(false);
    expect(isCustomerInfo('misc')).toBe(false);
  });
});

describe('reading a CIMResp', () => {
  it('reads the group header', () => {
    const message = readCustomerInfo(response())!;
    expect(message.messageId).toBe('2026082114300012ABCD');
    expect(message.createdAt).toBe('2026-08-21T14:30:00');
  });

  it('reads every notice, each as its own entry', () => {
    // The regression that made this file worth rewriting: the old reader
    // returned ONE entry holding the whole document's text.
    const { notices } = readCustomerInfo(response())!;
    expect(notices).toHaveLength(2);
    expect(notices.map((n) => n.id)).toEqual([
      'f81d4fae-7dec-11d0-a765-00a0c91e6bf6',
      '0f8fad5b-d9cb-469f-a165-70867728950e',
    ]);
  });

  it('reads the timestamp from CIMTmStmp, not by guessing at a date shape', () => {
    expect(readCustomerInfo(response())!.notices[0]!.timestamp).toBe('2026-08-20T18:00:00');
  });

  it('reads the headline, and leaves it null where the bank sent none', () => {
    const { notices } = readCustomerInfo(response())!;
    expect(notices[0]!.headline).toBe('Serviceintervall');
    expect(notices[1]!.headline).toBeNull();
  });

  it('keeps the body as the HTML the bank sent, CDATA unwrapped', () => {
    const [first] = readCustomerInfo(response())!.notices;
    expect(first!.text).toContain('<b>02:00 bis 04:00</b>');
    expect(first!.text).toContain('Am 24.08.2026');
  });

  it('never mixes the group header into a notice', () => {
    // What the old reader did, and the reason a notice looked plausible while
    // being wrong: the MsgId came out as part of the message text.
    for (const notice of readCustomerInfo(response())!.notices) {
      expect(notice.text).not.toContain('2026082114300012ABCD');
      expect(notice.text).not.toContain('CreDtTm');
    }
  });

  it('reads a document in another namespace, since a notice is not a payment', () => {
    // Leniency is cheap here and a namespace mismatch would hide the message
    // entirely. It would not be acceptable anywhere a signature is involved.
    const other = response().replace('http://www.psa.at/EBICS/CIMResp', 'urn:some:other');
    expect(readCustomerInfo(other)!.notices).toHaveLength(2);
  });

  it('returns null for anything that is not a CIMResp', () => {
    // The document is stored whole either way, and a bank's announcement is
    // not worth a 500.
    expect(readCustomerInfo('<Document xmlns="urn:x"><Other/></Document>')).toBeNull();
    expect(readCustomerInfo('<CstmrCdtTrfInitn/>')).toBeNull();
    expect(readCustomerInfo(Buffer.from([0x00, 0x01, 0x02]))).toBeNull();
    expect(readCustomerInfo('not xml at all')).toBeNull();
  });
});
