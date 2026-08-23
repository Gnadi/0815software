import { describe, expect, it } from 'vitest';
import {
  bookingKey,
  matchBookings,
  normaliseReference,
  type BankBooking,
  type OpenInvoice,
} from '../shared/matching.js';

/**
 * Matching received money against open invoices.
 *
 * This suite imports nothing but the engine — no server, no database, no
 * platform client. That is the point: receivables matching is this module's
 * own business, and a bank connection is only where the bookings happen to
 * come from today.
 */

function booking(over: Partial<BankBooking> = {}): BankBooking {
  return {
    key: 'AT61|BANKREF-1',
    amount_text: '299.99',
    amount_cents: 29999,
    currency: 'EUR',
    credit: true,
    reversal: false,
    booking_date: '2026-08-15',
    counterparty_name: 'Muster Handels GmbH',
    counterparty_iban: 'AT022050302101023600',
    remittance: null,
    creditor_reference: null,
    end_to_end_id: null,
    ...over,
  };
}

function invoice(over: Partial<OpenInvoice> = {}): OpenInvoice {
  return {
    id: 1,
    number: '2026-0042',
    customer_id: 7,
    customer_name: 'Muster Handels GmbH',
    open_cents: 29999,
    issue_date: '2026-08-01',
    due_date: '2026-08-15',
    ...over,
  };
}

describe('a booking’s identity', () => {
  it('uses the bank’s own reference, scoped to the account', () => {
    // Two accounts may legitimately carry the same bank reference.
    const a = bookingKey({ account_iban: 'AT61', account_servicer_ref: 'REF-1', booking_date: '2026-08-15', amount_text: '1.00', credit: true, end_to_end_id: null, seq: 1 });
    const b = bookingKey({ account_iban: 'DE02', account_servicer_ref: 'REF-1', booking_date: '2026-08-15', amount_text: '1.00', credit: true, end_to_end_id: null, seq: 1 });
    expect(a).not.toBe(b);
  });

  /**
   * The property that stops one arrival becoming two payments.
   *
   * A statement can be re-read from its stored bytes, which mints new row ids
   * downstream. An identity built on those would change underneath and let the
   * same money be recorded twice.
   */
  it('does not change when the delivering row does', () => {
    const bank = { account_iban: 'AT61', account_servicer_ref: 'REF-1', booking_date: '2026-08-15', amount_text: '1.00', credit: true, end_to_end_id: 'E2E', seq: 3 };
    expect(bookingKey(bank)).toBe(bookingKey({ ...bank, seq: 99 }));
  });

  it('falls back to the movement itself when a bank sends no reference', () => {
    const base = { account_iban: 'AT61', account_servicer_ref: null, booking_date: '2026-08-15', amount_text: '1.00', credit: true, end_to_end_id: null, seq: 1 };
    expect(bookingKey(base)).toBe(bookingKey({ ...base }));
    expect(bookingKey(base)).not.toBe(bookingKey({ ...base, amount_text: '2.00' }));
    expect(bookingKey(base)).not.toBe(bookingKey({ ...base, seq: 2 }));
    // A credit and a debit of the same amount on the same day are different.
    expect(bookingKey(base)).not.toBe(bookingKey({ ...base, credit: false }));
  });
});

describe('normalising a reference', () => {
  it('reduces the ways a number gets written to one', () => {
    // Banks, payment forms and customers all mangle separators differently.
    expect(normaliseReference('2026-0042')).toBe('20260042');
    expect(normaliseReference('re 2026 / 0042')).toBe('RE20260042');
  });
});

describe('what a booking is matched on', () => {
  it('takes the structured reference first — a machine filled that in', () => {
    const { proposals } = matchBookings([booking({ creditor_reference: '2026-0042' })], [invoice()]);
    expect(proposals[0]).toMatchObject({
      reason: 'creditor_reference',
      amount_cents: 29999,
      settles_invoice: true,
      uses_whole_booking: true,
    });
  });

  it('then the end-to-end id the instruction carried', () => {
    const { proposals } = matchBookings([booking({ end_to_end_id: 'INV 2026-0042' })], [invoice()]);
    expect(proposals[0]!.reason).toBe('end_to_end_id');
  });

  it('then the invoice number inside whatever the payer typed', () => {
    const { proposals } = matchBookings(
      [booking({ remittance: 'Zahlung fuer Rechnung Nr. 2026-0042, danke!' })],
      [invoice()],
    );
    expect(proposals[0]!.reason).toBe('remittance_number');
  });

  it('prefers the LONGER number, and does not also pay the one inside it', () => {
    // "RE 2026-42" contains "2026-4". Paying both would settle an invoice
    // nobody named, out of money meant for the other one.
    const { proposals } = matchBookings(
      [booking({ amount_cents: 5000, remittance: 'RE 2026-42' })],
      [
        invoice({ id: 1, number: '2026-4', open_cents: 5000 }),
        invoice({ id: 2, number: '2026-42', open_cents: 5000 }),
      ],
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.invoice.id).toBe(2);
  });

  it('falls back to customer and amount, and says that is what it did', () => {
    const { proposals } = matchBookings([booking()], [invoice(), invoice({ id: 2, number: '2026-0043', open_cents: 5000 })]);
    expect(proposals[0]).toMatchObject({ reason: 'customer_and_amount', invoice: { id: 1 } });
  });

  it('falls back to a unique amount when the name means nothing', () => {
    const { proposals } = matchBookings([booking({ counterparty_name: 'SEPA SAMMELGUTSCHRIFT' })], [invoice()]);
    expect(proposals[0]!.reason).toBe('amount_only');
  });
});

