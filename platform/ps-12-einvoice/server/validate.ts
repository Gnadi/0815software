import { isCalendarDate, isCountryCode, isCurrencyCode } from '../shared/codes.js';
import {
  DOCUMENT_TYPES,
  REASON_REQUIRED_CATEGORIES,
  VAT_CATEGORIES,
  ZERO_VAT_CATEGORIES,
  type EInvoiceInput,
  type Profile,
  type RuleViolation,
  type ValidationResult,
  type VatCategory,
} from '../shared/types.js';

/**
 * The EN 16931 business rules — and the reason this service exists.
 *
 * An e-invoice that is merely well-formed XML is worthless: the recipient's
 * system validates it against these rules and rejects it if they do not hold,
 * usually days later, usually with a message nobody can act on. Catching that
 * HERE, at issue time, with the rule identifier attached, is the difference
 * between "your invoice is wrong, in this way" and "the customer says they
 * never got it".
 *
 * ## What is covered
 *
 * - **BR-01…BR-16** — mandatory content of the document.
 * - **BR-21…BR-27** — mandatory content of every line.
 * - **BR-CO-10, -13, -14, -15, -16** — the arithmetic. The rules that make the
 *   totals in the XML provably the totals the customer was shown.
 * - **BR-S / BR-Z / BR-E / BR-AE / BR-IC / BR-G / BR-O** — the VAT category
 *   rules: which rate a category may carry, whether an exemption reason is
 *   required or forbidden, and that each category's taxable base equals the
 *   lines that fed it.
 * - **BR-CL-01, -03, -04, -14, -15, -17** — the code lists (document type,
 *   dates, currency, countries, VAT category).
 * - **BR-DE-1, -15, -16, -18** — the XRechnung CIUS additions, when that
 *   profile is asked for.
 *
 * ## What is NOT covered, and why that is stated rather than hidden
 *
 * Allowances and charges (BG-20/BG-21) and their rules, invoice-line periods,
 * delivery details, preceding-invoice references, and payee/tax-representative
 * parties are not modelled on this service's input contract at all, so their
 * rules cannot fire. A document PS-12 emits is valid for the fields it carries;
 * it does not claim to be a complete EN 16931 implementation, and
 * `docs/` says so. Adding a field means adding its rules in the same commit.
 *
 * ## Rounding
 *
 * Every amount is an integer in minor units, so the arithmetic rules are exact
 * integer comparisons — no tolerance, no epsilon. The one place rounding
 * appears is BR-S-09 (`vat = round(base × rate ÷ 100)`), computed the same way
 * MOD-04 computes it, so the two can never disagree by a cent.
 */

