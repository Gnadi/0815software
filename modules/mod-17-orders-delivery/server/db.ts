import Database from 'better-sqlite3';

/**
 * Open (or create) the database and ensure the schema exists.
 *
 * - **Derived, never stored.** What is delivered, what remains, and whether an
 *   order is open, partly or fully delivered are computed from the delivery
 *   notes on every read. Only `cancelled` is stored, because it is a decision,
 *   not a sum.
 * - **Orders and delivery notes are documents.** Each gets a gapless number
 *   per year when it is written (`counters`), and neither is edited after:
 *   an order's lines are what the customer ordered; a delivery note is what
 *   left the building. Corrections are a cancellation of the rest, never an
 *   edit of the past.
 * - **History is append-only and names the person** (`order_events.actor`).
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS counters (
      kind     TEXT    NOT NULL CHECK (kind IN ('order', 'delivery_note')),
      year     INTEGER NOT NULL,
      last_seq INTEGER NOT NULL,
      PRIMARY KEY (kind, year)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      number               TEXT    NOT NULL UNIQUE,
      status               TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cancelled')),
      order_date           TEXT    NOT NULL,
      customer_name        TEXT    NOT NULL,
      customer_contact     TEXT,
      customer_email       TEXT,
      customer_vat_id      TEXT,
      customer_address     TEXT,
      -- The identity the customer came with (the exporting module's), passed on
      -- to billing so PS-11 resolves the same party on every hop.
      customer_party_id    INTEGER,
      customer_source      TEXT,
      customer_external_id TEXT,
      customer_reference   TEXT,
      -- "<module>:<reference>" of the offer it came from; UNIQUE makes the
      -- import idempotent — an offer becomes at most one order.
      source_reference     TEXT    UNIQUE,
      source_accepted_at   TEXT,
      note                 TEXT,
      cancelled_at         TEXT,
      cancel_reason        TEXT,
      created_at           TEXT    NOT NULL,
      created_by           TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_lines (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id         INTEGER NOT NULL REFERENCES orders(id),
      position         INTEGER NOT NULL,
      description      TEXT    NOT NULL,
      quantity         REAL    NOT NULL CHECK (quantity > 0),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      discount_percent REAL    NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
      vat_rate         REAL    NOT NULL CHECK (vat_rate >= 0 AND vat_rate <= 100)
    );
    CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_id);

    CREATE TABLE IF NOT EXISTS delivery_notes (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      number            TEXT    NOT NULL UNIQUE,
      order_id          INTEGER NOT NULL REFERENCES orders(id),
      delivered_on      TEXT    NOT NULL,
      note              TEXT,
      created_at        TEXT    NOT NULL,
      created_by        TEXT    NOT NULL,
      -- Set once, by the billing module taking the delivery over.
      invoiced_at       TEXT,
      invoice_reference TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_notes_order ON delivery_notes(order_id);

    CREATE TABLE IF NOT EXISTS delivery_note_lines (
      delivery_note_id INTEGER NOT NULL REFERENCES delivery_notes(id),
      order_line_id    INTEGER NOT NULL REFERENCES order_lines(id),
      quantity         REAL    NOT NULL CHECK (quantity > 0),
      PRIMARY KEY (delivery_note_id, order_line_id)
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id  INTEGER NOT NULL REFERENCES orders(id),
      type      TEXT    NOT NULL,
      detail    TEXT,
      actor     TEXT    NOT NULL,
      at        TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);
  `);

  return db;
}