describe('what it refuses to guess', () => {
  it('reports ambiguity instead of picking one', () => {
    // Two open invoices for the same amount is ordinary. "The oldest" would be
    // a plausible tie-break that is wrong about half the time.
    const { proposals, unmatched } = matchBookings(
      [booking({ counterparty_name: null })],
      [invoice({ id: 1 }), invoice({ id: 2, number: '2026-0099' })],
    );
    expect(proposals).toEqual([]);
    expect(unmatched[0]!.why).toBe('ambiguous');
  });

  it('never proposes anything for money going OUT', () => {
    const { proposals, unmatched } = matchBookings([booking({ credit: false })], [invoice()]);
    expect(proposals).toEqual([]);
    expect(unmatched[0]!.why).toBe('debit');
  });

  it('never proposes anything for a reversal', () => {
    // Netting it off automatically would be a guess about WHICH booking it
    // reverses — and the wrong sign if that guess is wrong.
    const { unmatched } = matchBookings([booking({ reversal: true, creditor_reference: '2026-0042' })], [invoice()]);
    expect(unmatched[0]!.why).toBe('reversal');
  });

  it('skips a booking that has already been recorded', () => {
    const { proposals, unmatched } = matchBookings(
      [booking({ creditor_reference: '2026-0042' })],
      [invoice()],
      new Set(['AT61|BANKREF-1']),
    );
    expect(proposals).toEqual([]);
    expect(unmatched[0]!.why).toBe('already_applied');
  });

  it('leaves a booking alone when nothing is open for it', () => {
    const { unmatched } = matchBookings([booking({ amount_cents: 777, amount_text: '7.77' })], [invoice()]);
    expect(unmatched[0]!.why).toBe('no_candidate');
  });

  /**
   * An amount the source could not put into cents — more than two decimals,
   * or a currency whose minor unit is not a hundredth.
   *
   * Reported, never invented. An earlier version defaulted it to zero, which
   * said no money had arrived AND collapsed the identity of every such booking
   * onto one string: two of them in a day, and the second was silently treated
   * as already recorded.
   */
  it('refuses to invent an amount it could not read, and says so', () => {
    const odd = booking({ amount_cents: null, amount_text: '1.005', creditor_reference: '2026-0042' });
    const { proposals, unmatched } = matchBookings([odd], [invoice()]);
    expect(proposals).toEqual([]);
    expect(unmatched[0]!.why).toBe('amount_unreadable');
    // And the exact figure is still there for a human to read.
    expect(unmatched[0]!.booking.amount_text).toBe('1.005');
  });

  it('keeps two unreadable bookings apart, which zero would not have', () => {
    const key = (seq: number, text: string): string =>
      bookingKey({ account_iban: 'AT61', account_servicer_ref: null, booking_date: '2026-08-15', amount_text: text, credit: true, end_to_end_id: null, seq });
    expect(key(1, '1.005')).not.toBe(key(1, '2.005'));
  });
});

describe('amounts that do not line up', () => {
  it('spends one transfer across every invoice the payer named', () => {
    // A customer settling two invoices with one transfer is ordinary, and
    // calling it "ambiguous" would park the commonest multi-invoice case on
    // the operator's desk forever.
    const { proposals, unmatched } = matchBookings(
      [booking({ amount_cents: 40000, remittance: '2026-0042 und 2026-0043' })],
      [invoice({ open_cents: 29999 }), invoice({ id: 2, number: '2026-0043', open_cents: 10001 })],
    );
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({ invoice: { id: 1 }, amount_cents: 29999, settles_invoice: true });
    expect(proposals[1]).toMatchObject({ invoice: { id: 2 }, amount_cents: 10001, settles_invoice: true });
    expect(unmatched).toEqual([]);
  });

  it('stops when the transfer runs out, leaving the rest of the invoices open', () => {
    const { proposals } = matchBookings(
      [booking({ amount_cents: 30000, remittance: '2026-0042 und 2026-0043' })],
      [invoice({ open_cents: 29999 }), invoice({ id: 2, number: '2026-0043', open_cents: 10001 })],
    );
    expect(proposals).toHaveLength(2);
    expect(proposals[1]).toMatchObject({ invoice: { id: 2 }, amount_cents: 1, settles_invoice: false });
  });

  it('proposes a part payment without pretending it settles the invoice', () => {
    const { proposals } = matchBookings(
      [booking({ amount_cents: 10000, creditor_reference: '2026-0042' })],
      [invoice({ open_cents: 29999 })],
    );
    expect(proposals[0]).toMatchObject({
      amount_cents: 10000,
      settles_invoice: false,
      uses_whole_booking: true,
    });
  });

  /**
   * The invariant that stops the same invoice being settled twice in one pass.
   */
  it('does not offer the same open amount to two bookings', () => {
    const { proposals, unmatched } = matchBookings(
      [
        booking({ key: 'A', creditor_reference: '2026-0042' }),
        booking({ key: 'B', creditor_reference: '2026-0042' }),
      ],
      [invoice({ open_cents: 29999 })],
    );
    expect(proposals).toHaveLength(1);
    expect(unmatched[0]!.why).toBe('no_candidate');
  });
});
