/**
 * Matching money that arrived against invoices that are open.
 *
 * ## Why this file knows nothing about PS-12
 *
 * A booking here is `BankBooking` — a shape this module defines. It is
 * deliberately NOT the platform service's type, and this file imports nothing.
 *
 * That is the whole standalone posture in one decision. PS-12 is where the
 * bookings come from *today*, and matching them is MOD-04's own business, so
 * the rules live here and work on bookings from anywhere: a bank connection, a
 * CSV somebody exports from online banking, a future second source. Taking the
 * platform's type would have quietly made receivables matching a feature of
 * having a platform.
 *
 * ## What it does NOT do
 *
 * **It never records anything.** Every function here returns proposals; a
 * human confirms them. That is not caution for its own sake — an
 * auto-recorded payment against the wrong invoice is two wrong balances, a
 * customer chased for money they paid, and a reconciliation nobody trusts
 * afterwards. The bank is certain about the money; only a person is certain
 * about which invoice it settles.
 */

/** One booking, in the only shape this module needs to know about. */
export interface BankBooking {
  /**
   * Stable identity, from the BANK's data — see `bookingKey`.
   *
   * This is what stops one arrival becoming two payments, so it must survive
   * the bookings being fetched again, or re-read from stored bytes.
   */
  key: string;
  /**
   * Exactly what the bank wrote, unsigned. Always present.
   *
   * The authority on how much arrived, and what the identity is built from —
   * because it is the only amount that cannot have been lost in a conversion.
   */
  amount_text: string;
  /**
   * The same amount in cents, or **null when the source could not express it**
   * — more than two decimal places, or a currency whose minor unit is not a
   * hundredth.
   *
   * Null rather than zero. An earlier version defaulted to `0`, which made a
   * booking look like no money at all AND collapsed the identity of every such
   * booking to the same string: two of them on one day, and the second was
   * silently treated as already recorded. A number that might be wrong is
   * worse here than an absent one.
   */
  amount_cents: number | null;
  currency: string;
  /** True when money came IN. Only credits can settle a receivable. */
  credit: boolean;
  /** True when this booking undoes an earlier one. */
  reversal: boolean;
  booking_date: string | null;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  /** Free text the payer wrote. Usually where the invoice number is. */
  remittance: string | null;
  /**
   * How many payments a COLLECTIVE booking covers; null for an ordinary one.
   *
   * One movement on the account carrying many customers' payments. The
   * reference fields are null on such a booking — they belong to the
   * individual payments inside it — so there is nothing here to match on, and
   * pretending otherwise would attribute the whole sum to one customer.
   */
  batch_count: number | null;
  /** A structured creditor reference, when the payer used one. */
  creditor_reference: string | null;
  /** The reference from the original instruction, when the bank passes it on. */
  end_to_end_id: string | null;
}

/** An invoice that still wants money. */
export interface OpenInvoice {
  id: number;
  /** The number a customer quotes, e.g. "2026-0042". Never null when sent. */
  number: string;
  customer_id: number;
  customer_name: string;
  /** What is still open, in cents. Always positive for a candidate. */
  open_cents: number;
  issue_date: string | null;
  due_date: string | null;
}

/**
 * How a proposal was arrived at, strongest first.
 *
 * The reason travels with the proposal because a human confirming twenty of
 * these needs to know which ones to actually look at. "The payer quoted the
 * invoice number" and "this is the only open invoice for that amount" deserve
 * very different amounts of attention.
 */
export type MatchReason =
  /** The payer used the structured reference field, and it is the number. */
  | 'creditor_reference'
  /** The original instruction carried the invoice number. */
  | 'end_to_end_id'
  /** The invoice number appears in the free text. */
  | 'remittance_number'
  /** Exactly one open invoice of that customer has exactly that amount. */
  | 'customer_and_amount'
  /** Exactly one open invoice anywhere has exactly that amount. */
  | 'amount_only';

/** Strongest first — the order proposals are offered in. */
export const MATCH_REASONS: readonly MatchReason[] = [
  'creditor_reference',
  'end_to_end_id',
  'remittance_number',
  'customer_and_amount',
  'amount_only',
];

export interface MatchProposal {
  booking: BankBooking;
  invoice: OpenInvoice;
  reason: MatchReason;
  /**
   * What to record if confirmed: the booking, capped at what is still open.
   *
   * Capping rather than refusing, because a customer paying two invoices with
   * one transfer is ordinary. The remainder stays on the booking and can be
   * applied to the next invoice.
   */
  amount_cents: number;
  /**
   * True when this proposal closes the invoice.
   *
   * Two separate questions, because they answer differently and a human
   * confirming twenty of these needs both: this one is "is the invoice done?",
   * and `uses_whole_booking` is "is there money left over to place elsewhere?".
   * A collective payment settles the first invoice fully and leaves money; a
   * part payment uses the whole booking and leaves the invoice open.
   */
  settles_invoice: boolean;
  /** True when the whole booking went into this proposal. */
  uses_whole_booking: boolean;
}

