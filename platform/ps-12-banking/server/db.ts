import Database from 'better-sqlite3';
import { runMigrations, type Migration } from './migrations.js';

/**
 * The schema, and the two rules it encodes.
 *
 * 1. **Nothing derivable is stored.** A connection's state and an order's
 *    status are folded from their append-only event streams at read time — the
 *    PS-08 idiom — so there is no status column that can drift away from what
 *    actually happened. `connection_events` and `order_events` are the truth;
 *    everything else is a detail hanging off them.
 * 2. **A payment file is submitted once.** `orders.idempotency_key` catches a
 *    caller retrying, and `UNIQUE (connection_id, msg_id)` catches a caller who
 *    forgot to send one. Two layers, because the cost of the mistake is a
 *    supplier paid twice and weeks of recovering it.
 *
 * Migrations are append-only and never edited once shipped: a new change is a
 * new migration, so a deployed database can always roll forward.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'baseline',
    up(db) {
      db.exec(`
      -- One bank access: the EBICS contract's three ids, plus the ceilings
      -- that limit what a compromised module token could ever send.
      CREATE TABLE IF NOT EXISTS bank_connections (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        key               TEXT    NOT NULL UNIQUE,   -- slug a module names
        display_name      TEXT    NOT NULL,
        bank_key          TEXT    NOT NULL,          -- a bank-registry profile
        url               TEXT    NOT NULL,
        host_id           TEXT    NOT NULL,
        partner_id        TEXT    NOT NULL,
        user_id           TEXT    NOT NULL,
        ebics_version     TEXT    NOT NULL DEFAULT 'H005'
                            CHECK (ebics_version IN ('H005')),
        es_version        TEXT    NOT NULL DEFAULT 'A005'
                            CHECK (es_version IN ('A005', 'A006')),
        debtor_iban       TEXT,
        -- Defence in depth for signature class E: the service token is a
        -- MODULE credential, and a signed order is money gone. These are
        -- checked here, before anything is signed.
        max_amount_minor  INTEGER NOT NULL DEFAULT 100000000
                            CHECK (max_amount_minor > 0),
        max_transfers     INTEGER NOT NULL DEFAULT 500 CHECK (max_transfers > 0),
        created_at        TEXT    NOT NULL
      );

      -- Our three key pairs. The private PEM is AES-256-GCM ciphertext and is
      -- never returned by any endpoint (keystore.ts).
      CREATE TABLE IF NOT EXISTS subscriber_keys (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id   INTEGER NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
        purpose         TEXT    NOT NULL CHECK (purpose IN ('ES', 'AUTH', 'ENC')),
        version         TEXT    NOT NULL,
        private_pem_enc TEXT    NOT NULL,
        public_pem      TEXT    NOT NULL,
        modulus         TEXT    NOT NULL,
        exponent        TEXT    NOT NULL,
        digest          TEXT    NOT NULL,           -- base64 SHA-256, the INI letter value
        created_at      TEXT    NOT NULL,
        retired_at      TEXT
      );
      -- One live key per purpose. A second would make "which key signed this?"
      -- unanswerable, which is not a question to be vague about.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriber_keys_live
        ON subscriber_keys (connection_id, purpose) WHERE retired_at IS NULL;

      -- The bank's keys, as HPB delivered them. verified_at is set only when a
      -- HUMAN confirmed the digests against the bank's published letter —
      -- that comparison, not the protocol, is what rules out a substituted key.
      CREATE TABLE IF NOT EXISTS bank_keys (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id INTEGER NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
        purpose       TEXT    NOT NULL CHECK (purpose IN ('AUTH', 'ENC')),
        version       TEXT    NOT NULL,
        public_pem    TEXT    NOT NULL,
        digest        TEXT    NOT NULL,
        fetched_at    TEXT    NOT NULL,
        verified_at   TEXT,
        verified_by   TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_keys_purpose
        ON bank_keys (connection_id, purpose);

      -- APPEND-ONLY: the connection's state is folded from this, never stored.
      CREATE TABLE IF NOT EXISTS connection_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id INTEGER NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
        type          TEXT    NOT NULL,
        actor         TEXT,
        meta          TEXT    NOT NULL DEFAULT '{}',
        created_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_connection_events_conn
        ON connection_events (connection_id, id);

      -- One submitted file.
      CREATE TABLE IF NOT EXISTS orders (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id   INTEGER NOT NULL REFERENCES bank_connections(id),
        public_id       TEXT    NOT NULL UNIQUE,     -- "ord_<hex>", what a module quotes
        msg_id          TEXT    NOT NULL,            -- the pain.001 MsgId
        btf             TEXT    NOT NULL,            -- json
        payload_sha256  TEXT    NOT NULL,
        amount_minor    INTEGER,
        tx_count        INTEGER,
        idempotency_key TEXT    UNIQUE,
        transaction_id  TEXT,                        -- assigned by the bank
        created_by      TEXT,
        created_at      TEXT    NOT NULL
      );
      -- THE INVARIANT: the same payment file cannot be sent to the same bank
      -- twice, even by a caller that forgot its idempotency key.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_msg
        ON orders (connection_id, msg_id);

      -- APPEND-ONLY: the order's status is folded from this stream.
      CREATE TABLE IF NOT EXISTS order_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        type        TEXT    NOT NULL,
        ebics_code  TEXT,
        meta        TEXT    NOT NULL DEFAULT '{}',
        created_at  TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events (order_id, id);
      `);
    },
  },
];

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db, MIGRATIONS);
  return db;
}
