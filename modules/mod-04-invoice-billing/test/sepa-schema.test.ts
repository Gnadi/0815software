import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPain001, type SepaInstruction } from '../shared/sepa.js';

/**
 * The payment file, against a schema written by somebody else.
 *
 * Every other test of `buildPain001` compares its output to a string in this
 * repository — which proves the builder is stable, and proves nothing about
 * whether a bank will accept it. This one is the outside check, and the same
 * kind of check that found every real defect in PS-12.
 *
 * The schemas are STUZZA's Austrian validation subset: stricter than the ISO
 * original on the same namespace, so passing here implies passing there.
 *
 * **It skips until two code-list documents are dropped in beside them** — see
 * `test/schema/README.md`. A skipped check that says exactly what it needs is
 * worth more than a reconstructed code list that quietly validates the wrong
 * set of values.
 */

const SCHEMA_DIR = join(import.meta.dirname, 'schema');
const CASES = [
  ['SEPA Rulebook 7.1 plus Austrian options', 'pain.001.001.03-austrian.xsd', 'RB7.1_pain.001_codelists.xsd'],
  ['the Austrian national variant', 'pain.001.001.03-austrian-national.xsd', 'RB7.0_pain.001.N_codelists.xsd'],
] as const;

const HAVE_XMLLINT = ((): boolean => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const base: SepaInstruction = {
  message_id: 'MOD04-20260819-A1B2C3D4',
  created_at: '2026-08-19T09:30:00Z',
  execution_date: '2026-08-20',
  batch_booking: false,
  debtor_name: '0815software GmbH',
  debtor_iban: 'AT611904300234573201',
  debtor_bic: 'GIBAATWWXXX',
  payments: [
    {
      end_to_end_id: 'B1-SW-2026-004512',
      amount_cents: 38_420,
      creditor_name: 'Stadtwerke Wien Energie GmbH',
      creditor_iban: 'AT022050302101023600',
      creditor_bic: 'GIBAATWWXXX',
      remittance: 'SW-2026-004512',
    },
    {
      // No BIC: SEPA is IBAN-only within the EEA, and the element is omitted
      // rather than sent empty. Worth a schema's opinion.
      end_to_end_id: 'B2-RE-2026-0881',
      amount_cents: 118_800,
      creditor_name: 'Hosting Nord GmbH',
      creditor_iban: 'DE02120300000000202051',
      creditor_bic: null,
      // An ISO 11649 reference, which goes in the STRUCTURED block.
      remittance: 'RF18539007547034',
    },
  ],
};

/** Every shape this module can put on the wire. */
const FILES: [string, SepaInstruction][] = [
  ['an ordinary payment run', base],
  ['a batch-booked run', { ...base, batch_booking: true }],
  ['a run with a single payment and no BIC', { ...base, payments: [base.payments[1]!] }],
  [
    'a Finanzamtszahlung, which carries Purp/Cd per transaction',
    {
      ...base,
      payments: [{ ...base.payments[0]!, purpose: 'TAXS', remittance: '0126-4711EG' }],
    },
  ],
];

const describeIf = HAVE_XMLLINT ? describe : describe.skip;

describeIf('the pain.001 this module produces', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'mod04-pain-'));

  it.each(
    CASES.flatMap(([label, schema, codelist]) =>
      FILES.map(([name, instruction]) => [`${name} — ${label}`, schema, codelist, instruction] as const),
    ),
  )('%s', (_name, schema, codelist, instruction) => {
    if (!existsSync(join(SCHEMA_DIR, codelist))) {
      console.warn(
        `[sepa] skipping: ${schema} includes ${codelist}, which is not in test/schema/. See the README there.`,
      );
      return;
    }
    const file = join(workdir, `${Math.random().toString(36).slice(2)}.xml`);
    writeFileSync(file, buildPain001(instruction));
    execFileSync('xmllint', ['--noout', '--schema', join(SCHEMA_DIR, schema), file]);
  });

  it('produces a file at all, so a skipped schema check is not the only assertion', () => {
    // Without this the suite could pass while `buildPain001` threw, which is
    // exactly the trap a conditional test sets for itself.
    for (const [, instruction] of FILES) {
      expect(buildPain001(instruction)).toContain('urn:iso:std:iso:20022:tech:xsd:pain.001.001.03');
    }
  });
});
