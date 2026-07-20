import Database from 'better-sqlite3';

/**
 * Open (or create) the database and ensure the schema exists.
 *
 * Three design rules everything else hangs off:
 *
 * 1. NO STORED TOTALS. Offers store line items only (qty, unit net price
 *    in cents, VAT rate, per-line discount %). Net, VAT and gross are
 *    always derived from the lines (shared/money.ts), so they cannot
 *    drift. "expired" is derived from the validity date too, never
 *    stored.
 *
 * 2. GAPLESS NUMBERING. `offer_counters` holds one row per year with the
 *    last sequence number handed out. A number is assigned in the same
 *    transaction that flips a draft to `sent` — drafts have no number
 *    (enforced by a CHECK, so a numbered draft is unrepresentable),
 *    deleted drafts leave no gap, and an accepted / rejected / withdrawn
 *    / superseded offer keeps its number forever.
 *
 * 3. APPEND-ONLY HISTORY. Every lifecycle transition writes a row to
 *    `offer_events` (actor + when + note). The stored status is just the
 *    latest transition; the timeline is the audit trail and is never
 *    rewritten. Revisions form an append-only supersession chain through
 *    `offers.supersedes_id`.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      contact_person TEXT,
      email          TEXT,
      vat_id         TEXT,
      address        TEXT,
      archived_at    TEXT,
      created_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS offers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      number        TEXT UNIQUE,
      customer_id   INTEGER NOT NULL REFERENCES customers(id),
      title         TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'withdrawn', 'superseded')),
      valid_until   TEXT,
      intro         TEXT,
      terms         TEXT,
      sent_at       TEXT,
      supersedes_id INTEGER REFERENCES offers(id),
      created_at    TEXT NOT NULL,
      -- Drafts have no number; everything numbered has left draft. A
      -- numbered draft (or an un-numbered sent offer) is impossible.
      CHECK ((status = 'draft') = (number IS NULL)),
      CHECK ((status = 'draft') = (sent_at IS NULL)),
      -- A sent (and beyond) offer always has a validity date.
      CHECK ((status = 'draft') OR (valid_until IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_offers_customer ON offers (customer_id);
    CREATE INDEX IF NOT EXISTS idx_offers_supersedes ON offers (supersedes_id);

    CREATE TABLE IF NOT EXISTS offer_lines (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id         INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
      position         INTEGER NOT NULL,
      description      TEXT NOT NULL,
      quantity         REAL NOT NULL CHECK (quantity > 0),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      vat_rate         INTEGER NOT NULL CHECK (vat_rate IN (0, 10, 20)),
      discount_percent REAL NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100)
    );
    CREATE INDEX IF NOT EXISTS idx_lines_offer ON offer_lines (offer_id);

    CREATE TABLE IF NOT EXISTS offer_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id   INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
      event      TEXT NOT NULL
                   CHECK (event IN ('created', 'sent', 'accepted', 'rejected', 'withdrawn', 'superseded', 'revised')),
      actor      TEXT NOT NULL,
      note       TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_offer ON offer_events (offer_id);

    CREATE TABLE IF NOT EXISTS offer_counters (
      year     INTEGER PRIMARY KEY,
      last_seq INTEGER NOT NULL
    );
  `);

  return db;
}
