/**
 * EBICS return codes — and the rule that a response carries TWO of them.
 *
 * Every `ebicsResponse` reports a **technical** code in its header and a
 * **business** code in its body, and reading the wrong one is the classic way
 * an implementation reports success on a rejection: the transport worked
 * perfectly (`000000` in the header) while the bank refused the payment
 * (`09xxxx` in the body). `verdictOf` therefore always takes both.
 *
 * ## Why this table is deliberately short
 *
 * The specification lists well over a hundred codes. Naming them from memory is
 * how a plausible, confidently-worded, WRONG sentence ends up next to a
 * payment — "already carried out" against a code that actually means
 * "rejected", and an operator who stops looking. So this file states only:
 *
 * 1. the codes the protocol layer itself has to act on (`000000`, and the
 *    "no data / postponed" pair the download loop depends on), and
 * 2. what the **code ranges** mean, which the specification does define
 *    structurally: `00xxxx` success, `06xxxx` technical, `09xxxx` business.
 *
 * Everything else is carried through with the bank's own `ReportText`, so the
 * operator sees the number and the bank's own words and can look it up. Filling
 * this table in from the bank's documentation during onboarding is a normal
 * thing to do — see `BANK_CODES` for where entries go.
 */

/** The one code that means "nothing is wrong". */
export const EBICS_OK = '000000';

/** No data to download yet — the download loop's normal, non-error outcome. */
export const EBICS_NO_DOWNLOAD_DATA = '090005';

/** The bank accepted the request but the data is not ready; ask again later. */
export const EBICS_DOWNLOAD_POSTPONED = '011000';

/** How a code should be treated once its number is known. */
export type Severity =
  /** Done, and successfully. */
  | 'ok'
  /** Not done yet — expected mid-transaction, keep going or come back later. */
  | 'pending'
  /** Refused for a reason that will not change on its own. */
  | 'rejected'
  /** Failed for a reason that might not recur — a retry is defensible. */
  | 'retryable';

export interface CodeInfo {
  code: string;
  severity: Severity;
  /** What the code means, as far as this service can honestly say. */
  meaning: string;
  /** True when the meaning came from the table rather than from the range. */
  known: boolean;
}

/**
 * The codes this service acts on by number. Short on purpose (see above) —
 * additions belong here only when their meaning is confirmed against a bank's
 * own documentation, never from memory.
 */
const BANK_CODES: Readonly<Record<string, { severity: Severity; meaning: string }>> = {
  [EBICS_OK]: { severity: 'ok', meaning: 'OK' },
  [EBICS_DOWNLOAD_POSTPONED]: {
    severity: 'pending',
    meaning: 'The bank accepted the request but has no data ready yet',
  },
  [EBICS_NO_DOWNLOAD_DATA]: { severity: 'pending', meaning: 'No download data available' },
};

/**
 * What a code's RANGE says, when its number is not in the table.
 *
 * The leading digits are structural in EBICS: `00` succeeded, `06` is a
 * technical/transport fault, `09` is the bank refusing on business grounds.
 * That is enough to decide what to do — stop, or consider a retry — without
 * inventing a specific reason.
 */
function fromRange(code: string, reportText: string): { severity: Severity; meaning: string } {
  const said = reportText.trim() === '' ? '' : ` — the bank says: ${reportText.trim()}`;
  if (code.startsWith('00')) return { severity: 'ok', meaning: `Success code ${code}${said}` };
  if (code.startsWith('01')) return { severity: 'pending', meaning: `Transfer still in progress (${code})${said}` };
  if (code.startsWith('06')) {
    // A technical fault is about the conversation, not the payment. Treating it
    // as retryable is safe precisely BECAUSE the order was not accepted: the
    // idempotency key in orders.ts is what stops a retry becoming two payments.
    return { severity: 'retryable', meaning: `EBICS technical error ${code}${said}` };
  }
  if (code.startsWith('09')) {
    return { severity: 'rejected', meaning: `The bank refused the order (${code})${said}` };
  }
  return { severity: 'rejected', meaning: `Unrecognised EBICS code ${code}${said}` };
}

export function codeInfo(code: string, reportText = ''): CodeInfo {
  const known = BANK_CODES[code];
  if (known !== undefined) return { code, ...known, known: true };
  return { code, ...fromRange(code, reportText), known: false };
}

export function isOk(code: string): boolean {
  return code === EBICS_OK;
}

export interface Verdict {
  /** True only when both codes are OK. */
  ok: boolean;
  severity: Severity;
  technical: CodeInfo;
  business: CodeInfo;
  /** One line naming whichever half actually went wrong. */
  message: string;
}

/**
 * Judge a response by BOTH of its codes.
 *
 * The technical code is read first: if the conversation itself failed, the
 * business code is meaningless and usually absent. Only when the transport is
 * clean does the business code decide — and that is exactly the case an
 * implementation reading a single field gets wrong, by calling a refused
 * payment a success.
 */
export function verdictOf(technicalCode: string, businessCode: string, reportText = ''): Verdict {
  const technical = codeInfo(technicalCode, reportText);
  const business = codeInfo(businessCode, reportText);

  if (!isOk(technicalCode) && technical.severity !== 'ok') {
    return {
      ok: false,
      severity: technical.severity,
      technical,
      business,
      message: technical.meaning,
    };
  }
  if (!isOk(businessCode) && business.severity !== 'ok') {
    return { ok: false, severity: business.severity, technical, business, message: business.meaning };
  }
  return { ok: true, severity: 'ok', technical, business, message: 'OK' };
}
