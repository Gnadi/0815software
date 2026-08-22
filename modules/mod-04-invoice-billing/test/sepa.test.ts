import { describe, expect, it } from 'vitest';
import {
  austrianRemittanceProblem,
  taxAccountProblem,
  CPPP_REMITTANCE,
  buildPain001,
  formatIban,
  ibanProblem,
  isCreditorReference,
  isValidBic,
  isValidIban,
  normalizeIban,
  sepaAmount,
  sepaControlSum,
  sepaText,
  validateSepaInstruction,
  MAX_NAME,
  MAX_REMITTANCE,
  type SepaInstruction,
} from '../shared/sepa.js';

/**
 * The bank file, tested the way the bank's file check tests it: the numbers,
 * the identifiers, the character set, and the exact shape of the XML. These
 * are pure functions — no database, no clock — so every assertion here is
 * about the format itself.
 *
 * The golden document below is a BYTE-for-byte expectation, deliberately:
 * element order in pain.001.001.03 is fixed by the schema (`CdtrAgt` before
 * `Cdtr`, `ChrgBr` after the debtor block), and an assertion that only checked
 * for the presence of tags would pass on a file every bank rejects. It was
 * validated against the official ISO 20022 schema when it was written, and you
 * can repeat that outside the suite — the tests stay offline and dependency-
 * free, which is why the XSD is not vendored here:
 *
 *     xmllint --noout --schema pain.001.001.03.xsd sepa-….xml
 */

/** Real-shaped IBANs whose check digits are genuinely correct. */
const DEBTOR_IBAN = 'AT611904300234573201';
const CREDITOR_AT = 'AT962011182202120077';
const CREDITOR_DE = 'DE89370400440532013000';

function instruction(overrides: Partial<SepaInstruction> = {}): SepaInstruction {
  return {
    message_id: 'MOD04-20260819-A1B2C3D4',
    created_at: '2026-08-19T09:30:00Z',
    execution_date: '2026-08-20',
    batch_booking: false,
    debtor_name: '0815software GmbH',
    debtor_iban: DEBTOR_IBAN,
    debtor_bic: 'GIBAATWWXXX',
    payments: [
      {
        end_to_end_id: 'B1-SW-2026-004512',
        amount_cents: 38_420,
        creditor_name: 'Stadtwerke Wien Energie GmbH',
        creditor_iban: CREDITOR_AT,
        creditor_bic: 'GIBAATWWXXX',
        remittance: 'SW-2026-004512',
      },
      {
        end_to_end_id: 'B2-RE-2026-0881',
        amount_cents: 118_800,
        creditor_name: 'Hosting Nord GmbH',
        creditor_iban: CREDITOR_DE,
        creditor_bic: null,
        remittance: 'RF18539007547034',
      },
    ],
    ...overrides,
  };
}

describe('IBAN validation', () => {
  it('accepts correct IBANs however they were typed', () => {
    expect(isValidIban('AT61 1904 3002 3457 3201')).toBe(true);
    expect(isValidIban('at611904300234573201')).toBe(true);
    expect(isValidIban(CREDITOR_DE)).toBe(true);
    expect(normalizeIban(' at61 1904 3002 3457 3201 ')).toBe(DEBTOR_IBAN);
    expect(formatIban(DEBTOR_IBAN)).toBe('AT61 1904 3002 3457 3201');
  });

  it('catches a single transposed digit — the typo that sends money to a stranger', () => {
    expect(ibanProblem('AT611904300234573210')).toBe('IBAN check digits do not match — check for a typo');
  });

  it('names the length when the IBAN is the wrong length for its country', () => {
    expect(ibanProblem('AT6119043002345732')).toBe('An AT IBAN has 20 characters, this one has 18');
  });

  it('refuses an account a SEPA credit transfer cannot reach at all', () => {
    expect(ibanProblem('US64SVBKUS6S3300958879')).toContain('not a SEPA scheme country');
  });

  it('refuses empty and malformed input', () => {
    expect(ibanProblem('')).toBe('IBAN is required');
    expect(ibanProblem('1234567890')).toContain('must start with two letters');
    expect(ibanProblem('AT61-1904-3002-3457')).toContain('must start with two letters');
  });

  // The shipped default in .env.example. It has to fail: an installation that
  // has not configured its own account must not be able to pay anyone.
  it('refuses the placeholder SELLER_IBAN', () => {
    expect(isValidIban('AT00 0000 0000 0000 0000')).toBe(false);
  });
});

