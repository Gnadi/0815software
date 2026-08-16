import type { CaseCategory, CaseOutcome, CaseStatus } from '../shared/types.js';

/**
 * The policy of this module, in ONE file — the MOD-06 / MOD-10 / MOD-14 /
 * MOD-15 pattern.
 *
 * Unlike those, most of what is here is not a company preference. The two
 * deadlines are statutory, and getting them wrong is the failure this module
 * exists to prevent:
 *
 * - **Seven days to acknowledge receipt.** § 17 Abs. 1 HinSchG, transposing
 *   Art. 9(1)(b) of Directive (EU) 2019/1937.
 * - **Three months to give feedback.** § 17 Abs. 2 HinSchG / Art. 9(1)(f).
 *   Measured from the acknowledgement — and, when no acknowledgement was
 *   ever sent, from the expiry of the seven-day window instead. That
 *   fallback is in the directive itself, and it is the whole point: failing
 *   to acknowledge does not postpone the feedback obligation, it starts it.
 * - **Three years of retention.** § 11 Abs. 5 HinSchG: the documentation is
 *   deleted three years after the procedure was concluded. Longer only where
 *   another law requires it, which is a decision for the operator — hence a
 *   constant here rather than something hard-coded in a query.
 *
 * The warning windows below are the only genuinely discretionary numbers.
 */

/** § 17 Abs. 1 HinSchG — acknowledge receipt within seven days. */
export const ACKNOWLEDGE_DAYS = 7;

/** § 17 Abs. 2 HinSchG — feedback within three months. */
export const FEEDBACK_MONTHS = 3;

/** § 11 Abs. 5 HinSchG — erase the documentation three years after closure. */
export const RETENTION_YEARS = 3;

/** How long before a deadline it starts showing as at-risk. Discretionary. */
export const ACKNOWLEDGE_WARN_DAYS = 2;
export const FEEDBACK_WARN_DAYS = 14;

export interface CategoryDef {
  key: CaseCategory;
  label: string;
  /** Shown on the public intake form so a reporter can pick correctly. */
  hint: string;
}

/**
 * Report categories, drawn from the material scope of § 2 HinSchG and
 * Annex I of the directive. Deliberately broad and few: a reporter who
 * cannot find their case in the list picks "other" and writes it down, which
 * is better than a taxonomy so fine that nobody classifies correctly.
 */
export const CATEGORIES: CategoryDef[] = [
  { key: 'corruption', label: 'Korruption / Bribery & corruption', hint: 'Kickbacks, bribes, improper gifts, conflicts of interest.' },
  { key: 'fraud', label: 'Betrug & Bilanz / Fraud & accounting', hint: 'Misappropriation, false invoicing, manipulated accounts.' },
  { key: 'procurement', label: 'Vergabe / Public procurement', hint: 'Rigged tenders, undisclosed ties to bidders.' },
  { key: 'competition', label: 'Kartellrecht / Competition law', hint: 'Price fixing, market allocation, abuse of a dominant position.' },
  { key: 'data_protection', label: 'Datenschutz / Data protection', hint: 'Unlawful processing, undisclosed breaches, unauthorised access.' },
  { key: 'product_safety', label: 'Produktsicherheit / Product safety', hint: 'Unsafe products, suppressed defect reports.' },
  { key: 'environment', label: 'Umwelt / Environmental protection', hint: 'Unlawful emissions, waste handling, permit breaches.' },
  { key: 'workplace_safety', label: 'Arbeitsschutz / Workplace safety', hint: 'Unsafe conditions, suppressed incident reports.' },
  { key: 'discrimination', label: 'Diskriminierung & Belästigung / Discrimination & harassment', hint: 'Harassment, bullying, discriminatory treatment.' },
  { key: 'other', label: 'Sonstiges / Other', hint: 'Anything else that may be a breach of law or internal rules.' },
];

const CATEGORY_KEYS = new Set(CATEGORIES.map((category) => category.key));

export function isCategory(value: unknown): value is CaseCategory {
  return typeof value === 'string' && CATEGORY_KEYS.has(value as CaseCategory);
}

export function categoryLabel(key: string): string {
  return CATEGORIES.find((category) => category.key === key)?.label ?? key;
}

/**
 * The case lifecycle.
 *
 * `received → acknowledged` is not a formality: it is the § 17 Abs. 1 act,
 * and it is what starts the feedback clock. Closing a case that was never
 * acknowledged is therefore refused (409) rather than allowed with a
 * warning — a closed case nobody can reopen would bury the fact that the
 * statutory acknowledgement never happened.
 */
export const TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  received: ['acknowledged'],
  acknowledged: ['investigating', 'closed'],
  investigating: ['closed'],
  closed: [],
};

export interface OutcomeDef {
  key: CaseOutcome;
  label: string;
}

/**
 * Why a case was closed. Required at closure — "closed" without a reason is
 * the state a report ends up in when nobody wants to write down what was
 * decided, and it is exactly what an audit asks about.
 */
export const OUTCOMES: OutcomeDef[] = [
  { key: 'substantiated', label: 'Substantiated — the report was borne out' },
  { key: 'partly_substantiated', label: 'Partly substantiated' },
  { key: 'unsubstantiated', label: 'Unsubstantiated — no breach found' },
  { key: 'out_of_scope', label: 'Out of scope — not a matter for this channel' },
  { key: 'referred', label: 'Referred — handed to an authority or another body' },
  { key: 'insufficient_information', label: 'Insufficient information to proceed' },
];

const OUTCOME_KEYS = new Set(OUTCOMES.map((outcome) => outcome.key));

export function isOutcome(value: unknown): value is CaseOutcome {
  return typeof value === 'string' && OUTCOME_KEYS.has(value as CaseOutcome);
}

// Config that would silently misbehave is refused at import time, the way
// MOD-15's absence types and MOD-14's status workflow are.
const seen = new Set<string>();
for (const category of CATEGORIES) {
  if (seen.has(category.key)) throw new Error(`case-config: duplicate category ${category.key}`);
  seen.add(category.key);
}
if (!CATEGORY_KEYS.has('other')) throw new Error('case-config: the "other" category is required');
if (ACKNOWLEDGE_WARN_DAYS >= ACKNOWLEDGE_DAYS) {
  throw new Error('case-config: the acknowledgement warning window must be shorter than the deadline');
}
