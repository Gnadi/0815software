import { findAll, parse, textOf, type XmlElement } from './ebics/xml.js';
import type { FieldError } from '../shared/types.js';

/**
 * The two Austria-specific credit transfers, checked before they are signed.
 *
 * This service is payload-agnostic and stays that way: it does not know what an
 * invoice is and does not rewrite a byte of what it signs. But a
 * Finanzamtszahlung or a Postbarzahlung that is malformed is refused by the
 * bank *after* an ES has authorised it — and at signature class E an ES is the
 * money. A file whose remittance structure is wrong is worth catching on this
 * side of the signature, which is the same argument that already justifies
 * reading `MsgId` and the control sum in `payload.ts`.
 *
 * So: when an uploaded `pain.001` marks a payment as Austrian, its remittance
 * is checked against PSA's published format. Nothing here refuses a file that
 * carries no such mark, and nothing here modifies one.
 *
 * ## Where the marks live
 *
 * | | element | level |
 * | --- | --- | --- |
 * | TAXS | `Purp/Cd` | the individual `CdtTrfTxInf` |
 * | CPPP | `PmtTpInf/CtgyPurp/Prtry` | either level |
 *
 * *Finanzamtszahlung in EBICS* allows TAXS in exactly one place and says
 * batch-level coding "ist nicht vorgesehen" even when the whole batch is tax
 * payments — so a `CtgyPurp` of `TAXS` is itself a finding, not a synonym.
 */

/** ISO 20022 namespaces vary by version, so elements are matched by name. */
const PAIN_TXN = 'CdtTrfTxInf';

/**
 * The remittance format for a Finanzamtszahlung, exactly as PSA publishes it.
 *
 *   (\d{2}(\d{2}(/?\d{2})?)?([-+](0|([1-9]([0-9]{0,10})?))[A-Z]{1,3})+)+
 *
 * A period — `YY`, `YYMM`, `YYMMDD` or `YYMM/MM` — then one or more pairs of
 * an amount in cents (`+` a liability, `-` a credit, no leading zeros, at most
 * 11 digits) and a one-to-three-letter kind of tax; the whole repeated.
 *
 * Anchored and non-capturing, which the published form is not: it is written
 * to be read, and unanchored it would accept any string with a valid fragment
 * somewhere inside it.
 */
export const TAXS_REMITTANCE =
  /^(?:\d{2}(?:\d{2}(?:\/?\d{2})?)?(?:[-+](?:0|[1-9][0-9]{0,10})[A-Z]{1,3})+)+$/;

/**
 * The remittance format for a Postbarzahlung, translated to JavaScript.
 *
 * PSA publishes it as:
 *
 *   ((?:K1D\d{8}|K3|K4|K8D\d{8}|K21|K22|K23P43\d{9,11}|K24|K25Z\d{4})+)
 *   ([^ZDPK0-9])(\d{4})\2([^\2]*?)\2([^\2]*?)\2(.*)
 *
 * — clauses, a delimiter drawn from characters the clauses cannot contain, the
 * recipient's post code, two address lines and free text, each separated by
 * that same delimiter.
 *
 * **`[^\2]` does not mean what it looks like in JavaScript.** A backreference
 * inside a character class is not a backreference: `[^\2]` is "any character
 * except U+0002". Used verbatim the expression would let an address line
 * contain the delimiter and mis-split the address. The faithful translation is
 * a negative lookahead, `(?:(?!\2).)*?`, which is what this uses — the
 * published intent is preserved and only the notation changes.
 */
export const CPPP_REMITTANCE =
  /^((?:K1D\d{8}|K3|K4|K8D\d{8}|K21|K22|K23P43\d{9,11}|K24|K25Z\d{4})+)([^ZDPK0-9])(\d{4})\2((?:(?!\2).)*?)\2((?:(?!\2).)*?)\2(.*)$/;

/** Only one clause from 21…25 may appear — a rule the expression cannot carry. */
const CPPP_EXCLUSIVE = /K2[1-5]/g;

/** `RmtInf/Ustrd` is capped at 140 characters in every pain.001 version. */
const MAX_REMITTANCE = 140;

/**
 * Check the Austrian payments in a `pain.001`, if it holds any.
 *
 * Returns an empty list for a file with no Austrian marks, for bytes that are
 * not XML, and for anything that is not a credit transfer initiation. Silence
 * means "nothing to say here", never "this was checked and is fine" — the
 * caller's own validation still applies.
 */
