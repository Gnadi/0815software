import { describe, expect, it } from 'vitest';
import { FINANZAEMTER, FINANZAMT_BIC, finanzamtFor } from '../shared/finanzamt.js';
import { isValidIban, normalizeIban } from '../shared/sepa.js';

/**
 * The tax office list.
 *
 * Transcribed by hand from a PDF annex, which is exactly the kind of source
 * that produces a transposed digit nobody notices until a payment vanishes.
 * So the first test is not about behaviour at all: it checks every IBAN's own
 * check digits, which catches a transcription slip without needing to know
 * what the right answer was.
 */

describe('the transcription itself', () => {
  it('every IBAN passes its own check digits', () => {
    const bad = FINANZAEMTER.filter((office) => !isValidIban(office.iban));
    expect(bad.map((o) => `${o.office} ${o.name} ${o.iban}`)).toEqual([]);
  });

  it('every IBAN is Austrian and stored normalised', () => {
    for (const office of FINANZAEMTER) {
      expect(office.iban).toBe(normalizeIban(office.iban));
      expect(office.iban.startsWith('AT'), office.iban).toBe(true);
      expect(office.iban).toHaveLength(20);
    }
  });

  it('names no office twice, and no account twice', () => {
    // Two offices sharing an account would mean one of them was mistyped.
    expect(new Set(FINANZAEMTER.map((o) => o.iban)).size).toBe(FINANZAEMTER.length);
    expect(new Set(FINANZAEMTER.map((o) => o.office)).size).toBe(FINANZAEMTER.length);
  });

  it('carries the whole annex, not part of it', () => {
    // 35 offices: Finanzamt Österreich's dienststellen plus the two special
    // offices. A silent truncation while extracting from the PDF would show up
    // here and nowhere else.
    expect(FINANZAEMTER).toHaveLength(35);
    expect(FINANZAEMTER.map((o) => o.office)).toContain(11); // Großbetriebe
    expect(FINANZAEMTER.map((o) => o.office)).toContain(37); // Betrugsbekämpfung
  });
});

describe('recognising a tax office', () => {
  it('finds one however the IBAN was typed', () => {
    expect(finanzamtFor('AT880100000005504116')?.name).toBe('Finanzamt für Großbetriebe');
    expect(finanzamtFor('at88 0100 0000 0550 4116')?.office).toBe(11);
    expect(finanzamtFor(' AT88 0100 0000 0550 4116 ')?.office).toBe(11);
  });

  it('says nothing about an ordinary creditor', () => {
    expect(finanzamtFor('AT483200000012345864')).toBeNull();
    expect(finanzamtFor('')).toBeNull();
  });

  it('offers the one BIC a Finanzamtszahlung may carry', () => {
    // "Die Angabe einer BIC ist grundsätzlich nicht erforderlich, wird sie
    // dennoch kodiert, ist nur BUNDATWW zu verwenden."
    expect(FINANZAMT_BIC).toBe('BUNDATWW');
  });
});
