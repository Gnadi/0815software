import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { openDb } from './db.js';

/**
 * Deterministic PRNG (mulberry32) so the demo source database is
 * byte-reproducible from a fixed seed — no committed binaries, and the
 * tests can hand-compute expected aggregates.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REGIONS = ['North', 'South', 'East', 'West', 'Central'];

interface ProductDef {
  name: string;
  category: string;
  price: number; // cents
}

const PRODUCTS: ProductDef[] = [
  { name: 'Rack Server R220', category: 'Hardware', price: 189_000 },
  { name: 'Network Switch 24p', category: 'Hardware', price: 42_000 },
  { name: 'SSD 2TB NVMe', category: 'Hardware', price: 18_500 },
  { name: 'Workstation Pro', category: 'Hardware', price: 145_000 },
  { name: 'UPS 1500VA', category: 'Hardware', price: 29_900 },
  { name: 'Analytics License', category: 'Software', price: 96_000 },
  { name: 'Backup Suite', category: 'Software', price: 54_000 },
  { name: 'Endpoint Security', category: 'Software', price: 32_000 },
  { name: 'Database Standard', category: 'Software', price: 120_000 },
  { name: 'Monitoring Add-on', category: 'Software', price: 21_000 },
  { name: 'Onboarding Package', category: 'Services', price: 75_000 },
  { name: 'Support Contract 1yr', category: 'Services', price: 240_000 },
  { name: 'Migration Project', category: 'Services', price: 320_000 },
  { name: 'Training Day', category: 'Services', price: 18_000 },
  { name: 'Health Check', category: 'Services', price: 45_000 },
  { name: 'Cat6 Cable 5m', category: 'Accessories', price: 1_200 },
  { name: 'Rack Shelf', category: 'Accessories', price: 6_800 },
  { name: 'KVM Console', category: 'Accessories', price: 34_000 },
  { name: 'Mounting Kit', category: 'Accessories', price: 3_400 },
  { name: 'Fiber Patch 3m', category: 'Accessories', price: 2_100 },
];

/**
 * Generate the demo SOURCE database — a year of sales: regions,
 * products, orders and order_lines (a few thousand rows). Opened
 * writable here (this is the one and only writer); the module itself
 * only ever reads it. Idempotent: skips a database that already has data.
 */
