import { describe, expect, it } from 'vitest';
import { austrianPaymentProblems, remittanceProblem, taxAccountProblem } from '../server/austrian.js';

/**
 * The Austrian payment formats, checked on the way to the bank.
 *
 * PS-12 is payload-agnostic and stays that way — but a malformed
 * Finanzamtszahlung is refused by the bank AFTER an ES has authorised it, and
 * at signature class E that signature is the money. One parse here is cheaper
 * than a round trip and a phone call.
 *
 * Every accepted example below is one PSA publishes.
 */

const HEAD = '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn>';
const TAIL = '</CstmrCdtTrfInitn></Document>';

function file(body: string, ctgyPurp?: { element: 'Cd' | 'Prtry'; code: string }): string {
  const pmtTpInf =
    ctgyPurp === undefined
      ? ''
      : `<PmtTpInf><CtgyPurp><${ctgyPurp.element}>${ctgyPurp.code}</${ctgyPurp.element}></CtgyPurp></PmtTpInf>`;
  return `${HEAD}<PmtInf>${pmtTpInf}${body}</PmtInf>${TAIL}`;
}

function txn(options: { purpose?: string; endToEnd?: string; remittance?: string } = {}): string {
  const purp = options.purpose === undefined ? '' : `<Purp><Cd>${options.purpose}</Cd></Purp>`;
  return (
    `<CdtTrfTxInf><PmtId><EndToEndId>${options.endToEnd ?? 'B1-REF'}</EndToEndId></PmtId>` +
    `${purp}<RmtInf><Ustrd>${options.remittance ?? 'Rechnung 2026-0815'}</Ustrd></RmtInf></CdtTrfTxInf>`
  );
}

const TAX_REMITTANCE = '0811+676850L+176800DB+23601DZ0810-563910U';
const TAX_ACCOUNT = '269135729';

describe('a file with nothing Austrian in it', () => {
  it('says nothing at all', () => {
    // Silence means "nothing to say", never "checked and fine".
    expect(austrianPaymentProblems(file(txn()))).toEqual([]);
  });

  it('says nothing about bytes that are not XML', () => {
    expect(austrianPaymentProblems(Buffer.from([0x00, 0x01]))).toEqual([]);
    expect(austrianPaymentProblems('not xml')).toEqual([]);
  });
});

describe('a Finanzamtszahlung', () => {
  it('passes when it matches the published format', () => {
    const xml = file(txn({ purpose: 'TAXS', endToEnd: TAX_ACCOUNT, remittance: TAX_REMITTANCE }));
    expect(austrianPaymentProblems(xml)).toEqual([]);
  });

  it('is caught when its remittance is an ordinary reference', () => {
    const xml = file(txn({ purpose: 'TAXS', endToEnd: TAX_ACCOUNT, remittance: 'Rechnung 2026-0815' }));
    const [problem] = austrianPaymentProblems(xml);
    expect(problem!.field).toBe('payload.transactions[0].remittance');
    expect(problem!.message).toContain('Finanzamt remittance');
  });

  it('is caught when the tax account check digit is wrong', () => {
    const xml = file(txn({ purpose: 'TAXS', endToEnd: '269135720', remittance: TAX_REMITTANCE }));
    const problems = austrianPaymentProblems(xml);
    expect(problems.map((p) => p.field)).toContain('payload.transactions[0].end_to_end_id');
    expect(JSON.stringify(problems)).toContain('check digit should be 9');
  });

  it('names the transaction, so a 300-payment file can be fixed', () => {
    const xml = file(
      txn({ purpose: 'TAXS', endToEnd: TAX_ACCOUNT, remittance: TAX_REMITTANCE }) +
        txn({ purpose: 'TAXS', endToEnd: TAX_ACCOUNT, remittance: 'nonsense' }),
    );
    const [problem] = austrianPaymentProblems(xml);
    expect(problem!.field).toBe('payload.transactions[1].remittance');
  });

  it('is a finding when TAXS is coded at batch level', () => {
    // The specification allows the code in exactly one place and says batch
    // coding "ist nicht vorgesehen" even when the whole batch is tax payments.
    const xml = file(txn(), { element: 'Cd', code: 'TAXS' });
    const [problem] = austrianPaymentProblems(xml);
    expect(problem!.field).toBe('payload');
    expect(problem!.message).toContain('only per transaction');
  });

  it('leaves an ordinary payment in the same file alone', () => {
    const xml = file(
      txn({ purpose: 'TAXS', endToEnd: TAX_ACCOUNT, remittance: TAX_REMITTANCE }) + txn(),
    );
    expect(austrianPaymentProblems(xml)).toEqual([]);
  });
});

describe('a Postbarzahlung', () => {
  const GOOD = 'K3?1234?Ort?Strasse 1?Zweck';

  it('passes when the batch is marked CPPP and the format matches', () => {
    expect(austrianPaymentProblems(file(txn({ remittance: GOOD }), { element: 'Prtry', code: 'CPPP' }))).toEqual([]);
  });

  it('is caught when the remittance is not the clause-and-address structure', () => {
    const xml = file(txn({ remittance: 'Rechnung 2026-0815' }), { element: 'Prtry', code: 'CPPP' });
    expect(austrianPaymentProblems(xml)[0]!.message).toContain('Postbarzahlung remittance');
  });
});

describe('the remittance formats themselves', () => {
  it.each([
    '08+100AZ',
    '08+100AZ+4500AA+1401DB',
    '08+100AZ+4500AA+1401DB0811+1EU+4500E-1401GEB',
    '08+100AZ+4500AA+1401DB0811+1EU+4500E-1401GEB0811/12+1EL+4500GA-1401EQ',
    '0811+676850L+176800DB+23601DZ0810-563910U',
    '0801/03+817200U0804+285900U0711/12+250000U',
  ])('accepts the published TAXS example %s', (text) => {
    expect(remittanceProblem('TAXS', text)).toBeNull();
  });

  it('accepts the published CPPP example', () => {
    const published =
      'K1D20111101K3K4K8D20110101K23P436764058615?1234?Hirschdorf vorm Walde?' +
      'Karl-Christian Lorenzpl.12/3/23?Heizkostenzuschuss 12/2012';
    expect(remittanceProblem('CPPP', published)).toBeNull();
  });

  it('refuses two mutually exclusive CPPP clauses', () => {
    // A rule the published expression cannot carry: one of K21…K25, at most.
    expect(remittanceProblem('CPPP', 'K21K22?1234?Ort?Strasse 1?Zweck')).toMatch(/mutually exclusive/);
  });

  it('refuses more than 140 characters', () => {
    expect(remittanceProblem('TAXS', '08+100AZ'.repeat(20))).toMatch(/140/);
  });

  it('refuses an empty line for either purpose', () => {
    expect(remittanceProblem('TAXS', '   ')).not.toBeNull();
    expect(remittanceProblem('CPPP', '')).not.toBeNull();
  });
});

describe('the tax account check digit', () => {
  it('accepts the number the specification works through', () => {
    expect(taxAccountProblem('269135729')).toBeNull();
  });

  it('names the digit it expected', () => {
    expect(taxAccountProblem('269135720')).toBe('check digit should be 9');
  });

  it('insists on nine digits', () => {
    expect(taxAccountProblem('26913572')).toMatch(/9-digit/);
    expect(taxAccountProblem('26-913/5729')).toMatch(/9-digit/);
  });
});
