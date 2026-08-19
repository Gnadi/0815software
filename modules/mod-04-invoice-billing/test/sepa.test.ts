import { describe, expect, it } from 'vitest';
import {
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