describe('BIC validation', () => {
  it('accepts 8 and 11 character BICs', () => {
    expect(isValidBic('GIBAATWW')).toBe(true);
    expect(isValidBic('GIBAATWWXXX')).toBe(true);
    expect(isValidBic('gibaatwwxxx')).toBe(true);
  });

  it('rejects anything else', () => {
    for (const bad of ['GIBAATW', 'GIBAATWWXX', 'GIBA1TWW', 'GIBAATWWXXXX']) {
      expect(isValidBic(bad), bad).toBe(false);
    }
  });
});

describe('the SEPA character set', () => {
  it('transliterates the DACH letters instead of dropping them', () => {
    expect(sepaText('Müller & Söhne KG', MAX_NAME)).toBe('Mueller + Soehne KG');
    expect(sepaText('Großhandel Öllinger', MAX_NAME)).toBe('Grosshandel Oellinger');
  });

  it('strips accents down to their base letter', () => {
    expect(sepaText('Café Renée', MAX_NAME)).toBe('Cafe Renee');
  });

  it('replaces everything outside the set with a single space', () => {
    expect(sepaText('Rechnung #12 [Q3] 50% *dringend*', MAX_REMITTANCE)).toBe('Rechnung 12 Q3 50 dringend');
  });

  it('keeps the characters the scheme does allow', () => {
    expect(sepaText("Invoice 2026/117-A (net): 1,00 EUR +VAT ?ref O'Brien", MAX_REMITTANCE)).toBe(
      "Invoice 2026/117-A (net): 1,00 EUR +VAT ?ref O'Brien",
    );
  });

  it('truncates to the field length and never leaves a trailing space', () => {
    expect(sepaText('A'.repeat(80), MAX_NAME)).toHaveLength(MAX_NAME);
    expect(sepaText(`${'A'.repeat(69)} BBB`, MAX_NAME)).toBe('A'.repeat(69));
  });

  it('returns an empty string when nothing survives, rather than whitespace', () => {
    expect(sepaText('☺☺☺', MAX_NAME)).toBe('');
  });
});

describe('amounts', () => {
  it('formats integer cents as the schema decimal', () => {
    expect(sepaAmount(0)).toBe('0.00');
    expect(sepaAmount(5)).toBe('0.05');
    expect(sepaAmount(123_456)).toBe('1234.56');
    expect(sepaAmount(99_999_999_999)).toBe('999999999.99');
  });

  it('sums in cents, so a control sum is never a rounding of a rounding', () => {
    expect(sepaControlSum([{ amount_cents: 1 }, { amount_cents: 2 }, { amount_cents: 3 }])).toBe(6);
  });
});

describe('ISO 11649 creditor references', () => {
  it('accepts a valid RF reference in any spacing', () => {
    expect(isCreditorReference('RF18539007547034')).toBe(true);
    expect(isCreditorReference('RF18 5390 0754 7034')).toBe(true);
  });

  it('rejects a mistyped one', () => {
    expect(isCreditorReference('RF19539007547034')).toBe(false);
    expect(isCreditorReference('539007547034')).toBe(false);
  });
});

describe('validateSepaInstruction', () => {
  it('passes a well-formed instruction', () => {
    expect(validateSepaInstruction(instruction())).toEqual([]);
  });

  it('names every field a bank would reject', () => {
    const problems = validateSepaInstruction(
      instruction({
        message_id: '',
        execution_date: '20.08.2026',
        debtor_iban: 'AT00 0000 0000 0000 0000',
        payments: [
          {
            end_to_end_id: 'X'.repeat(36),
            amount_cents: 0,
            creditor_name: '☺',
            creditor_iban: 'DE89370400440532013001',
            creditor_bic: 'NOPE',
            remittance: 'x',
          },
        ],
      }),
    );
    expect(problems.map((p) => p.field)).toEqual([
      'message_id',
      'execution_date',
      'debtor_iban',
      'payments[0].end_to_end_id',
      'payments[0].amount_cents',
      'payments[0].creditor_name',
      'payments[0].creditor_iban',
      'payments[0].creditor_bic',
    ]);
  });

  it('refuses an empty run and an amount above the scheme limit', () => {
    expect(validateSepaInstruction(instruction({ payments: [] }))[0]?.field).toBe('payments');
    const tooBig = validateSepaInstruction(
      instruction({ payments: [{ ...instruction().payments[0]!, amount_cents: 100_000_000_000 }] }),
    );
    expect(tooBig[0]?.message).toContain('999999999.99');
  });
});

