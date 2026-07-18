import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { AuthConfig } from '../server/auth.js';
import { computeTotals } from '../shared/money.js';
import type { Cart, GuestOrder, OrderDetail, Product } from '../shared/types.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

let db: Database.Database;
let app: Express;
let cookie: string;
let skuSeq = 0;

/** Create a product through the admin API; returns the stored row. */
async function createProduct(overrides: Record<string, unknown> = {}): Promise<Product> {
  const res = await request(app)
    .post('/api/admin/products')
    .set('Cookie', cookie)
    .send({
      sku: `TEST-${++skuSeq}`,
      name: `Test Product ${skuSeq}`,
      unit_price_cents: 1_000,
      vat_rate: 20,
      stock: 10,
      category_id: 1,
      ...overrides,
    });
  expect(res.status).toBe(201);
  return res.body as Product;
}

function stockOf(productId: number): number {
  return (db.prepare('SELECT stock FROM products WHERE id = ?').get(productId) as { stock: number })
    .stock;
}

/** A shop session with its own anonymous cart cookie. */
function guest() {
  return request.agent(app);
}

/** Fill a fresh guest cart and check out; returns ref + token + guest order. */
async function placeOrder(
  lines: { product_id: number; quantity: number }[],
  customer: Record<string, unknown> = {},
): Promise<{ ref: string; token: string; order: GuestOrder; agent: ReturnType<typeof guest> }> {
  const agent = guest();
  for (const line of lines) {
    const res = await agent.post('/api/shop/cart/items').send(line);
    expect(res.status).toBe(201);
  }
  const res = await agent.post('/api/shop/checkout').send({
    name: 'Test Buyer',
    email: 'buyer@example.at',
    address: 'Teststraße 1\n1010 Wien',
    ...customer,
  });
  expect(res.status).toBe(201);
  return { ...(res.body as { ref: string; token: string; order: GuestOrder }), agent };
}

function orderIdOf(ref: string): number {
  return (db.prepare('SELECT id FROM orders WHERE ref = ?').get(ref) as { id: number }).id;
}

