import Database from 'better-sqlite3';

/**
 * Open (or create) the database and ensure the schema exists.
 *
 * Three design rules everything else hangs off:
 *
 * 1. NO STORED TOTALS. Orders store snapshot lines only (sku, name,
 *    quantity, gross unit price in cents, VAT rate). Net, VAT and gross
 *    are always derived from the lines (shared/money.ts), so they
 *    cannot drift. Payment status is derived from `paid_at`.
 *
 * 2. PRICES ARE SNAPSHOTTED AT CHECKOUT. `order_lines` copies sku, name,
 *    unit price and VAT rate out of the catalogue in the checkout
 *    transaction — later price edits never touch an existing order.
 *    Carts, by contrast, always reflect the LIVE catalogue.
 *
 * 3. STOCK CAN NEVER GO NEGATIVE. Checkout validates and decrements in
 *    one transaction, and the CHECK (stock >= 0) is the database-level
 *    backstop — an oversell cannot be committed even by buggy code.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      sku              TEXT NOT NULL UNIQUE,
      name             TEXT NOT NULL,
      description      TEXT NOT NULL DEFAULT '',
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      vat_rate         INTEGER NOT NULL CHECK (vat_rate IN (0, 10, 20)),
      stock            INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      category_id      INTEGER NOT NULL REFERENCES categories(id),
      accent           TEXT,
      archived         INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      created_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_products_category ON products (category_id);

    CREATE TABLE IF NOT EXISTS carts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cart_lines (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      cart_id    INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity   INTEGER NOT NULL CHECK (quantity > 0),
      UNIQUE (cart_id, product_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cart_lines_cart ON cart_lines (cart_id);

    CREATE TABLE IF NOT EXISTS orders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ref           TEXT NOT NULL UNIQUE,
      status        TEXT NOT NULL DEFAULT 'placed'
                      CHECK (status IN ('placed', 'confirmed', 'shipped', 'delivered', 'cancelled')),
      customer_name TEXT NOT NULL,
      email         TEXT NOT NULL,
      address       TEXT NOT NULL,
      paid_at       TEXT,
      cancelled_at  TEXT,
      created_at    TEXT NOT NULL,
      CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS order_lines (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      position         INTEGER NOT NULL,
      product_id       INTEGER NOT NULL REFERENCES products(id),
      sku              TEXT NOT NULL,
      name             TEXT NOT NULL,
      quantity         INTEGER NOT NULL CHECK (quantity > 0),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      vat_rate         INTEGER NOT NULL CHECK (vat_rate IN (0, 10, 20))
    );
    CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines (order_id);
    CREATE INDEX IF NOT EXISTS idx_order_lines_product ON order_lines (product_id);

    CREATE TABLE IF NOT EXISTS order_events (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      status   TEXT NOT NULL
                 CHECK (status IN ('placed', 'confirmed', 'shipped', 'delivered', 'cancelled')),
      at       TEXT NOT NULL,
      note     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events (order_id);

    CREATE TABLE IF NOT EXISTS order_counters (
      year     INTEGER PRIMARY KEY,
      last_seq INTEGER NOT NULL
    );
  `);

  return db;
}