export function austrianPaymentProblems(payload: Buffer | string): FieldError[] {
  let root: XmlElement;
  try {
    root = parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
  } catch {
    return [];
  }

  const problems: FieldError[] = [];
  // A CtgyPurp of CPPP applies to every payment under it; one of TAXS is
  // itself wrong, because the specification allows that code nowhere but
  // Purp/Cd on the transaction.
  const runPurpose = categoryPurposeOf(root);
  if (runPurpose === 'TAXS') {
    problems.push({
      field: 'payload',
      message:
        'marks TAXS in PmtTpInf/CtgyPurp. A Finanzamtszahlung is marked only per transaction, in Purp/Cd — ' +
        'coding it at batch level "ist nicht vorgesehen", even when every payment in the batch is one.',
    });
  }

  const transactions = findAll(root, (node) => node.local === PAIN_TXN);
  transactions.forEach((txn, index) => {
    const purpose = purposeOf(txn) ?? (runPurpose === 'CPPP' ? 'CPPP' : null);
    if (purpose === null) return;

    const field = `payload.transactions[${index}]`;
    const remittance = textOf(firstNamed(txn, 'RmtInf', 'Ustrd')).trim();
    const problem = remittanceProblem(purpose, remittance);
    if (problem !== null) problems.push({ field: `${field}.remittance`, message: problem });

    if (purpose === 'TAXS') {
      // The Ordnungsbegriff travels in EndToEndId; the tax office books
      // against it, so a wrong one misfiles the money rather than losing it.
      const account = taxAccountProblem(textOf(firstNamed(txn, 'PmtId', 'EndToEndId')).trim());
      if (account !== null) {
        problems.push({ field: `${field}.end_to_end_id`, message: `is the tax account number and ${account}` });
      }
    }
  });

  return problems;
}

/** Why this remittance line is not acceptable for that purpose, or null. */
export function remittanceProblem(purpose: 'TAXS' | 'CPPP', remittance: string): string | null {
  const text = remittance.trim();
  if (text === '') return `a ${purpose} payment needs a structured remittance line`;
  if (text.length > MAX_REMITTANCE) return `must be at most ${MAX_REMITTANCE} characters`;

  const pattern = purpose === 'TAXS' ? TAXS_REMITTANCE : CPPP_REMITTANCE;
  if (!pattern.test(text)) {
    return purpose === 'TAXS'
      ? 'is not a valid Finanzamt remittance: a period (YY, YYMM, YYMMDD or YYMM/MM) followed by amounts in ' +
          'cents with + for a liability or - for a credit and a one-to-three-letter kind of tax, e.g. ' +
          '"0811+676850L+176800DB"'
      : 'is not a valid Postbarzahlung remittance: clauses, then a delimiter, post code, two address lines and ' +
          'free text, e.g. "K3?1234?Ort?Strasse 1?Verwendungszweck"';
  }

  if (purpose === 'CPPP') {
    const exclusive = [...new Set(text.match(CPPP_EXCLUSIVE) ?? [])];
    if (exclusive.length > 1) {
      return `clauses 21 to 25 are mutually exclusive; this names ${exclusive.join(' and ')}`;
    }
  }
  return null;
}

/**
 * Whether a 9-digit Ordnungsbegriff carries a valid check digit.
 *
 * Digits in positions 2, 4, 6 and 8 are doubled and their DIGITS summed; the
 * digits in positions 1, 3, 5 and 7 are added; the total is completed to the
 * next multiple of ten.
 *
 * No check that the office number matches the IBAN: after the 2020 office
 * mergers a tax number outlives the office that issued it, and the
 * specification says such checks "sind daher auszubauen".
 */
export function taxAccountProblem(ordnungsbegriff: string): string | null {
  const digits = ordnungsbegriff.trim();
  if (!/^\d{9}$/.test(digits)) return 'must be the 9-digit tax account number (Ordnungsbegriff)';
  const value = [...digits].map(Number);
  const doubled = [1, 3, 5, 7].reduce((sum, i) => sum + digitSum(value[i]! * 2), 0);
  const plain = [0, 2, 4, 6].reduce((sum, i) => sum + value[i]!, 0);
  const expected = (10 - ((doubled + plain) % 10)) % 10;
  return value[8] === expected ? null : `check digit should be ${expected}`;
}

/** `PmtTpInf/CtgyPurp/Prtry` or `/Cd`, wherever it sits. */
function categoryPurposeOf(root: XmlElement): string | null {
  for (const node of findAll(root, (n) => n.local === 'CtgyPurp')) {
    const code = textOf(child(node, 'Prtry') ?? child(node, 'Cd')).trim();
    if (code !== '') return code;
  }
  return null;
}

function purposeOf(txn: XmlElement): 'TAXS' | 'CPPP' | null {
  const purp = child(txn, 'Purp');
  const code = purp === null ? '' : textOf(child(purp, 'Cd')).trim();
  return code === 'TAXS' ? 'TAXS' : null;
}

function firstNamed(scope: XmlElement, ...path: string[]): XmlElement | null {
  let current: XmlElement | null = scope;
  for (const step of path) {
    if (current === null) return null;
    current = child(current, step);
  }
  return current;
}

/** By local name, whatever namespace the pain.001 version declares. */
function child(scope: XmlElement, local: string): XmlElement | null {
  return scope.children.find((c): c is XmlElement => c.kind === 'element' && c.local === local) ?? null;
}

function digitSum(n: number): number {
  return [...String(n)].reduce((sum, c) => sum + Number(c), 0);
}
