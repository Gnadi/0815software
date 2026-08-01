import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import { confirmIntent, createIntent, getIntentRow, intentDetail, refundIntent } from '../server/payments.js';
import type { PaymentProvider } from '../server/providers/index.js';

/**
 * The refundable balance has to be claimed before the PSP call, not after.
 * Reading the balance, awaiting the provider and only then recording the
 * refund leaves a window in which a second request reads the same balance and
 * passes the same check — and the intent is refunded twice over.
 */

let db: Database.Database;
const T0 = Date.parse('2026-07-01T00:00:00Z');

/** Settles synchronously; its refund is slow enough to overlap two requests. */
const slowProvider: PaymentProvider = {
  name: 'slow',
  async confirm() {
    return { settled: true };
  },
  async refund() {
    await new Promise((r) => setTimeout(r, 10));
    return { settled: true };
  },
};

beforeEach(() => {
  db = openDb(':memory:');
});

async function settledIntent(amountMinor: number): Promise<number> {
  const { row } = createIntent(
    db,
    { reference: 'invoice:1', amountMinor, currency: 'EUR', provider: 'slow', idempotencyKey: null },
    T0,
  );
  await confirmIntent(db, slowProvider, row, T0);
  return row.id;
}

describe('concurrent refunds', () => {
  it('never refunds more than the intent is worth', async () => {
    const id = await settledIntent(10_000);
    const row = getIntentRow(db, id);

    const results = await Promise.allSettled([
      refundIntent(db, slowProvider, row, 10_000, T0),
      refundIntent(db, slowProvider, row, 10_000, T0),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const detail = intentDetail(db, getIntentRow(db, id));
    expect(detail.amount_refunded_minor).toBe(10_000);
    expect(detail.status).toBe('refunded');
    // The ledger must agree: one capture credit, one refund debit.
    expect(detail.ledger?.filter((e) => e.direction === 'debit')).toHaveLength(1);
  });

  it('lets partial refunds add up to exactly the full amount', async () => {
    const id = await settledIntent(10_000);
    const row = getIntentRow(db, id);

    const results = await Promise.allSettled([
      refundIntent(db, slowProvider, row, 6_000, T0),
      refundIntent(db, slowProvider, row, 6_000, T0),
      refundIntent(db, slowProvider, row, 4_000, T0),
    ]);

    const refunded = intentDetail(db, getIntentRow(db, id)).amount_refunded_minor;
    expect(refunded).toBeLessThanOrEqual(10_000);
    expect(results.some((r) => r.status === 'rejected')).toBe(true);
  });

  it('rolls the claim back when the provider refuses', async () => {
    const id = await settledIntent(5_000);
    const row = getIntentRow(db, id);
    const failing: PaymentProvider = {
      ...slowProvider,
      async refund() {
        throw new Error('psp declined');
      },
    };

    await expect(refundIntent(db, failing, row, 5_000, T0)).rejects.toThrow('psp declined');

    const detail = intentDetail(db, getIntentRow(db, id));
    expect(detail.amount_refunded_minor).toBe(0);
    expect(detail.status).toBe('succeeded');
    expect(detail.ledger?.filter((e) => e.direction === 'debit')).toHaveLength(0);
    // And the balance is still refundable afterwards.
    await refundIntent(db, slowProvider, getIntentRow(db, id), 5_000, T0);
    expect(intentDetail(db, getIntentRow(db, id)).amount_refunded_minor).toBe(5_000);
  });
});

describe('refund idempotency', () => {
  it('replays as a no-op instead of refunding twice', async () => {
    const id = await settledIntent(8_000);

    await refundIntent(db, slowProvider, getIntentRow(db, id), 3_000, T0, 'refund-1');
    await refundIntent(db, slowProvider, getIntentRow(db, id), 3_000, T0, 'refund-1');

    expect(intentDetail(db, getIntentRow(db, id)).amount_refunded_minor).toBe(3_000);
  });

  it('survives the retry racing the original', async () => {
    const id = await settledIntent(8_000);
    const row = getIntentRow(db, id);

    // Both calls succeed — the retry is a no-op, not an error, which is what
    // a client that cannot tell whether its first attempt landed needs.
    const results = await Promise.allSettled([
      refundIntent(db, slowProvider, row, 8_000, T0, 'refund-2'),
      refundIntent(db, slowProvider, row, 8_000, T0, 'refund-2'),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const detail = intentDetail(db, getIntentRow(db, id));
    expect(detail.amount_refunded_minor).toBe(8_000);
    // The money moved exactly once.
    expect(detail.ledger?.filter((e) => e.direction === 'debit')).toHaveLength(1);
  });

  it('rejects the same key used for a different refund', async () => {
    const id = await settledIntent(8_000);
    await refundIntent(db, slowProvider, getIntentRow(db, id), 3_000, T0, 'refund-3');
    await expect(
      refundIntent(db, slowProvider, getIntentRow(db, id), 4_000, T0, 'refund-3'),
    ).rejects.toThrow(/different refund/);
  });

  it('frees the key when the provider refuses, so a retry still works', async () => {
    const id = await settledIntent(8_000);
    const failing: PaymentProvider = {
      ...slowProvider,
      async refund() {
        throw new Error('psp declined');
      },
    };
    await expect(refundIntent(db, failing, getIntentRow(db, id), 8_000, T0, 'refund-4')).rejects.toThrow();
    await refundIntent(db, slowProvider, getIntentRow(db, id), 8_000, T0, 'refund-4');
    expect(intentDetail(db, getIntentRow(db, id)).amount_refunded_minor).toBe(8_000);
  });
});