/** A booking nothing could be proposed for, and the reason it was skipped. */
export interface UnmatchedBooking {
  booking: BankBooking;
  why:
    | 'debit'
    | 'reversal'
    | 'already_applied'
    | 'no_candidate'
    | 'ambiguous'
    | 'amount_unreadable'
    | 'collective';
}

export interface MatchResult {
  proposals: MatchProposal[];
  unmatched: UnmatchedBooking[];
}

/**
 * A booking's identity, built from what the BANK said.
 *
 * Not from the row id of whatever delivered it. A statement can be re-read
 * from its stored bytes — which is a feature, and which mints new row ids —
 * and an identity that changed underneath would let one arrival be recorded
 * as a payment twice.
 *
 * `AcctSvcrRef` is the bank's own reference for the booking and is the right
 * answer where there is one (the Austrian schema makes it mandatory). Where a
 * bank omits it, the fallback is the fields that together describe the
 * movement. Both are prefixed with the account, because two accounts may
 * legitimately carry the same bank reference.
 */
export function bookingKey(input: {
  account_iban: string | null;
  account_servicer_ref: string | null;
  booking_date: string | null;
  /** Exactly what the bank wrote. See the note inside. */
  amount_text: string;
  credit: boolean;
  end_to_end_id: string | null;
  /** Position within the statement — the last resort for telling two apart. */
  seq: number;
}): string {
  const account = input.account_iban ?? 'unknown-account';
  if (input.account_servicer_ref !== null && input.account_servicer_ref.trim() !== '') {
    return `${account}|${input.account_servicer_ref.trim()}`;
  }
  // The amount as the BANK wrote it, not a converted one: a conversion that
  // failed would otherwise fold every unconvertible booking onto one identity.
  return [
    account,
    input.booking_date ?? 'undated',
    input.amount_text,
    input.credit ? 'C' : 'D',
    input.end_to_end_id ?? '',
    String(input.seq),
  ].join('|');
}

/**
 * Normalise a reference for comparison.
 *
 * Upper-cased with every non-alphanumeric character removed, so that
 * `2026-0042`, `2026 0042` and `RE2026/0042` all reduce to something an
 * invoice number can be found inside. Banks, payment forms and customers all
 * mangle separators differently, and a matcher that insisted on the exact
 * string would match almost nothing.
 */