export function seedSourceDb(sourceDb: Database.Database): void {
  const existing = sourceDb
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='orders'`,
    )
    .get() as { n: number };
  if (existing.n > 0) {
    const rows = sourceDb.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number };
    if (rows.n > 0) {
      console.log(`[seed] source db already has ${rows.n} orders, skipping`);
      return;
    }
  }

  sourceDb.exec(`
    CREATE TABLE IF NOT EXISTS regions (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS products (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      category         TEXT NOT NULL,
      unit_price_cents INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      order_date TEXT NOT NULL,
      region_id  INTEGER NOT NULL REFERENCES regions(id)
    );
    CREATE TABLE IF NOT EXISTS order_lines (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id         INTEGER NOT NULL REFERENCES orders(id),
      product_id       INTEGER NOT NULL REFERENCES products(id),
      quantity         INTEGER NOT NULL,
      unit_price_cents INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines (order_id);
  `);

  const rnd = mulberry32(0x08150808);

  sourceDb.transaction(() => {
    const insRegion = sourceDb.prepare('INSERT INTO regions (name) VALUES (?)');
    for (const r of REGIONS) insRegion.run(r);

    const insProduct = sourceDb.prepare(
      'INSERT INTO products (name, category, unit_price_cents) VALUES (?, ?, ?)',
    );
    for (const p of PRODUCTS) insProduct.run(p.name, p.category, p.price);

    const insOrder = sourceDb.prepare('INSERT INTO orders (order_date, region_id) VALUES (?, ?)');
    const insLine = sourceDb.prepare(
      'INSERT INTO order_lines (order_id, product_id, quantity, unit_price_cents) VALUES (?, ?, ?, ?)',
    );

    const start = Date.UTC(2025, 0, 1);
    const dayMs = 86_400_000;
    const ORDERS = 1200;
    for (let i = 0; i < ORDERS; i++) {
      const day = Math.floor(rnd() * 365);
      const date = new Date(start + day * dayMs).toISOString().slice(0, 10);
      const regionId = 1 + Math.floor(rnd() * REGIONS.length);
      const orderInfo = insOrder.run(date, regionId);
      const orderId = Number(orderInfo.lastInsertRowid);
      const lineCount = 1 + Math.floor(rnd() * 4);
      for (let j = 0; j < lineCount; j++) {
        const productId = 1 + Math.floor(rnd() * PRODUCTS.length);
        const quantity = 1 + Math.floor(rnd() * 10);
        const price = PRODUCTS[productId - 1]!.price;
        insLine.run(orderId, productId, quantity, price);
      }
    }
  })();

  const stats = sourceDb
    .prepare(
      `SELECT (SELECT COUNT(*) FROM regions) AS regions,
              (SELECT COUNT(*) FROM products) AS products,
              (SELECT COUNT(*) FROM orders) AS orders,
              (SELECT COUNT(*) FROM order_lines) AS lines`,
    )
    .get() as { regions: number; products: number; orders: number; lines: number };
  console.log(
    `[seed] source db: ${stats.regions} regions, ${stats.products} products, ${stats.orders} orders, ${stats.lines} order lines`,
  );
}

/** Ensure a demo source db exists at `path`; generate it if missing. */
export function ensureSourceDb(path: string): void {
  if (existsSync(path)) return;
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  seedSourceDb(db);
  db.close();
  console.log(`[seed] generated demo source db at ${path}`);
}

const REPORTS: { name: string; description: string; sql: string }[] = [
  {
    name: 'Revenue by month',
    description: 'Total net revenue (cents) per calendar month across all regions.',
    sql: `SELECT strftime('%Y-%m', o.order_date) AS month,
       SUM(ol.quantity * ol.unit_price_cents) AS revenue_cents,
       COUNT(DISTINCT o.id) AS orders
FROM orders o
JOIN order_lines ol ON ol.order_id = o.id
GROUP BY month
ORDER BY month`,
  },
  {
    name: 'Top products by revenue',
    description: 'Products ranked by total revenue, with units sold.',
    sql: `SELECT p.name AS product,
       p.category AS category,
       SUM(ol.quantity) AS units,
       SUM(ol.quantity * ol.unit_price_cents) AS revenue_cents
FROM order_lines ol
JOIN products p ON p.id = ol.product_id
GROUP BY p.id
ORDER BY revenue_cents DESC
LIMIT 20`,
  },
  {
    name: 'Orders by region',
    description: 'Order count and revenue per sales region.',
    sql: `SELECT r.name AS region,
       COUNT(DISTINCT o.id) AS orders,
       SUM(ol.quantity * ol.unit_price_cents) AS revenue_cents
FROM orders o
JOIN regions r ON r.id = o.region_id
JOIN order_lines ol ON ol.order_id = o.id
GROUP BY r.id
ORDER BY revenue_cents DESC`,
  },
  {
    name: 'Revenue by category and region',
    description: 'Long-format rows ideal for a pivot: category × region revenue.',
    sql: `SELECT p.category AS category,
       r.name AS region,
       SUM(ol.quantity * ol.unit_price_cents) AS revenue_cents
FROM order_lines ol
JOIN products p ON p.id = ol.product_id
JOIN orders o ON o.id = ol.order_id
JOIN regions r ON r.id = o.region_id
GROUP BY p.category, r.name
ORDER BY p.category, r.name`,
  },
  {
    name: 'Daily order volume',
    description: 'Number of orders placed per day (good for a line chart).',
    sql: `SELECT o.order_date AS day, COUNT(*) AS orders
FROM orders o
GROUP BY o.order_date
ORDER BY o.order_date`,
  },
];

/**
 * Seed the module's OWN metadata db: the example reports, two charts and
 * one schedule with a couple of historical run rows. Idempotent — skips
 * a metadata db that already contains reports. History rows are written
 * directly (no files touched): they model runs whose CSV files have since
 * been rotated out of the exports directory.
 */
export function seedMeta(db: Database.Database, exportsDir = './exports'): void {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM reports').get() as { count: number };
  if (count > 0) {
    console.log(`[seed] metadata db already has ${count} reports, skipping`);
    return;
  }

  db.transaction(() => {
    const insReport = db.prepare(
      `INSERT INTO reports (name, description, sql, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const at = '2026-01-05T09:00:00.000Z';
    const ids: Record<string, number> = {};
    for (const r of REPORTS) {
      const info = insReport.run(r.name, r.description, r.sql, at, at);
      ids[r.name] = Number(info.lastInsertRowid);
    }

    const insChart = db.prepare(
      `INSERT INTO charts (report_id, name, kind, x_column, y_column, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insChart.run(ids['Revenue by month'], 'Monthly revenue', 'bar', 'month', 'revenue_cents', at);
    insChart.run(ids['Daily order volume'], 'Daily order volume', 'line', 'day', 'orders', at);

    const insSchedule = db.prepare(
      `INSERT INTO schedules (report_id, interval, format, enabled, last_run_at, created_at)
       VALUES (?, ?, 'csv', 1, ?, ?)`,
    );
    const lastRun = '2026-01-08T06:00:00.000Z';
    const schedInfo = insSchedule.run(ids['Revenue by month'], 'daily', lastRun, at);
    const scheduleId = Number(schedInfo.lastInsertRowid);

    const insRun = db.prepare(
      `INSERT INTO runs (report_id, schedule_id, trigger, status, started_at, finished_at, row_count, file_path, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insRun.run(
      ids['Revenue by month'],
      scheduleId,
      'scheduled',
      'ok',
      '2026-01-07T06:00:00.000Z',
      '2026-01-07T06:00:00.320Z',
      12,
      `${exportsDir}/report-${ids['Revenue by month']}-revenue-by-month-2026-01-07T06-00-00-000Z.csv`,
      null,
    );
    insRun.run(
      ids['Revenue by month'],
      scheduleId,
      'scheduled',
      'ok',
      '2026-01-08T06:00:00.000Z',
      '2026-01-08T06:00:00.290Z',
      12,
      `${exportsDir}/report-${ids['Revenue by month']}-revenue-by-month-2026-01-08T06-00-00-000Z.csv`,
      null,
    );
  })();

  console.log(`[seed] metadata db: ${REPORTS.length} reports, 2 charts, 1 schedule, 2 run-history rows`);
}

// CLI entry: npm run seed
const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { configFromEnv } = await import('./config.js');
  const config = configFromEnv();
  ensureSourceDb(config.sourceDbPath);
  const db = openDb(config.databasePath);
  seedMeta(db, config.exportsDir);
  db.close();
  console.log(`[seed] done — metadata at ${config.databasePath}, source at ${config.sourceDbPath}`);
}
