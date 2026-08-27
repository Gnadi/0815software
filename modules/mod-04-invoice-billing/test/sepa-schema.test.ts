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
 * The schema is STUZZA's Austrian validation subset: a **stricter** subset of
 * ISO, so a file passing it passes the ISO original too.
 *
 * It carries its own target namespace (`ISO:pain.001.001.03:APC:STUZZA:…`)
 * rather than the ISO one, and the schema itself says why — the ISO namespace
 * is what goes on the wire, and this one exists only to validate against. So
 * the check rewrites the namespace first. That is the documented procedure,
 * not a workaround.
 *
 * ## The `.N` variant is a different product, not a stricter check
 *
 * `pain.001.001.03-austrian-national.xsd` is vendored beside it and is NOT
 * used to validate this module's output, because it would fail — correctly.
 * Its service-level codes are `NURG` / `SDVA` / `URGP`, the Austrian domestic
 * priority codes, and `SEPA` is not among them. It describes the national
 * non-SEPA credit transfer, which this module does not produce. There is a
 * test below that pins exactly that, so nobody "fixes" the omission later.
 */

const SCHEMA_DIR = join(import.meta.dirname, 'schema');
const SEPA_SCHEMA = 'pain.001.001.03-austrian.xsd';
const SEPA_NAMESPACE = 'ISO:pain.001.001.03:APC:STUZZA:payments:004';
const NATIONAL_SCHEMA = 'pain.001.001.03-austrian-national.xsd';
const NATIONAL_NAMESPACE = 'ISO:pain.001.001.03:APC:STUZZA:payments:004:N';
const ISO_NAMESPACE = 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.03';

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

const describeIf = HAVE_XMLLINT && existsSync(join(SCHEMA_DIR, SEPA_SCHEMA)) ? describe : describe.skip;

const workdir = mkdtempSync(join(tmpdir(), 'mod04-pain-'));

/** Write the file under the schema's own namespace and hand it to xmllint. */
function validate(xml: string, schema: string, namespace: string): string | null {
  const file = join(workdir, `${Math.random().toString(36).slice(2)}.xml`);
  writeFileSync(file, xml.replaceAll(ISO_NAMESPACE, namespace));
  try {
    execFileSync('xmllint', ['--noout', '--schema', join(SCHEMA_DIR, schema), file], { stdio: 'pipe' });
    return null;
  } catch (err) {
    return (err as { stderr?: Buffer }).stderr?.toString() ?? String(err);
  }
}

describeIf('the pain.001 this module produces', () => {
  it.each(FILES)('%s passes the Austrian SEPA schema', (_name, instruction) => {
    expect(validate(buildPain001(instruction), SEPA_SCHEMA, SEPA_NAMESPACE)).toBeNull();
  });

  /**
   * The `.N` schema is the national NON-SEPA product, and this pins it.
   *
   * Without this test the natural reading of "MOD-04's file fails the Austrian
   * national schema" is that MOD-04 is wrong. It is not: `SvcLvl/Cd` there is a
   * domestic priority code (NURG / SDVA / URGP) and `SEPA` is deliberately
   * absent. A SEPA credit transfer is simply not that product.
   */
  it('is correctly REJECTED by the national non-SEPA schema, on the service level', () => {
    const problem = validate(buildPain001(base), NATIONAL_SCHEMA, NATIONAL_NAMESPACE);
    expect(problem).not.toBeNull();
    expect(problem).toContain("The value 'SEPA' is not an element of the set {'NURG', 'SDVA', 'URGP'}");
  });

  it('produces a file at all, so the schema check is not the only assertion', () => {
    // Without this the suite could pass while `buildPain001` threw, which is
    // exactly the trap a conditional test sets for itself.
    for (const [, instruction] of FILES) {
      expect(buildPain001(instruction)).toContain(ISO_NAMESPACE);
    }
  });
});