describe('the pain.001.001.03 file', () => {
  const xml = buildPain001(instruction());

  it('is the message the bank expects, in the order the schema demands', () => {
    expect(xml).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>MOD04-20260819-A1B2C3D4</MsgId>
      <CreDtTm>2026-08-19T09:30:00Z</CreDtTm>
      <NbOfTxs>2</NbOfTxs>
      <CtrlSum>1572.20</CtrlSum>
      <InitgPty>
        <Nm>0815software GmbH</Nm>
      </InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>MOD04-20260819-A1B2C3D4-1</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <BtchBookg>false</BtchBookg>
      <NbOfTxs>2</NbOfTxs>
      <CtrlSum>1572.20</CtrlSum>
      <PmtTpInf>
        <SvcLvl>
          <Cd>SEPA</Cd>
        </SvcLvl>
      </PmtTpInf>
      <ReqdExctnDt>2026-08-20</ReqdExctnDt>
      <Dbtr>
        <Nm>0815software GmbH</Nm>
      </Dbtr>
      <DbtrAcct>
        <Id>
          <IBAN>AT611904300234573201</IBAN>
        </Id>
      </DbtrAcct>
      <DbtrAgt>
        <FinInstnId>
          <BIC>GIBAATWWXXX</BIC>
        </FinInstnId>
      </DbtrAgt>
      <ChrgBr>SLEV</ChrgBr>
      <CdtTrfTxInf>
        <PmtId>
          <EndToEndId>B1-SW-2026-004512</EndToEndId>
        </PmtId>
        <Amt>
          <InstdAmt Ccy="EUR">384.20</InstdAmt>
        </Amt>
        <CdtrAgt>
          <FinInstnId>
            <BIC>GIBAATWWXXX</BIC>
          </FinInstnId>
        </CdtrAgt>
        <Cdtr>
          <Nm>Stadtwerke Wien Energie GmbH</Nm>
        </Cdtr>
        <CdtrAcct>
          <Id>
            <IBAN>AT962011182202120077</IBAN>
          </Id>
        </CdtrAcct>
        <RmtInf>
          <Ustrd>SW-2026-004512</Ustrd>
        </RmtInf>
      </CdtTrfTxInf>
      <CdtTrfTxInf>
        <PmtId>
          <EndToEndId>B2-RE-2026-0881</EndToEndId>
        </PmtId>
        <Amt>
          <InstdAmt Ccy="EUR">1188.00</InstdAmt>
        </Amt>
        <Cdtr>
          <Nm>Hosting Nord GmbH</Nm>
        </Cdtr>
        <CdtrAcct>
          <Id>
            <IBAN>DE89370400440532013000</IBAN>
          </Id>
        </CdtrAcct>
        <RmtInf>
          <Strd>
            <CdtrRefInf>
              <Tp>
                <CdOrPrtry>
                  <Cd>SCOR</Cd>
                </CdOrPrtry>
              </Tp>
              <Ref>RF18539007547034</Ref>
            </CdtrRefInf>
          </Strd>
        </RmtInf>
      </CdtTrfTxInf>
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`);
  });

  it('states the count and the control sum, and they match the transfers', () => {
    // Both appear twice — once in the group header, once in the payment
    // information block — and a bank compares all four against the file.
    expect(xml.match(/<NbOfTxs>2<\/NbOfTxs>/g)).toHaveLength(2);
    expect(xml.match(/<CtrlSum>1572\.20<\/CtrlSum>/g)).toHaveLength(2);
    expect(38_420 + 118_800).toBe(157_220);
  });

  it('leaves the creditor agent out entirely when no BIC is known (IBAN-only)', () => {
    expect(xml.match(/<CdtrAgt>/g)).toHaveLength(1); // only the AT creditor has one
  });

  it('falls back to NOTPROVIDED for the debtor agent, which the schema requires', () => {
    const noBic = buildPain001(instruction({ debtor_bic: null }));
    expect(noBic).toContain('<DbtrAgt>\n        <FinInstnId>\n          <Othr>\n            <Id>NOTPROVIDED</Id>');
    // The one BIC left is the creditor's — the debtor block carries none.
    expect(noBic.match(/<BIC>/g)).toHaveLength(1);
  });

  it('is a pure function: the same run renders byte-identical XML every time', () => {
    expect(buildPain001(instruction())).toBe(xml);
  });

  it('carries the SEPA-safe form of a name, not the typed one', () => {
    const mangled = buildPain001(
      instruction({
        payments: [{ ...instruction().payments[0]!, creditor_name: 'Müller & Söhne KG' }],
      }),
    );
    expect(mangled).toContain('<Nm>Mueller + Soehne KG</Nm>');
    expect(mangled).not.toContain('ü');
  });

  it('omits the remittance block rather than writing an empty one', () => {
    const blank = buildPain001(
      instruction({ payments: [{ ...instruction().payments[0]!, remittance: '' }] }),
    );
    expect(blank).not.toContain('<RmtInf>');
  });

  it('books each payment separately, so every transfer keeps its own trail', () => {
    expect(xml).toContain('<BtchBookg>false</BtchBookg>');
    expect(buildPain001(instruction({ batch_booking: true }))).toContain('<BtchBookg>true</BtchBookg>');
  });
});

// ── The two Austrian special transfers ────────────────────────────────

describe('Finanzamtszahlung and Postbarzahlung', () => {
  const BASE = {
    message_id: 'MOD04-20260821-0001',
    created_at: '2026-08-21T10:00:00Z',
    execution_date: '2026-08-21',
    batch_booking: false,
    debtor_name: '0815software GmbH',
    debtor_iban: 'AT611904300234573201',
    debtor_bic: 'BKAUATWW',
    payments: [
      {
        end_to_end_id: '269135729',
        amount_cents: 1441161,
        creditor_name: 'Finanzamt Oesterreich',
        creditor_iban: 'AT830100000005504109',
        creditor_bic: null,
        remittance: '0811+676850L+176800DB+23601DZ0810-563910U',
      },
    ],
  };

  it('marks a tax payment on the transaction, never on the batch', () => {
    // The specification allows exactly one place: Purp/Cd inside CdtTrfTxInf.
    // Coding it at batch level "ist nicht vorgesehen" even when every payment
    // in the batch is a tax payment.
    const xml = buildPain001({ ...BASE, payments: [{ ...BASE.payments[0]!, purpose: 'TAXS' as const }] });
    expect(xml).toContain('<Purp>');
    expect(xml).toContain('<Cd>TAXS</Cd>');
    expect(xml).not.toContain('<CtgyPurp>');
    // Purp sits after CdtrAcct and before RmtInf — the schema's sequence.
    expect(xml.indexOf('<Purp>')).toBeGreaterThan(xml.indexOf('</CdtrAcct>'));
    expect(xml.indexOf('<Purp>')).toBeLessThan(xml.indexOf('<RmtInf>'));
  });

  it('lets one run hold a tax payment and an ordinary one', () => {
    // Which follows from the mark being per transaction, and would be
    // impossible if it were a property of the batch.
    const xml = buildPain001({
      ...BASE,
      payments: [
        { ...BASE.payments[0]!, purpose: 'TAXS' as const },
        { ...BASE.payments[0]!, end_to_end_id: 'B9-INV', remittance: 'Rechnung 2026-0815' },
      ],
    });
    expect(xml.match(/<Purp>/g)).toHaveLength(1);
  });

  it('marks a Postbarzahlung with Prtry, not Cd', () => {
    // CPPP appears in no ISO ExternalCategoryPurpose list.
    const xml = buildPain001({ ...BASE, category_purpose: 'CPPP' as const });
    expect(xml).toContain('<Prtry>CPPP</Prtry>');
    expect(xml).not.toContain('<Cd>CPPP</Cd>');
    expect(xml.indexOf('<CtgyPurp>')).toBeGreaterThan(xml.indexOf('</SvcLvl>'));
  });

  it('emits nothing extra for an ordinary transfer', () => {
    const xml = buildPain001(BASE);
    expect(xml).not.toContain('CtgyPurp');
    expect(xml).not.toContain('<Purp>');
  });

  it('keeps an Austrian reference in Ustrd even when it looks like RF', () => {
    // The RF test would otherwise move a tax payment's routing information
    // into a structured block the tax office does not read.
    const rfLike = { ...BASE.payments[0]!, remittance: 'RF18 5390 0754 7034' };
    expect(buildPain001({ ...BASE, payments: [rfLike] })).toContain('<CdtrRefInf>');
    expect(
      buildPain001({ ...BASE, payments: [{ ...rfLike, purpose: 'TAXS' as const }] }),
    ).not.toContain('<CdtrRefInf>');
  });
});

describe('the Finanzamt remittance format', () => {
  // Every example PSA publishes, in both the German and the English document.
  const VALID = [
    '08+100AZ',
    '08+100AZ+4500AA+1401DB',
    '08+100AZ+4500AA+1401DB0811+1EU+4500E-1401GEB',
    '08+100AZ+4500AA+1401DB0811+1EU+4500E-1401GEB0811/12+1EL+4500GA-1401EQ',
    '08+100AZ+4500AA+1401DB0811+1EU+4500E-1401GEB0811/12+1EL+4500GA-1401EQ081211+1FS+4500KU-1401E',
    '0811+676850L+176800DB+23601DZ0810-563910U',
    '0801/03+817200U0804+285900U0711/12+250000U',
  ];

  it.each(VALID)('accepts the published example %s', (remittance) => {
    expect(austrianRemittanceProblem('TAXS', remittance)).toBeNull();
  });

  it.each([
    ['Rechnung 2026-0815', 'an ordinary reference'],
    ['08', 'a period with no booking'],
    ['08+100az', 'a lower-case kind of tax'],
    ['08+0100AZ', 'a leading zero in the amount'],
    ['08+100ABCD', 'a four-letter kind of tax'],
    ['', 'nothing at all'],
  ])('refuses %s — %s', (remittance) => {
    expect(austrianRemittanceProblem('TAXS', remittance)).not.toBeNull();
  });

  it('refuses more than 140 characters, which no Ustrd may carry', () => {
    const long = '08+100AZ'.repeat(20);
    expect(long.length).toBeGreaterThan(140);
    expect(austrianRemittanceProblem('TAXS', long)?.message).toMatch(/140/);
  });
});

describe('the Postbarzahlung remittance format', () => {
  it('accepts the published example', () => {
    const published =
      'K1D20111101K3K4K8D20110101K23P436764058615?1234?Hirschdorf vorm Walde?' +
      'Karl-Christian Lorenzpl.12/3/23?Heizkostenzuschuss 12/2012';
    expect(austrianRemittanceProblem('CPPP', published)).toBeNull();
  });

  it('accepts a minimal one', () => {
    expect(austrianRemittanceProblem('CPPP', 'K3?1234?Ort?Strasse 1?Zweck')).toBeNull();
  });

  it('refuses a line with too few delimiters to hold an address', () => {
    // Post code, address line 1, address line 2 and free text need four
    // delimited fields. Three of anything is not an address.
    expect(austrianRemittanceProblem('CPPP', 'K3?1234?Ort')).not.toBeNull();
    expect(austrianRemittanceProblem('CPPP', 'K3?1234?Ort?Strasse 1')).not.toBeNull();
  });

  it('lets the free text carry the delimiter, but not the address lines', () => {
    // "Trennzeichen darf enthalten sein" applies to the remittance text only,
    // so extra delimiters land there and split nothing further — which is why
    // the address parts have to be both non-greedy and delimiter-free. The
    // published [^\2] is not that in JavaScript: it means "not U+0002". This
    // pins the lookahead translation that is.
    const withExtras = 'K3?1234?Ort?Strasse 1?Zweck?mit?weiteren?Zeichen';
    expect(austrianRemittanceProblem('CPPP', withExtras)).toBeNull();
    const match = CPPP_REMITTANCE.exec(withExtras)!;
    expect(match[4]).toBe('Ort');
    expect(match[5]).toBe('Strasse 1');
    expect(match[6]).toBe('Zweck?mit?weiteren?Zeichen');
  });

  it('refuses two mutually exclusive clauses', () => {
    // A rule the regular expression cannot carry: only one of K21…K25.
    const both = 'K21K22?1234?Ort?Strasse 1?Zweck';
    expect(austrianRemittanceProblem('CPPP', both)?.message).toMatch(/mutually exclusive/);
  });

  it('refuses a delimiter drawn from the clause alphabet', () => {
    expect(austrianRemittanceProblem('CPPP', 'K3K1234KOrtKStrasse 1KZweck')).not.toBeNull();
  });
});

describe('the tax account number', () => {
  it('accepts the check digit the specification works through', () => {
    // 26-913/5729: office 26, tax number 913572, check digit 9.
    expect(taxAccountProblem('269135729')).toBeNull();
  });

  it('names the digit it expected when one is wrong', () => {
    expect(taxAccountProblem('269135720')).toBe('check digit should be 9');
  });

  it('insists on nine digits, leading zero and all', () => {
    expect(taxAccountProblem('26913572')).toMatch(/9-digit/);
    expect(taxAccountProblem('26-913/5729')).toMatch(/9-digit/);
  });

  it('does not check the office number against the IBAN', () => {
    // Deliberately: after the 2020 office mergers a tax number outlives the
    // office that issued it, and the specification says such checks "sind
    // daher auszubauen".
    expect(taxAccountProblem('269135729')).toBeNull();
  });
});
