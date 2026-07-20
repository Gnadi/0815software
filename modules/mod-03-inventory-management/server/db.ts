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
                     ('receipt', 'transfer_out', 'transfer_in', 'adjustment', 'po_receipt')),
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
  `);

  return db;
}
