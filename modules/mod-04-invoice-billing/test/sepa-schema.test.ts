import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPain001, type SepaInstruction } from '../shared/sepa.js';

/**
 * Every file this module can emit, against the published ISO 20022 schema.
 *
 * The builder was checked against this schema once, by hand, when it was
 * written — which is worth exactly as much as the day it was done. Element
 * order in pain.001.001.03 is fixed by the schema and not by taste, and
 * `CtgyPurp` has to follow `SvcLvl` inside `PmtTpInf`; putting it anywhere
 * else produces a file that reads perfectly and that a bank rejects.
 */

const SCHEMA = join(import.meta.dirname, 'schema', 'pain.001.001.03.xsd');
const HAVE_SCHEMA = existsSync(SCHEMA);
const HAVE_XMLLINT = ((): boolean => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

if (!HAVE_SCHEMA) {
  console.warn('[mod-04] sepa-schema.test.ts SKIPPED — no pain.001.001.03.xsd in test/schema/.');
} else if (!HAVE_XMLLINT) {
  console.warn('[mod-04] sepa-schema.test.ts SKIPPED — xmllint is not installed (apt-get install libxml2-utils).');
}

const workdir = mkdtempSync(join(tmpdir(), 'mod04-sepa-'));

function validate(xml: string): string | null {
  const file = join(workdir, `${Math.random().toString(36).slice(2)}.xml`);
  writeFileSync(file, xml);
  try {
    execFileSync('xmllint', ['--noout', '--schema', SCHEMA, file], { stdio: 'pipe' });
    return null;
  } catch (err) {
    return (err as { stderr?: Buffer }).stderr?.toString() ?? String(err);
  }
}

const BASE: SepaInstruction = {
  message_id: 'MOD04-20260821-0001',
  created_at: '2026-08-21T10:00:00Z',
  execution_date: '2026-08-21',
  batch_booking: false,
  debtor_name: '0815software GmbH',
  debtor_iban: 'AT611904300234573201',
  debtor_bic: 'BKAUATWW',
  payments: [
    {
      end_to_end_id: 'BILL-1',
      amount_cents: 42180,
      creditor_name: 'Stadtwerke Wien Energie GmbH',
      creditor_iban: 'AT483200000012345864',
      creditor_bic: 'RLNWATWW',
      remittance: 'Rechnung 2026-0815',
    },
  ],
};

const describeIf = HAVE_SCHEMA && HAVE_XMLLINT ? describe : describe.skip;

describeIf('every file this module emits validates against pain.001.001.03', () => {
  it('an ordinary SEPA credit transfer', () => {
    expect(validate(buildPain001(BASE))).toBeNull();
  });

  it('a Finanzamtszahlung (CtgyPurp TAXS)', () => {
    expect(validate(buildPain001({ ...BASE, category_purpose: 'TAXS' }))).toBeNull();
  });

  it('a Postbarzahlung (CtgyPurp CPPP)', () => {
    expect(validate(buildPain001({ ...BASE, category_purpose: 'CPPP' }))).toBeNull();
  });

  it('a structured ISO 11649 creditor reference', () => {
    const rf = { ...BASE, payments: [{ ...BASE.payments[0]!, remittance: 'RF18 5390 0754 7034' }] };
    expect(validate(buildPain001(rf))).toBeNull();
  });

  it('a transfer with no creditor BIC, which SEPA allows', () => {
    const noBic = { ...BASE, payments: [{ ...BASE.payments[0]!, creditor_bic: null }] };
    expect(validate(buildPain001(noBic))).toBeNull();
  });

  it('several transfers in one run', () => {
    const many = {
      ...BASE,
      payments: [1, 2, 3].map((n) => ({ ...BASE.payments[0]!, end_to_end_id: `BILL-${n}`, amount_cents: n * 1000 })),
    };
    expect(validate(buildPain001(many))).toBeNull();
  });
});

describeIf('the validator is actually validating', () => {
  it('rejects a file with the elements out of order', () => {
    // Guards against the check silently passing everything. CtgyPurp before
    // SvcLvl is exactly the mistake this suite exists to catch, and it is
    // invisible to every other test in this module.
    const broken = buildPain001({ ...BASE, category_purpose: 'TAXS' })
      .replace('<SvcLvl>', '<XSvcLvl>')
      .replace('</SvcLvl>', '</XSvcLvl>');
    expect(validate(broken)).not.toBeNull();
  });
});