async function adminOrder(id: number): Promise<OrderDetail> {
  const res = await request(app).get(`/api/admin/orders/${id}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as OrderDetail;
}

beforeAll(async () => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, auth });

  const res = await request(app)
    .post('/api/admin/login')
    .send({ username: 'admin', password: 'test-password' });
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
});

describe('auth', () => {
  it('rejects unauthenticated admin requests with 401', async () => {
    for (const path of [
      '/api/admin/products',
      '/api/admin/categories',
      '/api/admin/orders',
      '/api/admin/orders/1',
      '/api/admin/orders/export.csv',
      '/api/admin/me',
    ]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
    }
    const post = await request(app).post('/api/admin/products').send({});
    expect(post.status).toBe(401);
    const transition = await request(app).post('/api/admin/orders/1/status').send({ status: 'confirmed' });
    expect(transition.status).toBe(401);
  });

  it('rejects bad credentials', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({ username: 'admin', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('accepts good credentials and sets an HttpOnly session cookie', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({ username: 'admin', password: 'test-password' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']![0]).toContain('mod07_session=');
    expect(res.headers['set-cookie']![0]).toContain('HttpOnly');
  });
});

describe('public catalogue (no login required)', () => {
  it('lists products and categories without any auth', async () => {
    const products = await request(app).get('/api/shop/products');
    expect(products.status).toBe(200);
    expect(products.body.products.length).toBeGreaterThanOrEqual(12);
    const categories = await request(app).get('/api/shop/categories');
    expect(categories.status).toBe(200);
    expect(categories.body.categories.length).toBeGreaterThanOrEqual(3);
  });

  it('filters by category and searches by name/sku/description', async () => {
    const cat = (
      db.prepare("SELECT id FROM categories WHERE name = 'Paper Goods'").get() as { id: number }
    ).id;
    const byCat = await request(app).get(`/api/shop/products?category=${cat}`);
    expect(byCat.status).toBe(200);
    expect(byCat.body.products.length).toBe(4);
    expect(byCat.body.products.every((p: { category_id: number }) => p.category_id === cat)).toBe(true);

    const bySearch = await request(app).get('/api/shop/products?search=task lamp');
    expect(bySearch.body.products.map((p: { sku: string }) => p.sku)).toEqual(['WS-LAMP']);
  });

  it('serves a product detail and 404s on unknown ids', async () => {
    const detail = await request(app).get('/api/shop/products/1');
    expect(detail.status).toBe(200);
    expect(detail.body.category_name).toBeTruthy();
    const missing = await request(app).get('/api/shop/products/99999');
    expect(missing.status).toBe(404);
  });

  it('hides archived products from the shop but keeps them for the admin', async () => {
    const product = await createProduct({ archived: true });
    const pub = await request(app).get(`/api/shop/products/${product.id}`);
    expect(pub.status).toBe(404);
    const adm = await request(app).get(`/api/admin/products/${product.id}`).set('Cookie', cookie);
    expect(adm.status).toBe(200);
  });
});

describe('cart', () => {
  it('starts empty without a cookie and stays empty on a tampered cookie', async () => {
    const empty = await request(app).get('/api/shop/cart');
    expect(empty.status).toBe(200);
    expect(empty.body.lines).toEqual([]);

    const tampered = await request(app)
      .get('/api/shop/cart')
      .set('Cookie', 'mod07_cart=1.deadbeefdeadbeef');
    expect(tampered.status).toBe(200);
    expect(tampered.body.lines).toEqual([]);
  });

  it('adds items, sets a signed cart cookie, and derives totals', async () => {
    const product = await createProduct({ unit_price_cents: 1_490, stock: 10 });
    const agent = guest();
    const res = await agent
      .post('/api/shop/cart/items')
      .send({ product_id: product.id, quantity: 2 });
    expect(res.status).toBe(201);
    expect(res.headers['set-cookie']![0]).toContain('mod07_cart=');
    expect(res.headers['set-cookie']![0]).toContain('HttpOnly');
    const cart = res.body as Cart;
    expect(cart.item_count).toBe(2);
    expect(cart.lines[0]!.line_gross_cents).toBe(2_980);
    expect(cart.totals.gross_cents).toBe(2_980);
    // Adding again accumulates in the same line.
    const again = await agent
      .post('/api/shop/cart/items')
      .send({ product_id: product.id, quantity: 1 });
    expect((again.body as Cart).lines).toHaveLength(1);
    expect((again.body as Cart).item_count).toBe(3);
  });

  it('rejects adding more than the available stock with a 422 naming the available qty', async () => {
    const product = await createProduct({ stock: 3 });
    const agent = guest();
    const res = await agent
      .post('/api/shop/cart/items')
      .send({ product_id: product.id, quantity: 4 });
    expect(res.status).toBe(422);
    expect(res.body.items).toEqual([
      expect.objectContaining({ product_id: product.id, requested: 4, available: 3 }),
    ]);
    // Cumulative over-add is caught too: 2 in the cart, 2 more requested.
    await agent.post('/api/shop/cart/items').send({ product_id: product.id, quantity: 2 });
    const cumulative = await agent
      .post('/api/shop/cart/items')
      .send({ product_id: product.id, quantity: 2 });
    expect(cumulative.status).toBe(422);
    expect(cumulative.body.items[0]).toMatchObject({ requested: 4, available: 3 });
  });

  it('updates and removes lines, validating quantity changes against stock', async () => {
    const product = await createProduct({ stock: 5 });
    const agent = guest();
    await agent.post('/api/shop/cart/items').send({ product_id: product.id, quantity: 1 });

    const over = await agent.put(`/api/shop/cart/items/${product.id}`).send({ quantity: 9 });
    expect(over.status).toBe(422);

    const ok = await agent.put(`/api/shop/cart/items/${product.id}`).send({ quantity: 5 });
    expect(ok.status).toBe(200);
    expect((ok.body as Cart).item_count).toBe(5);

    const gone = await agent.delete(`/api/shop/cart/items/${product.id}`);
    expect(gone.status).toBe(200);
    expect((gone.body as Cart).lines).toEqual([]);
  });
});

describe('checkout', () => {
  it('validates the customer fields', async () => {
    const res = await request(app).post('/api/shop/checkout').send({ name: '', email: 'nope', address: '' });
    expect(res.status).toBe(422);
    const fields = (res.body.details as { field: string }[]).map((d) => d.field);
    expect(fields).toContain('name');
    expect(fields).toContain('email');
    expect(fields).toContain('address');
  });

  it('rejects an empty cart with 422', async () => {
    const res = await request(app)
      .post('/api/shop/checkout')
      .send({ name: 'A B', email: 'a@b.co', address: 'Somewhere 1' });
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe('cart');
  });

  it('places the order, decrements stock, clears the cart, and hands out ref + token', async () => {
    const product = await createProduct({ stock: 10, unit_price_cents: 2_000 });
    const { ref, token, order, agent } = await placeOrder([{ product_id: product.id, quantity: 3 }]);

    expect(ref).toMatch(/^ORD-\d{4}-\d{4}$/);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(order.status).toBe('placed');
    expect(order.payment_status).toBe('unpaid');
    expect(order.totals.gross_cents).toBe(6_000);
    expect(stockOf(product.id)).toBe(7);

    // The cart is gone and its cookie was cleared.
    const cart = await agent.get('/api/shop/cart');
    expect((cart.body as Cart).lines).toEqual([]);
  });

  it('SNAPSHOTS prices: a later price change never alters an existing order', async () => {
    const product = await createProduct({ stock: 10, unit_price_cents: 1_000, vat_rate: 20 });
    const { ref, token } = await placeOrder([{ product_id: product.id, quantity: 2 }]);
    const before = await request(app).get(`/api/shop/orders/${ref}?token=${token}`);
    expect(before.body.totals.gross_cents).toBe(2_000);

    // Admin re-prices the product drastically.
    const reprice = await request(app)
      .put(`/api/admin/products/${product.id}`)
      .set('Cookie', cookie)
      .send({ ...product, unit_price_cents: 99_900 });
    expect(reprice.status).toBe(200);

    // The catalogue changed; the order did not.
    const shopNow = await request(app).get(`/api/shop/products/${product.id}`);
    expect(shopNow.body.unit_price_cents).toBe(99_900);
    const after = await request(app).get(`/api/shop/orders/${ref}?token=${token}`);
    expect(after.body.totals.gross_cents).toBe(2_000);
    expect(after.body.lines[0].unit_price_cents).toBe(1_000);
    const detail = await adminOrder(orderIdOf(ref));
    expect(detail.gross_cents).toBe(2_000);
  });

  it('is ATOMIC: one short line fails the whole checkout and decrements nothing', async () => {
    const a = await createProduct({ stock: 5 });
    const b = await createProduct({ stock: 3 });
    const agent = guest();
    await agent.post('/api/shop/cart/items').send({ product_id: a.id, quantity: 2 });
    await agent.post('/api/shop/cart/items').send({ product_id: b.id, quantity: 3 });

    // Stock moves under the cart: b drops to 1 — the cart is now overcommitted.
    await request(app)
      .post(`/api/admin/products/${b.id}/stock`)
      .set('Cookie', cookie)
      .send({ delta: -2 });

    const ordersBefore = (db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
    const res = await agent.post('/api/shop/checkout').send({
      name: 'Race Condition',
      email: 'race@example.at',
      address: 'Somewhere 2',
    });
    expect(res.status).toBe(422);
    // Only the offending line is reported…
    expect(res.body.items).toEqual([
      expect.objectContaining({ product_id: b.id, requested: 3, available: 1 }),
    ]);
    // …and NOTHING was decremented or created — not even for the fulfillable line.
    expect(stockOf(a.id)).toBe(5);
    expect(stockOf(b.id)).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n).toBe(ordersBefore);

    // The cart survives untouched so the guest can adjust it.
    const cart = await agent.get('/api/shop/cart');
    expect((cart.body as Cart).lines).toHaveLength(2);
  });
});

describe('totals are derived from snapshot lines (gross prices, VAT extracted per rate)', () => {
  it('computes the per-rate breakdown for mixed VAT rates', async () => {
    const x = await createProduct({ unit_price_cents: 1_999, vat_rate: 20, stock: 10 });
    const y = await createProduct({ unit_price_cents: 990, vat_rate: 10, stock: 10 });
    const z = await createProduct({ unit_price_cents: 500, vat_rate: 0, stock: 10 });
    const { ref, token } = await placeOrder([
      { product_id: x.id, quantity: 2 },
      { product_id: y.id, quantity: 1 },
      { product_id: z.id, quantity: 3 },
    ]);
    const res = await request(app).get(`/api/shop/orders/${ref}?token=${token}`);
    const order = res.body as GuestOrder;
    // 20%: gross 3998 → net round(3998·100/120) = 3332 → VAT 666
    // 10%: gross  990 → net round(990·100/110)  =  900 → VAT  90
    //  0%: gross 1500 → net 1500 → VAT 0
    expect(order.totals.by_rate).toEqual([
      { rate: 0, gross_cents: 1_500, net_cents: 1_500, vat_cents: 0 },
      { rate: 10, gross_cents: 990, net_cents: 900, vat_cents: 90 },
      { rate: 20, gross_cents: 3_998, net_cents: 3_332, vat_cents: 666 },
    ]);
    expect(order.totals.gross_cents).toBe(6_488);
    expect(order.totals.vat_cents).toBe(756);
    expect(order.totals.net_cents).toBe(5_732);
    // The API agrees with the one shared money function, line for line.
    expect(order.totals).toEqual(computeTotals(order.lines));
  });
});

describe('guest order lookup (signed token, no account)', () => {
  it('serves the order with the correct token', async () => {
    const product = await createProduct({ stock: 5 });
    const { ref, token } = await placeOrder([{ product_id: product.id, quantity: 1 }]);
    const res = await request(app).get(`/api/shop/orders/${ref}?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ref).toBe(ref);
    expect(res.body.events.map((e: { status: string }) => e.status)).toEqual(['placed']);
  });

  it('404s on a wrong token, a missing token, and an unknown ref — indistinguishably', async () => {
    const product = await createProduct({ stock: 5 });
    const { ref, token } = await placeOrder([{ product_id: product.id, quantity: 1 }]);

    const wrong = await request(app).get(`/api/shop/orders/${ref}?token=${'0'.repeat(64)}`);
    expect(wrong.status).toBe(404);
    const missing = await request(app).get(`/api/shop/orders/${ref}`);
    expect(missing.status).toBe(404);
    const unknownRef = await request(app).get(`/api/shop/orders/ORD-1999-0001?token=${token}`);
    expect(unknownRef.status).toBe(404);
    expect(wrong.body).toEqual(unknownRef.body);
  });
});

