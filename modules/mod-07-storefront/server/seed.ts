import type Database from 'better-sqlite3';
import {
  addCartItem,
  cancelOrder,
  checkout,
  createCart,
  markPaid,
  transitionOrder,
} from './store.js';

/**
 * Example dataset: 3 categories, 12 products (varied gross prices, VAT
 * rates and stock levels, incl. one out-of-stock item) and 6 orders
 * across every lifecycle status. Everything goes THROUGH the domain
 * functions (cart → checkout → transition/markPaid/cancelOrder), so the
 * seeded database satisfies the same invariants as a live one: prices
 * snapshotted into order lines, stock decremented by checkout and
 * restored by the cancellation, no stored totals, gapless refs.
 *
 * As a built-in demonstration of price-snapshot invariance, one
 * product's catalogue price is raised AFTER the orders are placed — the
 * old orders keep their original totals.
 *
 * Idempotent: the dataset is relational, so seeding is all-or-nothing —
 * if any categories exist the seed is skipped entirely.
 */
export function seed(db: Database.Database): void {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM categories').get() as { count: number };
  if (count > 0) {
    console.log(`[seed] database already contains ${count} categories, skipping`);
    return;
  }

  db.transaction(() => {
    // ── Categories ─────────────────────────────────────────────────────
    const insertCategory = db.prepare(
      'INSERT INTO categories (name, position, created_at) VALUES (?, ?, ?)',
    );
    const categories: [string, number][] = [
      ['Workspace', 1],
      ['Cables & Power', 2],
      ['Paper Goods', 3],
    ];
    const catId: Record<string, number> = {};
    for (const [name, position] of categories) {
      const info = insertCategory.run(name, position, '2026-01-05T09:00:00Z');
      catId[name] = Number(info.lastInsertRowid);
    }

    // ── Products ───────────────────────────────────────────────────────
    // [sku, name, description, gross cents, VAT %, stock, category, accent]
    const products: [string, string, string, number, number, number, string, string | null][] = [
      ['WS-DESKPAD', 'Desk Pad A2', 'Vegetable-tanned leather desk pad, 594 × 420 mm. Ages with grace, hides coffee rings.', 3_490, 20, 26, 'Workspace', '#7A9E8F'],
      ['WS-LAMP', 'Task Lamp 4000K', 'Aluminium task lamp, 4000 K neutral white, stepless dimming, weighted base.', 8_990, 20, 13, 'Workspace', '#C2A878'],
      ['WS-STAND', 'Monitor Stand Oak', 'Solid oak monitor stand, 100 mm rise, cable pass-through. Oiled finish.', 12_900, 20, 9, 'Workspace', '#A87E6F'],
      ['WS-TRAY', 'Cable Tray Steel', 'Under-desk cable tray, powder-coated steel, clamps without drilling.', 4_490, 20, 0, 'Workspace', '#8F8F9E'],
      ['CP-USBC2', 'USB-C Cable 2 m', 'USB-C to USB-C, 100 W PD, braided. The one that stays in the bag.', 1_490, 20, 142, 'Cables & Power', '#6F8FA8'],
      ['CP-HUB7', 'USB Hub 7-Port', 'Powered 7-port USB 3.2 hub, aluminium shell, individual port switches.', 5_990, 20, 32, 'Cables & Power', '#7A8FA0'],
      ['CP-PSU65', 'GaN Charger 65 W', 'Two USB-C, one USB-A, 65 W total. Fits a shirt pocket, charges a laptop.', 4_990, 20, 46, 'Cables & Power', '#96876F'],
      ['CP-KVM', 'KVM Switch 2-Port', 'Two machines, one desk: 4K60 HDMI, three USB ports, desktop remote button.', 15_900, 20, 7, 'Cables & Power', '#8A7E9E'],
      ['PG-NOTEA5', 'Notebook A5 Dot Grid', '160 pages, 100 g/m² ivory paper, lay-flat binding, numbered pages, index.', 990, 10, 223, 'Paper Goods', '#9E8F7A'],
      ['PG-PLAN', 'Weekly Planner', 'Undated weekly planner, 52 spreads, Monday start, year-at-a-glance foldout.', 1_690, 10, 87, 'Paper Goods', '#A89678'],
      ['PG-KRAFT', 'Kraft Envelopes C5 (50)', 'Box of 50 kraft envelopes, C5, gummed flap, 120 g/m².', 790, 20, 64, 'Paper Goods', '#B0A188'],
      ['PG-VOUCH', 'Gift Card 20 €', 'Printed gift card worth 20 €, kraft sleeve. VAT applies on redemption, not purchase.', 2_000, 0, 500, 'Paper Goods', '#8FA08F'],
    ];
    const insertProduct = db.prepare(
      `INSERT INTO products (sku, name, description, unit_price_cents, vat_rate, stock, category_id, accent, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    const productId: Record<string, number> = {};
    for (const [sku, name, description, price, vat, stock, category, accent] of products) {
      const info = insertProduct.run(sku, name, description, price, vat, stock, catId[category], accent, '2026-01-05T09:30:00Z');
      productId[sku] = Number(info.lastInsertRowid);
    }

    // ── Orders (via the real cart → checkout path) ─────────────────────
    const place = (
      lines: [string, number][],
      customer: { name: string; email: string; address: string },
      placedAt: string,
    ): number => {
      const cartId = createCart(db);
      for (const [sku, quantity] of lines) addCartItem(db, cartId, productId[sku]!, quantity);
      const { orderId } = checkout(db, cartId, {
        customerName: customer.name,
        email: customer.email,
        address: customer.address,
        placedAt,
      });
      return orderId;
    };

    // 1 — delivered & paid
    const o1 = place(
      [['CP-USBC2', 2], ['WS-DESKPAD', 1]],
      { name: 'Miriam Hofer', email: 'miriam.hofer@example.at', address: 'Neubaugasse 41/7\n1070 Wien\nAustria' },
      '2026-06-12T10:14:00Z',
    );
    markPaid(db, o1, '2026-06-12T10:14:30Z');
    transitionOrder(db, o1, 'confirmed', '2026-06-12T13:02:00Z');
    transitionOrder(db, o1, 'shipped', '2026-06-13T08:41:00Z');
    transitionOrder(db, o1, 'delivered', '2026-06-16T11:20:00Z');

    // 2 — shipped & paid
    const o2 = place(
      [['WS-LAMP', 1], ['PG-NOTEA5', 3]],
      { name: 'Jonas Brandstätter', email: 'j.brandstaetter@example.de', address: 'Lindwurmstraße 88\n80337 München\nGermany' },
      '2026-07-08T16:55:00Z',
    );
    markPaid(db, o2, '2026-07-09T07:12:00Z');
    transitionOrder(db, o2, 'confirmed', '2026-07-09T07:15:00Z');
    transitionOrder(db, o2, 'shipped', '2026-07-10T09:03:00Z');

    // 3 — confirmed & paid
    const o3 = place(
      [['CP-HUB7', 1], ['CP-PSU65', 1]],
      { name: 'Lea Wintersteller', email: 'lea.w@example.at', address: 'Makartplatz 3\n5020 Salzburg\nAustria' },
      '2026-07-14T11:31:00Z',
    );
    markPaid(db, o3, '2026-07-14T11:32:00Z');
    transitionOrder(db, o3, 'confirmed', '2026-07-14T14:00:00Z');

    // 4 — placed, unpaid (mixed VAT incl. the 0 % gift card)
    place(
      [['PG-PLAN', 2], ['PG-VOUCH', 1]],
      { name: 'Tobias Ecker', email: 'tobias.ecker@example.at', address: 'Herrengasse 12\n8010 Graz\nAustria' },
      '2026-07-16T18:22:00Z',
    );

    // 5 — placed, unpaid
    place(
      [['WS-STAND', 1]],
      { name: 'Anna Pichler', email: 'anna.pichler@example.at', address: 'Museumstraße 20\n6020 Innsbruck\nAustria' },
      '2026-07-17T08:47:00Z',
    );

    // 6 — cancelled (checkout decremented the stock, the cancel restored it)
    const o6 = place(
      [['CP-KVM', 1], ['PG-KRAFT', 2]],
      { name: 'David Steiner', email: 'd.steiner@example.at', address: 'Landstraße 55\n4020 Linz\nAustria' },
      '2026-07-05T12:09:00Z',
    );
    cancelOrder(db, o6, '2026-07-06T09:30:00Z');

    // ── Price-snapshot demonstration ───────────────────────────────────
    // The USB-C cable got more expensive AFTER order 1 was placed. The
    // catalogue now says 15,90 € — order 1's lines still say 14,90 €.
    db.prepare('UPDATE products SET unit_price_cents = ? WHERE id = ?').run(
      1_590,
      productId['CP-USBC2'],
    );
  })();

  console.log('[seed] created 3 categories, 12 products, 6 orders');
}

// CLI entry: npm run seed
const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { openDb } = await import('./db.js');
  const { configFromEnv } = await import('./config.js');
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  seed(db);
  db.close();
  console.log(`[seed] done — database at ${config.databasePath}`);
}
