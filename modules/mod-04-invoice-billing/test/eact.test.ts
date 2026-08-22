import { describe, expect, it } from 'vitest';
import { buildEactRemittance, looksLikeEact, type EactElement } from '../shared/eact.js';
import { MAX_REMITTANCE } from '../shared/sepa.js';

/**
 * EACT structured remittance.
 *
 * The published examples are the tests. The component separator is a slash
 * followed by a SPACE — that space is what lets a reference contain a slash of
 * its own, and getting it wrong produces a line that looks right and parses
 * into the wrong fields at the creditor's end.
 */

describe('the published examples', () => {
  it('renders two documents, the second with an amount and a date', () => {
    const elements: EactElement[] = [
      { tag: 'DOC', reference: '894584334' },
      { tag: 'DOC', reference: '894584335', amountCents: 4556, date: '2009-27-07'.replace('27-07', '07-27') },
    ];
    expect(buildEactRemittance(elements).remittance).toBe('/DOC/894584334/DOC/894584335/ 45.56/ 20090727');
  });

  it('renders a deducted amount with its minus sign', () => {
    // "Der Betrag ist ohne Vorzeichen anzugeben. Nur bei Gutschriften ist ein
    // Minus unmittelbar vor dem Betrag anzubringen."
    const elements: EactElement[] = [
      { tag: 'DOC', reference: '94584334' },
      { tag: 'DOC', reference: '94584335', amountCents: 4556, date: '2009-07-27' },
      { tag: 'DOC', reference: '94584336', amountCents: -3410 },
    ];
    expect(buildEactRemittance(elements).remittance).toBe(
      '/DOC/94584334/DOC/94584335/ 45.56/ 20090727/DOC/94584336/ -34.10',
    );
  });

  it('renders an invoice and a credit note', () => {
    const elements: EactElement[] = [
      { tag: 'CINV', reference: '94584334' },
      { tag: 'CREN', reference: '94584335' },
    ];
    expect(buildEactRemittance(elements).remittance).toBe('/CINV/94584334/CREN/94584335');
  });

  it('renders a beneficiary reference with amount and date', () => {
    const elements: EactElement[] = [
      { tag: 'RFB', reference: '9876096598656344', amountCents: 4556, date: '2009-07-27' },
    ];
    expect(buildEactRemittance(elements).remittance).toBe('/RFB/9876096598656344/ 45.56/ 20090727');
  });

  it('renders a remittance advice reference and its location', () => {
    const elements: EactElement[] = [
      { tag: 'URI', reference: '8798877' },
      { tag: 'URL', reference: 'mailbox@system.company.com' },
    ];
    // NOT byte-identical to the published example, and correctly so: the EACT
    // document is a general European convention, but the SEPA character set
    // has no "@". So an email address cannot travel in a SEPA Ustrd at all —
    // it arrives with the @ replaced, whoever writes the file. Better mangled
    // visibly here than refused by the bank for an illegal character.
    expect(buildEactRemittance(elements).remittance).toBe('/URI/8798877/URL/mailbox system.company.com');
  });

  it('renders six invoices, an amount on the last, and two credit notes', () => {
    const elements: EactElement[] = [
      ...['1023753832', '1023753833', '1023753834', '1023753838', '1023753851'].map(
        (reference) => ({ tag: 'CINV' as const, reference }),
      ),
      { tag: 'CINV', reference: '1023753853', amountCents: 23421 },
      { tag: 'CREN', reference: '5000276304' },
      { tag: 'CREN', reference: '5000276304' },
    ];
    expect(buildEactRemittance(elements).remittance).toBe(
      '/CINV/1023753832/CINV/1023753833/CINV/1023753834/CINV/1023753838/CINV/1023753851' +
        '/CINV/1023753853/ 234.21/CREN/5000276304/CREN/5000276304',
    );
  });
});

describe('the component separator', () => {
  it('is a slash AND a space', () => {
    // Which is what lets a reference contain a slash of its own. Without the
    // space the creditor's parser splits the reference instead.
    const { remittance } = buildEactRemittance([
      { tag: 'CINV', reference: '2026/117-A', amountCents: 100 },
    ]);
    expect(remittance).toBe('/CINV/2026/117-A/ 1.00');
  });

  it('omits an unused trailing component rather than leaving it empty', () => {
    // "Die jeweils letzte Komponente darf nicht leer sein und wird mitsamt dem
    // einleitenden Trennzeichen weggelassen."
    expect(buildEactRemittance([{ tag: 'CINV', reference: 'A1' }]).remittance).toBe('/CINV/A1');
    expect(buildEactRemittance([{ tag: 'CINV', reference: 'A1', amountCents: 500 }]).remittance).toBe(
      '/CINV/A1/ 5.00',
    );
  });

  it('keeps an empty component when a later one is used', () => {
    // A date with no amount still needs the amount's separator, or the date
    // would be read as the amount.
    expect(buildEactRemittance([{ tag: 'CINV', reference: 'A1', date: '2026-08-21' }]).remittance).toBe(
      '/CINV/A1/ / 20260821',
    );
  });

  it('writes no components at all for an element tag', () => {
    expect(buildEactRemittance([{ tag: 'CNR', reference: 'KDN-4711' }]).remittance).toBe('/CNR/KDN-4711');
    expect(buildEactRemittance([{ tag: 'TXT', reference: 'Danke' }]).remittance).toBe('/TXT/Danke');
  });
});

describe('the 140-character limit', () => {
  it('never cuts an element in half', () => {
    // Half a reference names the wrong invoice, which is worse than naming
    // none: it reconciles against something real and incorrect.
    const many: EactElement[] = Array.from({ length: 40 }, (_, i) => ({
      tag: 'CINV' as const,
      reference: `20260000${String(i).padStart(3, '0')}`,
    }));
    const { remittance, omitted } = buildEactRemittance(many);
    expect(remittance.length).toBeLessThanOrEqual(MAX_REMITTANCE);
    expect(omitted.length).toBeGreaterThan(0);
    for (const element of omitted) expect(remittance).not.toContain(element.reference);
  });

  it('says which elements did not fit rather than dropping them quietly', () => {
    // A payment naming four of its six invoices is worse than one naming none:
    // the supplier reconciles the four and chases the two that look unpaid.
    const many: EactElement[] = Array.from({ length: 40 }, (_, i) => ({
      tag: 'CINV' as const,
      reference: `20260000${String(i).padStart(3, '0')}`,
    }));
    const { remittance, omitted } = buildEactRemittance(many);
    expect(remittance.split('/CINV/').length - 1 + omitted.length).toBe(40);
  });
});

describe('recognising a structured line', () => {
  it('knows one when it sees one', () => {
    expect(looksLikeEact('/CINV/1023753832')).toBe(true);
    expect(looksLikeEact('/DOC/894584334/DOC/894584335/ 45.56')).toBe(true);
  });

  it('does not claim an ordinary reference', () => {
    expect(looksLikeEact('Rechnung 2026-0815')).toBe(false);
    expect(looksLikeEact('RF18539007547034')).toBe(false);
    expect(looksLikeEact('/NOPE/x')).toBe(false);
  });
});