describe('order lifecycle', () => {
  it('walks placed → confirmed → shipped → delivered, appending events', async () => {
    const product = await createProduct({ stock: 5 });
    const { ref } = await placeOrder([{ product_id: product.id, quantity: 1 }]);
    const id = orderIdOf(ref);
    for (const status of ['confirmed', 'shipped', 'delivered'] as const) {
      const res = await request(app)
        .post(`/api/admin/orders/${id}/status`)
        .set('Cookie', cookie)
        .send({ status });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(status);
    }
    const detail = await adminOrder(id);
    expect(detail.events.map((e) => e.status)).toEqual(['placed', 'confirmed', 'shipped', 'delivered']);
    // Terminal: no further transitions.
    const more = await request(app)
      .post(`/api/admin/orders/${id}/status`)
      .set('Cookie', cookie)
      .send({ status: 'delivered' });
    expect(more.status).toBe(409);
  });

  it('rejects skipping a step: delivered before shipped is a 422', async () => {
    const product = await createProduct({ stock: 5 });
    const { ref } = await placeOrder([{ product_id: product.id, quantity: 1 }]);
    const res = await request(app)
      .post(`/api/admin/orders/${orderIdOf(ref)}/status`)
      .set('Cookie', cookie)
      .send({ status: 'delivered' });
    expect(res.status).toBe(422);
    expect(res.body.details[0].message).toContain('confirmed');
    const backwards = await request(app)
      .post(`/api/admin/orders/${orderIdOf(ref)}/status`)
      .set('Cookie', cookie)
      .send({ status: 'placed' });
    expect(backwards.status).toBe(422);
  });

  it('cancelling an unshipped order RESTORES the stock (and is final)', async () => {
    const product = await createProduct({ stock: 10 });
    const { ref } = await placeOrder([{ product_id: product.id, quantity: 4 }]);
    expect(stockOf(product.id)).toBe(6);

    const id = orderIdOf(ref);
    const res = await request(app).post(`/api/admin/orders/${id}/cancel`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(stockOf(product.id)).toBe(10);

    const again = await request(app).post(`/api/admin/orders/${id}/cancel`).set('Cookie', cookie);
    expect(again.status).toBe(409);
  });

  it('refuses to cancel a shipped order with 409 (stock untouched)', async () => {
    const product = await createProduct({ stock: 10 });
    const { ref } = await placeOrder([{ product_id: product.id, quantity: 2 }]);
    const id = orderIdOf(ref);
    for (const status of ['confirmed', 'shipped'] as const) {
      await request(app).post(`/api/admin/orders/${id}/status`).set('Cookie', cookie).send({ status });
    }
    const res = await request(app).post(`/api/admin/orders/${id}/cancel`).set('Cookie', cookie);
    expect(res.status).toBe(409);
    expect(stockOf(product.id)).toBe(8);
    expect((await adminOrder(id)).status).toBe('shipped');
  });

  it('marks orders paid exactly once; cancelled orders cannot be paid', async () => {
    const product = await createProduct({ stock: 5 });
    const { ref } = await placeOrder([{ product_id: product.id, quantity: 1 }]);
    const id = orderIdOf(ref);
    const paid = await request(app).post(`/api/admin/orders/${id}/mark-paid`).set('Cookie', cookie);
    expect(paid.status).toBe(200);
    expect(paid.body.payment_status).toBe('paid');
    const twice = await request(app).post(`/api/admin/orders/${id}/mark-paid`).set('Cookie', cookie);
    expect(twice.status).toBe(409);

    const { ref: ref2 } = await placeOrder([{ product_id: product.id, quantity: 1 }]);
    const id2 = orderIdOf(ref2);
    await request(app).post(`/api/admin/orders/${id2}/cancel`).set('Cookie', cookie);
    const payCancelled = await request(app)
      .post(`/api/admin/orders/${id2}/mark-paid`)
      .set('Cookie', cookie);
    expect(payCancelled.status).toBe(409);
  });
});

describe('admin management', () => {
  it('filters the order list by status and payment', async () => {
    const all = await request(app).get('/api/admin/orders').set('Cookie', cookie);
    expect(all.status).toBe(200);
    const cancelled = await request(app)
      .get('/api/admin/orders?status=cancelled')
      .set('Cookie', cookie);
    expect(cancelled.body.orders.length).toBeGreaterThanOrEqual(1);
    expect(cancelled.body.orders.every((o: { status: string }) => o.status === 'cancelled')).toBe(true);
    const unpaid = await request(app).get('/api/admin/orders?payment=unpaid').set('Cookie', cookie);
    expect(unpaid.body.orders.every((o: { payment_status: string }) => o.payment_status === 'unpaid')).toBe(true);
    const bad = await request(app).get('/api/admin/orders?status=nope').set('Cookie', cookie);
    expect(bad.status).toBe(422);
  });

  it('exports orders as CSV with derived totals', async () => {
    const res = await request(app).get('/api/admin/orders/export.csv').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = (res.text as string).trim().split('\r\n');
    expect(lines[0]).toBe(
      'ref,created_at,status,payment_status,customer_name,email,item_count,net_cents,vat_cents,gross_cents',
    );
    expect(lines.length).toBeGreaterThanOrEqual(7); // header + at least the 6 seeded orders
    expect(lines.some((l) => l.startsWith('ORD-2026-0001,'))).toBe(true);
  });

  it('validates products and rejects unknown VAT rates and bad accents', async () => {
    const res = await request(app)
      .post('/api/admin/products')
      .set('Cookie', cookie)
      .send({ sku: '', name: '', unit_price_cents: -5, vat_rate: 7, stock: -1, category_id: 1, accent: 'red' });
    expect(res.status).toBe(422);
    const fields = (res.body.details as { field: string }[]).map((d) => d.field);
    for (const f of ['sku', 'name', 'unit_price_cents', 'vat_rate', 'stock', 'accent']) {
      expect(fields).toContain(f);
    }
    const dupe = await createProduct();
    const clash = await request(app)
      .post('/api/admin/products')
      .set('Cookie', cookie)
      .send({ sku: dupe.sku, name: 'Dupe', unit_price_cents: 1, vat_rate: 0, stock: 0, category_id: 1 });
    expect(clash.status).toBe(422);
  });

  it('adjusts stock relatively and refuses to go below zero', async () => {
    const product = await createProduct({ stock: 4 });
    const up = await request(app)
      .post(`/api/admin/products/${product.id}/stock`)
      .set('Cookie', cookie)
      .send({ delta: 6 });
    expect(up.status).toBe(200);
    expect(up.body.stock).toBe(10);
    const down = await request(app)
      .post(`/api/admin/products/${product.id}/stock`)
      .set('Cookie', cookie)
      .send({ delta: -11 });
    expect(down.status).toBe(422);
    expect(stockOf(product.id)).toBe(10);
  });

  it('refuses to delete a product that appears on an order (archive instead)', async () => {
    const product = await createProduct({ stock: 5 });
    await placeOrder([{ product_id: product.id, quantity: 1 }]);
    const res = await request(app)
      .delete(`/api/admin/products/${product.id}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(409);
    // Unreferenced products delete fine.
    const fresh = await createProduct();
    const ok = await request(app).delete(`/api/admin/products/${fresh.id}`).set('Cookie', cookie);
    expect(ok.status).toBe(200);
  });

  it('manages categories and refuses to delete a non-empty one', async () => {
    const created = await request(app)
      .post('/api/admin/categories')
      .set('Cookie', cookie)
      .send({ name: 'Seasonal' });
    expect(created.status).toBe(201);
    const renamed = await request(app)
      .put(`/api/admin/categories/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ name: 'Season Specials', position: 9 });
    expect(renamed.status).toBe(200);

    const nonEmpty = await request(app).delete('/api/admin/categories/1').set('Cookie', cookie);
    expect(nonEmpty.status).toBe(409);
    const empty = await request(app)
      .delete(`/api/admin/categories/${created.body.id}`)
      .set('Cookie', cookie);
    expect(empty.status).toBe(200);
  });
});

describe('seed', () => {
  it('is idempotent and demonstrates the price snapshot', () => {
    seed(db); // second run: skipped, nothing duplicated
    const cats = (db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }).n;
    expect(cats).toBeLessThanOrEqual(4); // 3 seeded + the surviving test edits

    // Seeded order 1 bought the USB-C cable at 14,90 — the catalogue now says 15,90.
    const line = db
      .prepare("SELECT unit_price_cents FROM order_lines WHERE sku = 'CP-USBC2' LIMIT 1")
      .get() as { unit_price_cents: number };
    const live = db
      .prepare("SELECT unit_price_cents FROM products WHERE sku = 'CP-USBC2'")
      .get() as { unit_price_cents: number };
    expect(line.unit_price_cents).toBe(1_490);
    expect(live.unit_price_cents).toBe(1_590);
  });
});
