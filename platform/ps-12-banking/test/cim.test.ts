import { describe, expect, it } from 'vitest';
import { isCustomerInfo, readCustomerInfo } from '../server/cim.js';

/**
 * Reading a customer information message.
 *
 * Every other parser in this service is checked against a published schema.
 * This one cannot be: the CIMResp schema lives at `zv.psa.at`, which this
 * build cannot reach. So the tests are written the way the parser is — around
 * the two element names the Austrian guideline states in prose, and around
 * structure for everything else — and they assert the CEILING as much as the
 * behaviour, so that a later version built on the real schema has to be a
 * deliberate change rather than an accident.
 */

const RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<CIMResp xmlns="urn:example:cim">
  <CIMMsgType>
    <CIMId>f81d4fae-7dec-11d0-a765-00a0c91e6bf6</CIMId>
    <Timestamp>2026-08-20T18:00:00Z</Timestamp>
    <Subject>Serviceintervall</Subject>
    <Text>Am 24.08.2026 von 02:00 bis 04:00 steht EBICS nicht zur Verfügung.</Text>
  </CIMMsgType>
  <CIMMsgType>
    <CIMId>0f8fad5b-d9cb-469f-a165-70867728950e</CIMId>
    <Timestamp>2026-08-21T09:00:00Z</Timestamp>
    <Text>Ab 11/2026 wird für SEPA-Überweisungen nur noch pain.001.001.09 angenommen.</Text>
  </CIMMsgType>
</CIMResp>`;

describe('which BTF is a customer information message', () => {
  it('accepts both names the two Austrian documents give', () => {
    // The mapping table (04.07.2025) says cimresp; the implementation
    // guideline's worked ebicsRequest example says BRCResp. An operator whose
    // bank follows the older example should not get an opaque blob for it.
    expect(isCustomerInfo('cimresp')).toBe(true);
    expect(isCustomerInfo('BRCResp')).toBe(true);
    expect(isCustomerInfo('CIMResp')).toBe(true);
  });

  it('does not claim anything else', () => {
    expect(isCustomerInfo('camt.053')).toBe(false);
    expect(isCustomerInfo('pain.002')).toBe(false);
    expect(isCustomerInfo('misc')).toBe(false);
  });
});

describe('reading the notices', () => {
  it('finds every message, not just the first', () => {
    expect(readCustomerInfo(RESPONSE)).toHaveLength(2);
  });

  it('reads the CIMId, which the guideline names', () => {
    const [first, second] = readCustomerInfo(RESPONSE);
    expect(first!.id).toBe('f81d4fae-7dec-11d0-a765-00a0c91e6bf6');
    expect(second!.id).toBe('0f8fad5b-d9cb-469f-a165-70867728950e');
  });

  it('finds the timestamp by shape, because nothing names it', () => {
    // The guideline says each message carries one and never says in which
    // element, so this looks for text that parses as an ISO date-time. That
    // is the honest ceiling without the schema.
    expect(readCustomerInfo(RESPONSE)[0]!.timestamp).toBe('2026-08-20T18:00:00Z');
  });

  it('keeps the prose, and keeps it in order', () => {
    // Text content needs no element names at all, which is exactly why the
    // parser leans on it: a guessed <CIMText> would have dropped everything
    // from a bank that called it something else.
    expect(readCustomerInfo(RESPONSE)[0]!.lines).toEqual([
      'Serviceintervall',
      'Am 24.08.2026 von 02:00 bis 04:00 steht EBICS nicht zur Verfügung.',
    ]);
  });

  it('does not repeat the id or the timestamp as prose', () => {
    const [first] = readCustomerInfo(RESPONSE);
    expect(first!.lines).not.toContain(first!.id);
    expect(first!.lines).not.toContain(first!.timestamp);
  });

  it('reads a message in ANY namespace, since none is documented here', () => {
    // The guideline names CIMMsgType but this build has no schema to say which
    // namespace it lives in. Matching on one would drop every message from a
    // bank that chose differently.
    const other = RESPONSE.replace('urn:example:cim', 'urn:some:other:namespace');
    expect(readCustomerInfo(other)).toHaveLength(2);
    expect(readCustomerInfo(other)[0]!.id).toBe('f81d4fae-7dec-11d0-a765-00a0c91e6bf6');
  });

  it('falls back to the document itself when there is no CIMMsgType wrapper', () => {
    const bare = `<CIMResp xmlns="urn:example:cim"><CIMId>abc</CIMId><Text>Hinweis</Text></CIMResp>`;
    const [only] = readCustomerInfo(bare);
    expect(only!.id).toBe('abc');
    expect(only!.lines).toEqual(['Hinweis']);
  });

  it('returns nothing rather than throwing on bytes that are not XML', () => {
    // The document is stored whole either way. Failing here would turn an
    // unreadable notice into an unreadable download, and a bank's service
    // announcement is not worth a 500.
    expect(readCustomerInfo(Buffer.from([0x00, 0x01, 0x02]))).toEqual([]);
    expect(readCustomerInfo('not xml at all')).toEqual([]);
  });
});
