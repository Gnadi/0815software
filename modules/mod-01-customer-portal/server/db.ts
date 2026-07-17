import Database from 'better-sqlite3';

/** Open (or create) the database and make sure the schema exists. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    NOT NULL UNIQUE,
      name          TEXT    NOT NULL,
      company       TEXT    NOT NULL,
      password_hash TEXT    NOT NULL,
      token_version INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      order_no    TEXT    NOT NULL UNIQUE,
      status      TEXT    NOT NULL,
      currency    TEXT    NOT NULL DEFAULT 'EUR',
      total_cents INTEGER NOT NULL,
      placed_at   TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id         INTEGER NOT NULL REFERENCES orders(id),
      sku              TEXT    NOT NULL,
      description      TEXT    NOT NULL,
      quantity         INTEGER NOT NULL,
      unit_price_cents INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      status   TEXT    NOT NULL,
      at       TEXT    NOT NULL,
      note     TEXT
    );

    CREATE TABLE IF NOT EXISTS documents (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      order_id    INTEGER REFERENCES orders(id),
      doc_type    TEXT    NOT NULL,
      title       TEXT    NOT NULL,
      filename    TEXT    NOT NULL,
      stored_name TEXT    NOT NULL UNIQUE,
      size_bytes  INTEGER NOT NULL,
      created_at  TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_customer    ON orders(customer_id);
    CREATE INDEX IF NOT EXISTS idx_items_order        ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_events_order       ON order_events(order_id);
    CREATE INDEX IF NOT EXISTS idx_documents_customer ON documents(customer_id);
    CREATE INDEX IF NOT EXISTS idx_documents_order    ON documents(order_id);
  `);

  return db;
}
