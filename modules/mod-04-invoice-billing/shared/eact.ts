import { MAX_REMITTANCE, sepaText } from './sepa.js';

/**
 * Structured remittance information, the EACT way.
 *
 * The European Association of Corporate Treasurers defines a convention for
 * using the 140 characters of `RmtInf/Ustrd` to say precisely what a payment
 * settles — several invoices, a credit note, the amount applied to each — in a
 * form that survives the whole European payment chain unchanged. PSA publishes
 * it for the Austrian market; it is not Austria-specific.
 *
 * Without it, a payment covering six invoices arrives at the supplier as one
 * sum and a free-text line somebody has to read. With it, their ledger can
 * match every line automatically.
 *
 * ## The shape
 *
 * Elements are written one after another with no separator between them; each
 * ends where the next begins. A **compound** element is `/tag/reference/
 * amount/ date`, where the component separator is a slash followed by a
 * **space** — that space is the whole trick, and is what lets a reference
 * itself contain a slash.
 *
 * - unused components are skipped by leaving them empty, but only if a later
 *   one is used;
 * - the last component present may not be empty, and is written without a
 *   trailing separator;
 * - amounts carry no sign unless they are credits, which take a leading minus;
 * - dates are `YYYYMMDD`.
 *
 * `/CINV/1023753832/CINV/1023753853/ 234.21/CREN/5000276304` — two invoices,
 * the second one paid at 234.21, and a credit note.
 *
 * ## One conflict with SEPA
 *
 * EACT is a general European convention and its `/URL/` example is an email
 * address. **The SEPA character set has no `@`.** So a mailbox cannot travel
 * in a SEPA `Ustrd`, whoever writes the file: `sepaText` replaces the
 * character and the address arrives broken. That is the honest outcome — the
 * alternative is a file the bank refuses for an illegal character — but a
 * caller putting an email in `/URL/` should know it will not arrive intact.
 */

/** The tags EACT defines, and whether each carries components. */
export const EACT_TAGS = {
  /** The customer number the creditor issued, as printed on the invoice. */
  CNR: 'element',
  /** Any commercial document underlying the payment. */
  DOC: 'compound',
  /** A commercial invoice. */
  CINV: 'compound',
  /** A credit note. Amounts, if given, are negative. */
  CREN: 'compound',
  /** A debit note. */
  DEBN: 'compound',
  /** A 25-character ISO 11649 reference issued by the beneficiary. */
  RFS: 'compound',
  /** A beneficiary reference without ISO 11649 check digits. */
  RFB: 'compound',
  /** Coded purpose of payment. */
  PUR: 'element',
  /** Identification of a remittance advice sent separately. */
  URI: 'element',
  /** Where that remittance advice was sent. */
  URL: 'element',
  /** Free text. */
  TXT: 'element',
} as const;

export type EactTag = keyof typeof EACT_TAGS;

/** One entry in a structured remittance line. */
export interface EactElement {
  tag: EactTag;
  /** The reference, or the whole value for a tag that takes no components. */
  reference: string;
  /** Applied amount. Negative for a credit note. Compound tags only. */
  amountCents?: number;
  /** `YYYY-MM-DD`; written as `YYYYMMDD`. Compound tags only. */
  date?: string;
}

/** The component separator: a slash and a space, and the space matters. */
const SEP = '/ ';

/**
 * Render EACT elements into one `Ustrd` line.
 *
 * Returns the line and whether every element fitted. **Nothing is silently
 * dropped**: a caller that overflows 140 characters is told which elements did
 * not make it, because a payment that names four of its six invoices is worse
 * than one that names none — the supplier reconciles the four and chases the
 * two that look unpaid.
 */
export function buildEactRemittance(elements: readonly EactElement[]): {
  remittance: string;
  omitted: EactElement[];
} {
  let line = '';
  const omitted: EactElement[] = [];

  for (const element of elements) {
    const rendered = renderElement(element);
    // Built up one element at a time rather than joined and truncated: an
    // element cut in half is a reference that names the wrong invoice.
    if (line.length + rendered.length > MAX_REMITTANCE) {
      omitted.push(element);
      continue;
    }
    line += rendered;
  }

  return { remittance: line, omitted };
}

function renderElement(element: EactElement): string {
  const reference = sepaText(element.reference, MAX_REMITTANCE).trim();
  const head = `/${element.tag}/${reference}`;
  if (EACT_TAGS[element.tag] === 'element') return head;

  // Components, right to left: the last one present is written without a
  // trailing separator, and empty ones are only kept when a later one follows.
  const amount = element.amountCents === undefined ? '' : formatAmount(element.amountCents);
  const date = element.date === undefined ? '' : element.date.replace(/-/g, '');
  if (date !== '') return `${head}${SEP}${amount}${SEP}${date}`;
  if (amount !== '') return `${head}${SEP}${amount}`;
  return head;
}

/** Cents to the EACT decimal: no sign unless it is a credit. */
function formatAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Whether a string looks like an EACT structured remittance.
 *
 * Used to decide whether a remittance line is already structured — not to
 * validate one. EACT defines no grammar strict enough to reject on, and a
 * creditor's own reference could legitimately begin with a slash.
 */
export function looksLikeEact(remittance: string): boolean {
  return new RegExp(`^/(?:${Object.keys(EACT_TAGS).join('|')})/`).test(remittance.trim());
}
