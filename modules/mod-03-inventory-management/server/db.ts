import Database from 'better-sqlite3';

/**
 * Open (or create) the database and ensure the schema exists.
 *
 * Design note — the one rule everything else hangs off: `movements` is an
 * APPEND-ONLY ledger of signed quantities. There is no "stock" column
 * anywhere; current levels are always `SUM(quantity)` grouped by
 * (product, warehouse), so they cannot drift. The only mutable counter is
 * `purchase_order_lines.qty_received`, which is PO *progress* metadata,
 * not stock — it is updated in the same transaction that appends the
 * corresponding `po_receipt` movements.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS warehouses (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sku           TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      unit          TEXT NOT NULL DEFAULT 'pcs',
      reorder_point REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL,
      email TEXT
    );

    CREATE TABLE IF NOT EXISTS movements (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id   INTEGER NOT NULL REFERENCES products(id),
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      type         TEXT NOT NULL CHECK (type IN
                     ('receipt', 'transfer_out', 'transfer_in', 'adjustment', 'po_receipt', 'goods_issue')),
      quantity     REAL NOT NULL CHECK (quantity != 0),
      reference    TEXT,
      note         TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_movements_product
      ON movements (product_id, warehouse_id);

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      po_number   TEXT NOT NULL UNIQUE,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                    ('draft', 'ordered', 'partially_received', 'received')),
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_order_lines (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id        INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      product_id   INTEGER NOT NULL REFERENCES products(id),
      qty_ordered  REAL NOT NULL CHECK (qty_ordered > 0),
      qty_received REAL NOT NULL DEFAULT 0 CHECK (qty_received >= 0 AND qty_received <= qty_ordered)
    );
    CREATE INDEX IF NOT EXISTS idx_po_lines_po ON purchase_order_lines (po_id);

    -- Goods issued for a delivery in another module (MOD-17), one row per
    -- delivery. UNIQUE (source, reference) makes the booking idempotent: a
    -- retried call books nothing twice. The movements carry the reference.
    CREATE TABLE IF NOT EXISTS goods_issues (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source       TEXT NOT NULL,
      reference    TEXT NOT NULL,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      actor        TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      UNIQUE (source, reference)
    );

    -- Goods received against a purchase order in another module (MOD-06),
    -- one row per receipt; the same idempotency as goods_issues.
    CREATE TABLE IF NOT EXISTS goods_receipts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source       TEXT NOT NULL,
      reference    TEXT NOT NULL,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      actor        TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      UNIQUE (source, reference)
    );
  `);

  // Reservations: stock promised to an order in another module (MOD-17), per
  // order and product. `quantity` is what the order needs in total; how much
  // is STILL reserved is derived — that quantity minus what goods issues for
  // the same order took — so a delivery lowers it without anyone writing.
  // Released when the order is cancelled.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reservations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source       TEXT    NOT NULL,
      reference    TEXT    NOT NULL,
      product_id   INTEGER NOT NULL REFERENCES products(id),
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      quantity     REAL    NOT NULL CHECK (quantity > 0),
      actor        TEXT    NOT NULL,
      created_at   TEXT    NOT NULL,
      updated_at   TEXT    NOT NULL,
      released_at  TEXT,
      released_by  TEXT,
      UNIQUE (source, reference, product_id)
    );
    CREATE INDEX IF NOT EXISTS idx_reservations_product ON reservations (product_id, warehouse_id);
  `);
  // Which order a goods issue delivers, so it draws down that order's reservation.
  const issueColumns = (db.prepare('PRAGMA table_info(goods_issues)').all() as { name: string }[]).map((c) => c.name);
  if (!issueColumns.includes('order_reference')) db.exec('ALTER TABLE goods_issues ADD COLUMN order_reference TEXT');

  // The manufacturer's GTIN (EAN/UPC), optional: what a scanner reads off the
  // packaging. Unique when present; a product without one is scanned by the
  // Code 128 SKU label this module prints.
  const productColumns = (db.prepare('PRAGMA table_info(products)').all() as { name: string }[]).map((c) => c.name);
  if (!productColumns.includes('barcode')) db.exec('ALTER TABLE products ADD COLUMN barcode TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode ON products (barcode) WHERE barcode IS NOT NULL');

  // A database from before goods issues has the old CHECK on movements.type.
  // SQLite cannot alter a CHECK, so the table is rebuilt once, in one
  // transaction, rows and ids unchanged — the ledger is copied, not rewritten.
  const movements = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'movements'").get() as { sql: string };
  if (!movements.sql.includes("'goods_issue'")) {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE movements_next (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id   INTEGER NOT NULL REFERENCES products(id),
          warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
          type         TEXT NOT NULL CHECK (type IN
                         ('receipt', 'transfer_out', 'transfer_in', 'adjustment', 'po_receipt', 'goods_issue')),
          quantity     REAL NOT NULL CHECK (quantity != 0),
          reference    TEXT,
          note         TEXT,
          created_at   TEXT NOT NULL
        );
        INSERT INTO movements_next (id, product_id, warehouse_id, type, quantity, reference, note, created_at)
          SELECT id, product_id, warehouse_id, type, quantity, reference, note, created_at FROM movements;
        DROP TABLE movements;
        ALTER TABLE movements_next RENAME TO movements;
        CREATE INDEX IF NOT EXISTS idx_movements_product ON movements (product_id, warehouse_id);
      `);
    })();
    db.pragma('foreign_keys = ON');
  }

  return db;
}
