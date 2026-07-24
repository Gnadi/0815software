import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildPlatform, noopPlatform, type PayOrderInfo, type PlatformHooks } from '../server/platform.js';
import type { AuthConfig } from '../server/auth.js';

const auth: AuthConfig = { username: 'admin', password: 'test-password', secret: 'test-secret', ttlHours: 1, secureCookie: false };

let db: Database.Database;

function appWith(platform: PlatformHooks): Express {
  return createApp({ db, auth, platform });
}

/** An in-stock seeded product id to buy. */
function someProductId(): number {
  return (db.prepare('SELECT id FROM products WHERE stock > 0 ORDER BY id LIMIT 1').get() as { id: number }).id;
}

/** Add one unit of a product to a fresh guest cart and check out. */
async function checkout(app: Express) {
  const agent = request.agent(app);
  await agent.post('/api/shop/cart/items').send({ product_id: someProductId(), quantity: 1 }).expect(201);
  return agent.post('/api/shop/checkout').send({ name: 'Buyer', email: 'b@example.at', address: 'Teststr. 1' });
}

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
});

describe('checkout payment via PS-08', () => {
  it('passes the order total to payOrder and marks the order paid on success', async () => {
    const calls: PayOrderInfo[] = [];
    const app = appWith({
      async payOrder(info) {
        calls.push(info);
        return { status: 'succeeded', public_id: 'pi_1' };
      },
    });
    const res = await checkout(app);
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ref).toBe(res.body.ref);
    expect(calls[0]!.amountMinor).toBe(res.body.order.totals.gross_cents);
    expect(res.body.payment.status).toBe('succeeded');
    expect(res.body.order.payment_status).toBe('paid');
  });

  it('leaves the order unpaid when the intent is still processing', async () => {
    const app = appWith({
      async payOrder() {
        return { status: 'processing', public_id: 'pi_2' };
      },
    });
    const res = await checkout(app);
    expect(res.body.payment.status).toBe('processing');
    expect(res.body.order.payment_status).toBe('unpaid');
  });

  it('is standalone (order placed unpaid, no payment) when Payments is unset', async () => {
    expect(buildPlatform({})).toBe(noopPlatform);
    const res = await checkout(createApp({ db, auth })); // default noop
    expect(res.status).toBe(201);
    expect(res.body.payment).toBeNull();
    expect(res.body.order.payment_status).toBe('unpaid');
  });

  it('a failing payments call never fails the checkout (best-effort)', async () => {
    const app = appWith({
      async payOrder() {
        throw new Error('payments down');
      },
    });
    const res = await checkout(app);
    expect(res.status).toBe(201); // order still placed
    expect(res.body.order.payment_status).toBe('unpaid');
  });
});