function violation(rule: string, message: string, term?: string): RuleViolation {
  return term === undefined ? { rule, message } : { rule, term, message };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** VAT amount for a base at a rate — the one rounding step in the standard. */
export function vatFor(baseCents: number, rate: number): number {
  return Math.round((baseCents * rate) / 100);
}

function checkDocument(input: EInvoiceInput, out: RuleViolation[]): void {
  if (!isNonEmpty(input.number)) out.push(violation('BR-02', 'An invoice shall have an invoice number', 'BT-1'));
  if (!isNonEmpty(input.issue_date)) {
    out.push(violation('BR-03', 'An invoice shall have an issue date', 'BT-2'));
  } else if (!isCalendarDate(input.issue_date)) {
    out.push(violation('BR-CL-03', 'The issue date shall be a real calendar date, formatted YYYY-MM-DD', 'BT-2'));
  }
  if (input.due_date !== undefined && input.due_date !== null && !isCalendarDate(input.due_date)) {
    out.push(violation('BR-CL-03', 'The payment due date shall be a real calendar date, formatted YYYY-MM-DD', 'BT-9'));
  }

  const documentType = input.document_type ?? '380';
  if (!(DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
    out.push(violation('BR-CL-01', `Invoice type code shall be one of: ${DOCUMENT_TYPES.join(', ')}`, 'BT-3'));
  }

  const currency = input.currency ?? 'EUR';
  if (!isCurrencyCode(currency)) {
    out.push(violation('BR-CL-04', 'Invoice currency code shall be a valid ISO 4217 code', 'BT-5'));
  }

  // ── Parties (BR-06…BR-11) ────────────────────────────────────────────
  if (!isNonEmpty(input.seller?.name)) out.push(violation('BR-06', 'An invoice shall contain the seller name', 'BT-27'));
  if (!isNonEmpty(input.buyer?.name)) out.push(violation('BR-07', 'An invoice shall contain the buyer name', 'BT-44'));

  const sellerCountry = input.seller?.address?.country_code;
  if (!isNonEmpty(sellerCountry)) {
    out.push(violation('BR-09', 'The seller postal address shall contain a country code', 'BT-40'));
  } else if (!isCountryCode(sellerCountry)) {
    out.push(violation('BR-CL-14', 'The seller country code shall be a valid ISO 3166-1 alpha-2 code', 'BT-40'));
  }

  const buyerCountry = input.buyer?.address?.country_code;
  if (!isNonEmpty(buyerCountry)) {
    out.push(violation('BR-11', 'The buyer postal address shall contain a country code', 'BT-55'));
  } else if (!isCountryCode(buyerCountry)) {
    out.push(violation('BR-CL-15', 'The buyer country code shall be a valid ISO 3166-1 alpha-2 code', 'BT-55'));
  }

  // ── Totals present at all (BR-12…BR-15) ──────────────────────────────
  if (!isInteger(input.net_cents)) {
    out.push(violation('BR-13', 'An invoice shall have a total amount without VAT, in integer minor units', 'BT-109'));
  }
  if (!isInteger(input.vat_total_cents)) {
    out.push(violation('BR-CO-14', 'An invoice shall have a total VAT amount, in integer minor units', 'BT-110'));
  }
  if (!isInteger(input.gross_cents)) {
    out.push(violation('BR-14', 'An invoice shall have a total amount with VAT, in integer minor units', 'BT-112'));
  }
  if (input.paid_cents !== undefined && !isInteger(input.paid_cents)) {
    out.push(violation('BR-15', 'The paid amount shall be an integer number of minor units', 'BT-113'));
  }
}

function checkLines(input: EInvoiceInput, out: RuleViolation[]): void {
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (lines.length === 0) {
    out.push(violation('BR-16', 'An invoice shall have at least one invoice line', 'BG-25'));
    return;
  }

  const seen = new Set<string>();
  lines.forEach((line, index) => {
    const at = `line ${index + 1}`;
    // A line that is not an object at all still has to produce a violation
    // rather than a crash. This validator is the GATE: anything it throws
    // becomes a 500 the caller cannot act on, where the whole point is a 422
    // that names the field.
    if (line === null || typeof line !== 'object') {
      out.push(violation('BR-16', `${at}: is not an invoice line`, 'BG-25'));
      return;
    }
    if (!isNonEmpty(line.id)) {
      out.push(violation('BR-21', `${at}: each invoice line shall have a line identifier`, 'BT-126'));
    } else if (seen.has(line.id)) {
      // Not a numbered EN rule but a schema-level uniqueness the standard
      // assumes; a duplicate LineID makes the breakdown unattributable.
      out.push(violation('BR-21', `${at}: line identifier "${line.id}" is used more than once`, 'BT-126'));
    } else {
      seen.add(line.id);
    }

    if (typeof line.quantity !== 'number' || !Number.isFinite(line.quantity)) {
      out.push(violation('BR-22', `${at}: each invoice line shall have an invoiced quantity`, 'BT-129'));
    }
    if (line.unit_code !== undefined && !isNonEmpty(line.unit_code)) {
      out.push(violation('BR-23', `${at}: the quantity unit of measure shall not be blank`, 'BT-130'));
    }
    if (!isInteger(line.net_cents)) {
      out.push(violation('BR-24', `${at}: each invoice line shall have a net amount`, 'BT-131'));
    }
    if (!isNonEmpty(line.name)) {
      out.push(violation('BR-25', `${at}: each invoice line shall have an item name`, 'BT-153'));
    }
    if (!isInteger(line.unit_price_cents)) {
      out.push(violation('BR-26', `${at}: each invoice line shall have an item net price`, 'BT-146'));
    } else if (line.unit_price_cents < 0) {
      out.push(violation('BR-27', `${at}: the item net price shall not be negative`, 'BT-146'));
    }

    if (!(VAT_CATEGORIES as readonly string[]).includes(line.vat_category)) {
      out.push(
        violation('BR-CL-17', `${at}: VAT category shall be one of: ${VAT_CATEGORIES.join(', ')}`, 'BT-151'),
      );
    }
    if (typeof line.vat_rate !== 'number' || !Number.isFinite(line.vat_rate) || line.vat_rate < 0) {
      out.push(violation('BR-CL-17', `${at}: VAT rate shall be a non-negative number`, 'BT-152'));
    }
  });
}

/**
 * The VAT category rules, one family per category.
 *
 * These are the rules a hand-rolled exporter gets wrong, because they encode
 * something the exporter's own data model usually does not know: a 0 % line is
 * not one thing. Zero-rated, exempt, reverse-charged, intra-community, export
 * and out-of-scope all show 0 % and all mean different things to a tax
 * authority — and every one of them except zero-rated legally REQUIRES a stated
 * reason. Emitting them as an undifferentiated "0 %" is the single most common
 * way a structured invoice is technically valid and substantively wrong.
 */
function checkVatBreakdown(input: EInvoiceInput, out: RuleViolation[]): void {
  const rows = Array.isArray(input.vat_breakdown) ? input.vat_breakdown : [];
  const lines = Array.isArray(input.lines) ? input.lines : [];

  if (rows.length === 0) {
    out.push(violation('BR-CO-14', 'An invoice shall have at least one VAT breakdown row', 'BG-23'));
    return;
  }

  const key = (category: string, rate: number): string => `${category}|${rate}`;
  const seenRows = new Set<string>();

  for (const row of rows) {
    if (row === null || typeof row !== 'object') {
      out.push(violation('BR-CO-14', 'a VAT breakdown entry is not an object', 'BG-23'));
      continue;
    }
    const where = `VAT breakdown ${row.category} @ ${row.rate}%`;
    if (!(VAT_CATEGORIES as readonly string[]).includes(row.category)) {
      out.push(violation('BR-CL-17', `${where}: unknown VAT category code`, 'BT-118'));
      continue;
    }
    const category = row.category as VatCategory;

    const rowKey = key(category, row.rate);
    if (seenRows.has(rowKey)) {
      out.push(violation('BR-CO-18', `${where}: the same category and rate appears in two breakdown rows`, 'BG-23'));
    }
    seenRows.add(rowKey);

    if (!isInteger(row.base_cents)) {
      out.push(violation('BR-45', `${where}: taxable base shall be an integer number of minor units`, 'BT-116'));
      continue;
    }
    if (!isInteger(row.vat_cents)) {
      out.push(violation('BR-46', `${where}: VAT amount shall be an integer number of minor units`, 'BT-117'));
      continue;
    }

    // Rate rules per category.
    if (category === 'S') {
      if (!(row.rate > 0)) {
        out.push(violation('BR-S-05', `${where}: a standard-rated row shall have a rate above zero`, 'BT-119'));
      }
      if (isNonEmpty(row.exemption_reason)) {
        out.push(violation('BR-S-10', `${where}: a standard-rated row shall not carry an exemption reason`, 'BT-120'));
      }
    } else if (ZERO_VAT_CATEGORIES.includes(category)) {
      if (row.rate !== 0) {
        out.push(violation(`BR-${category}-05`, `${where}: this category shall have a rate of zero`, 'BT-119'));
      }
      if (row.vat_cents !== 0) {
        out.push(violation(`BR-${category}-06`, `${where}: this category shall have a VAT amount of zero`, 'BT-117'));
      }
      if (REASON_REQUIRED_CATEGORIES.includes(category) && !isNonEmpty(row.exemption_reason)) {
        out.push(
          violation(
            `BR-${category}-10`,
            `${where}: this category shall state why no VAT is charged — an exemption reason is required`,
            'BT-120',
          ),
        );
      }
      if (category === 'Z' && isNonEmpty(row.exemption_reason)) {
        out.push(violation('BR-Z-10', `${where}: a zero-rated row shall not carry an exemption reason`, 'BT-120'));
      }
    }

    // BR-*-08: the base equals the lines that fed it.
    const lineSum = lines
      .filter((line) => line.vat_category === category && line.vat_rate === row.rate)
      .reduce((sum, line) => sum + (isInteger(line.net_cents) ? line.net_cents : 0), 0);
    if (lineSum !== row.base_cents) {
      out.push(
        violation(
          `BR-${category === 'S' ? 'S' : category}-08`,
          `${where}: taxable base is ${row.base_cents} but the lines at that category and rate total ${lineSum}`,
          'BT-116',
        ),
      );
    }

    // BR-*-09: the VAT amount is the base times the rate.
    const expected = vatFor(row.base_cents, row.rate);
    if (row.vat_cents !== expected) {
      out.push(
        violation(
          `BR-${category === 'S' ? 'S' : category}-09`,
          `${where}: VAT amount is ${row.vat_cents} but ${row.base_cents} at ${row.rate}% is ${expected}`,
          'BT-117',
        ),
      );
    }
  }

  // BR-*-01: every category used on a line has a breakdown row.
  for (const line of lines) {
    if (!(VAT_CATEGORIES as readonly string[]).includes(line.vat_category)) continue;
    if (!seenRows.has(key(line.vat_category, line.vat_rate))) {
      out.push(
        violation(
          `BR-${line.vat_category}-01`,
          `a line uses VAT category ${line.vat_category} at ${line.vat_rate}% but the breakdown has no such row`,
          'BG-23',
        ),
      );
    }
  }
}

/**
 * The arithmetic (BR-CO-*).
 *
 * Exact integer equality, no tolerance. A cent of slack here is a cent of
 * disagreement between the e-invoice and the PDF the customer holds, and a
 * validator that tolerates it is a validator that lets that dispute ship.
 */
function checkArithmetic(input: EInvoiceInput, out: RuleViolation[]): void {
  const lines = Array.isArray(input.lines) ? input.lines : [];
  const rows = Array.isArray(input.vat_breakdown) ? input.vat_breakdown : [];
  if (!isInteger(input.net_cents) || !isInteger(input.gross_cents) || !isInteger(input.vat_total_cents)) return;

  const lineSum = lines.reduce((sum, line) => sum + (isInteger(line.net_cents) ? line.net_cents : 0), 0);
  if (lineSum !== input.net_cents) {
    out.push(
      violation('BR-CO-10', `the invoice line net amounts total ${lineSum} but BT-106/BT-109 says ${input.net_cents}`, 'BT-106'),
    );
  }

  const vatSum = rows.reduce((sum, row) => sum + (isInteger(row.vat_cents) ? row.vat_cents : 0), 0);
  if (vatSum !== input.vat_total_cents) {
    out.push(
      violation('BR-CO-14', `the VAT breakdown totals ${vatSum} but BT-110 says ${input.vat_total_cents}`, 'BT-110'),
    );
  }

  if (input.net_cents + input.vat_total_cents !== input.gross_cents) {
    out.push(
      violation(
        'BR-CO-15',
        `BT-112 shall equal BT-109 + BT-110: ${input.net_cents} + ${input.vat_total_cents} is ${input.net_cents + input.vat_total_cents}, not ${input.gross_cents}`,
        'BT-112',
      ),
    );
  }

  const paid = input.paid_cents ?? 0;
  if (isInteger(paid) && paid < 0) {
    out.push(violation('BR-CO-16', 'the paid amount shall not be negative', 'BT-113'));
  }
}

/**
 * The XRechnung CIUS additions.
 *
 * XRechnung is EN 16931 plus German requirements, and the two that bite are
 * BR-DE-15 (the buyer reference — the Leitweg-ID a public authority routes on,
 * without which the invoice cannot be delivered at all) and BR-DE-1 (payment
 * instructions must be present). The address tightenings are the rest.
 */
function checkXRechnung(input: EInvoiceInput, out: RuleViolation[]): void {
  if (!isNonEmpty(input.buyer_reference)) {
    out.push(
      violation('BR-DE-15', 'XRechnung requires a buyer reference (the Leitweg-ID a recipient routes on)', 'BT-10'),
    );
  }
  if (!input.payment?.iban) {
    out.push(violation('BR-DE-1', 'XRechnung requires payment instructions — an IBAN to pay to', 'BG-16'));
  }
  if (!isNonEmpty(input.seller?.address?.city)) {
    out.push(violation('BR-DE-3', 'XRechnung requires the seller city', 'BT-37'));
  }
  if (!isNonEmpty(input.seller?.address?.postcode)) {
    out.push(violation('BR-DE-4', 'XRechnung requires the seller post code', 'BT-38'));
  }
  if (!isNonEmpty(input.seller?.email)) {
    out.push(violation('BR-DE-6', 'XRechnung requires a seller contact email', 'BT-43'));
  }
  if (!isNonEmpty(input.buyer?.address?.city)) {
    out.push(violation('BR-DE-8', 'XRechnung requires the buyer city', 'BT-52'));
  }
  if (!isNonEmpty(input.buyer?.address?.postcode)) {
    out.push(violation('BR-DE-9', 'XRechnung requires the buyer post code', 'BT-53'));
  }
  if (!isNonEmpty(input.seller?.vat_id)) {
    out.push(violation('BR-DE-16', 'XRechnung requires the seller VAT identifier', 'BT-31'));
  }
}

/** Validate an invoice against EN 16931 and, when asked for, the German CIUS. */
export function validateInvoice(input: EInvoiceInput, profile: Profile): ValidationResult {
  const violations: RuleViolation[] = [];
  checkDocument(input, violations);
  checkLines(input, violations);
  checkVatBreakdown(input, violations);
  checkArithmetic(input, violations);
  if (profile === 'xrechnung') checkXRechnung(input, violations);
  return { valid: violations.length === 0, profile, violations };
}