export function normaliseReference(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Propose a match for each booking.
 *
 * `appliedKeys` are bookings already recorded — passed in rather than looked
 * up, so this stays a pure function and so the caller decides what "already"
 * means.
 */
export function matchBookings(
  bookings: BankBooking[],
  invoices: OpenInvoice[],
  appliedKeys: ReadonlySet<string> = new Set(),
): MatchResult {
  const proposals: MatchProposal[] = [];
  const unmatched: UnmatchedBooking[] = [];

  // What is still claimable per invoice, decremented as proposals are made, so
  // two bookings cannot both be proposed for the whole of one invoice.
  const remaining = new Map<number, number>(invoices.map((i) => [i.id, i.open_cents]));

  for (const booking of bookings) {
    if (!booking.credit) {
      // Money going out is a payment we made, not one we received.
      unmatched.push({ booking, why: 'debit' });
      continue;
    }
    if (booking.reversal) {
      // A reversal undoes an earlier booking. Recording it as income would be
      // the wrong sign, and netting it off automatically would be a guess
      // about WHICH booking it reverses.
      unmatched.push({ booking, why: 'reversal' });
      continue;
    }
    if (appliedKeys.has(booking.key)) {
      unmatched.push({ booking, why: 'already_applied' });
      continue;
    }
    if (booking.batch_count !== null && booking.batch_count > 1) {
      // A collective credit is real money and needs splitting across the
      // customers inside it — work no rule here can do, because the bank did
      // not say which payment was whose in a form this booking carries. It is
      // surfaced so an operator splits it, never guessed at.
      unmatched.push({ booking, why: 'collective' });
      continue;
    }
    if (booking.amount_cents === null || booking.amount_cents <= 0) {
      // The money is real and the amount is on the screen; what is missing is
      // a cent figure to record. Surfaced rather than dropped, so an operator
      // can enter it by hand instead of wondering where it went.
      unmatched.push({ booking, why: 'amount_unreadable' });
      continue;
    }

    const found = candidatesFor(booking, invoices, remaining);
    if (found === 'ambiguous') {
      unmatched.push({ booking, why: 'ambiguous' });
      continue;
    }
    if (found === null) {
      unmatched.push({ booking, why: 'no_candidate' });
      continue;
    }

    // A collective payment settles several invoices, so one booking can yield
    // several proposals — spent across them in the order they were named,
    // until the money runs out.
    let left = booking.amount_cents;
    let made = 0;
    for (const invoice of found.invoices) {
      if (left <= 0) break;
      const open = remaining.get(invoice.id) ?? 0;
      const amount = Math.min(left, open);
      if (amount <= 0) continue;
      remaining.set(invoice.id, open - amount);
      left -= amount;
      made += 1;
      proposals.push({
        booking,
        invoice,
        reason: found.reason,
        amount_cents: amount,
        settles_invoice: amount === open,
        uses_whole_booking: amount === booking.amount_cents,
      });
    }
    if (made === 0) unmatched.push({ booking, why: 'no_candidate' });
  }

  return { proposals, unmatched };
}

/**
 * The invoices one booking should be offered against, in order.
 *
 * A LIST rather than a single invoice, because a payer naming two invoice
 * numbers in one transfer is settling both — a collective payment, not an
 * ambiguity. Treating that as "I cannot tell" would leave the commonest
 * multi-invoice case permanently on the operator's desk.
 *
 * Ambiguity is a different thing and is still reported rather than resolved:
 * it is what the WEAK rules run into, where several invoices fit an amount and
 * nothing distinguishes them. Picking "the oldest" there would be a plausible
 * tie-break that is wrong about half the time, and the human looking at the
 * screen can tell in a second what no rule can.
 */
function candidatesFor(
  booking: BankBooking,
  invoices: OpenInvoice[],
  remaining: Map<number, number>,
): { invoices: OpenInvoice[]; reason: MatchReason } | null | 'ambiguous' {
  const live = invoices.filter((i) => (remaining.get(i.id) ?? 0) > 0);
  if (live.length === 0) return null;

  // 1–3: the payer told us which invoice this is. Reference fields first,
  // because they are the ones a payment system fills in mechanically; free
  // text is last because it is the one a human types.
  const quoted = [
    ['creditor_reference', booking.creditor_reference] as const,
    ['end_to_end_id', booking.end_to_end_id] as const,
    ['remittance_number', booking.remittance] as const,
  ];
  for (const [reason, value] of quoted) {
    if (value === null || value.trim() === '') continue;
    const haystack = normaliseReference(value);
    const hits = live.filter((invoice) => haystack.includes(normaliseReference(invoice.number)));
    if (hits.length === 0) continue;
    // Longest number first, for two reasons: "2026-4" must not be paid before
    // "2026-42" when the text names the longer one and both are open, and a
    // shorter number contained inside a longer one is the weaker reading.
    const ordered = [...hits].sort(
      (a, b) => normaliseReference(b.number).length - normaliseReference(a.number).length,
    );
    // A number wholly contained in another that was also named is almost
    // certainly not a second invoice — drop it rather than pay it.
    const kept = ordered.filter(
      (invoice, index) =>
        !ordered
          .slice(0, index)
          .some((longer) => normaliseReference(longer.number).includes(normaliseReference(invoice.number))),
    );
    return { invoices: kept, reason: reason as MatchReason };
  }

  // 4: the amount, narrowed to a customer we recognised by name. Weaker,
  // because a name on a bank statement is whatever the payer's bank prints.
  const byName =
    booking.counterparty_name === null
      ? []
      : live.filter(
          (invoice) =>
            normaliseReference(invoice.customer_name) === normaliseReference(booking.counterparty_name as string),
        );
  const nameAndAmount = byName.filter((i) => (remaining.get(i.id) ?? 0) === booking.amount_cents);
  if (nameAndAmount.length === 1) return { invoices: nameAndAmount, reason: 'customer_and_amount' };
  if (nameAndAmount.length > 1) return 'ambiguous';

  // 5: the amount alone, and ONLY when it is unique across everything open.
  // Two invoices for the same amount is common enough that guessing would be
  // wrong regularly rather than rarely.
  const byAmount = live.filter((i) => (remaining.get(i.id) ?? 0) === booking.amount_cents);
  if (byAmount.length === 1) return { invoices: byAmount, reason: 'amount_only' };
  if (byAmount.length > 1) return 'ambiguous';

  return null;
}
