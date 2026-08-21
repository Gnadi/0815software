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
  {
    id: 2,
    name: 'downloads',
    up(db) {
      db.exec(`
      -- One file the bank handed us: a camt.053 statement, a pain.002 status
      -- report, anything a BTF names. Stored whole and unparsed.
      --
      -- Two things are worth stating about this table.
      --
      -- The CONTENT is kept, not just what we made of it. A camt.053 is the
      -- bank's own record of an account; re-fetching one is not always
      -- possible (a positive receipt tells the bank we have it, and it stops
      -- offering it), so throwing away the bytes after reading them once
      -- means a parser bug is unrecoverable rather than a re-run.
      --
      -- \`acknowledged_at\` is when we sent the POSITIVE RECEIPT, and it is
      -- deliberately set AFTER the row is committed. A receipt sent before
      -- the file is safely stored is how a bank statement disappears: the
      -- bank marks it collected and we crashed before writing it.
      CREATE TABLE IF NOT EXISTS downloads (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id  INTEGER NOT NULL REFERENCES bank_connections(id),
        public_id      TEXT    NOT NULL UNIQUE,      -- "dl_<hex>"
        kind           TEXT    NOT NULL,             -- 'statement' | 'status' | 'other'
        btf            TEXT    NOT NULL,             -- json, what was asked for
        sha256         TEXT    NOT NULL,
        byte_length    INTEGER NOT NULL,
        content        BLOB    NOT NULL,
        transaction_id TEXT,
        fetched_at     TEXT    NOT NULL,
        acknowledged_at TEXT,
        -- Set once the file has been read into whatever a consumer needed.
        processed_at   TEXT
      );
      -- THE INVARIANT: the same bytes are stored once per connection. Banks
      -- re-offer a file whose receipt they never saw, which is correct of
      -- them and would otherwise give us a duplicate every time a fetch was
      -- interrupted between storing and acknowledging.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_downloads_sha
        ON downloads (connection_id, sha256);
      CREATE INDEX IF NOT EXISTS idx_downloads_unprocessed
        ON downloads (connection_id, processed_at);

      -- What a download told us about one payment. Append-only; the order's
      -- own event stream is where this ends up mattering.
      CREATE TABLE IF NOT EXISTS download_reports (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        download_id   INTEGER NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
        -- The pain.001 MsgId this report is about, when it names one.
        msg_id        TEXT,
        -- 'ACCP' | 'ACSC' | 'RJCT' | … — the bank's own status code.
        status_code   TEXT    NOT NULL,
        reason_code   TEXT,
        reason        TEXT,
        created_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_download_reports_msg ON download_reports (msg_id);
      `);
    },
  },
  {
    id: 3,
    name: 'scope-idempotency-keys-to-their-connection',
    up(db) {
      // An idempotency key is the CALLER'S word, and MOD-04 builds it from a
      // payment run's MsgId. Two connections legitimately carry the same run
      // to two banks — so a globally UNIQUE column was wrong twice over: the
      // lookup answered the second submission with the first bank's order and
      // dropped the file, and the constraint would have refused it anyway.
      //
      // The column was declared `TEXT UNIQUE` inline, which in SQLite creates
      // an implicit index that cannot be dropped. Rebuilding the table is the
      // only way to remove it, which is why this migration is long for what it
      // does.
      //
      // And the trap in that rebuild, which this repository's upgrade test
      // caught on the first run: `order_events` references `orders(id)` with
      // ON DELETE CASCADE, so `DROP TABLE orders` silently empties it. The
      // usual remedy — `PRAGMA foreign_keys=OFF` — is a no-op here because
      // migrations run inside a transaction, so the events are copied aside
      // and put back instead. Ids are preserved exactly, so every reference
      // still resolves.
      db.exec(`
      CREATE TEMP TABLE order_events_backup AS SELECT * FROM order_events;

      CREATE TABLE orders_rebuilt (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id   INTEGER NOT NULL REFERENCES bank_connections(id),
        public_id       TEXT    NOT NULL UNIQUE,
        msg_id          TEXT    NOT NULL,
        btf             TEXT    NOT NULL,
        payload_sha256  TEXT    NOT NULL,
        amount_minor    INTEGER,
        tx_count        INTEGER,
        idempotency_key TEXT,
        transaction_id  TEXT,
        created_by      TEXT,
        created_at      TEXT    NOT NULL
      );

      INSERT INTO orders_rebuilt
        (id, connection_id, public_id, msg_id, btf, payload_sha256, amount_minor,
         tx_count, idempotency_key, transaction_id, created_by, created_at)
      SELECT id, connection_id, public_id, msg_id, btf, payload_sha256, amount_minor,
             tx_count, idempotency_key, transaction_id, created_by, created_at
        FROM orders;

      DROP TABLE orders;
      ALTER TABLE orders_rebuilt RENAME TO orders;

      -- Both invariants, restated on the rebuilt table.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_msg
        ON orders (connection_id, msg_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency
        ON orders (connection_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

      -- Put the cascade's casualties back.
      INSERT INTO order_events (id, order_id, type, ebics_code, meta, created_at)
      SELECT id, order_id, type, ebics_code, meta, created_at FROM order_events_backup;
      DROP TABLE order_events_backup;
      `);
    },
  },
  {
    id: 4,
    name: 'subscriber-and-bank-certificates',
    up(db) {
      // EBICS 3.0 carries public keys as X.509 certificates and nothing else:
      // `PubKeyValue` does not exist in the H005 schema set, and
      // `PubKeyInfoType` requires `<ds:X509Data>`. So both our own keys and the
      // bank's now have a certificate beside them.
      //
      // Nullable rather than NOT NULL because a database written before this
      // migration has keys with no certificate. Those connections cannot send
      // a valid INI or HIA and must be re-initialised with the bank — which is
      // a conversation, not something a migration can do — so the column is
      // left empty and `generateKeys` refuses to overwrite live keys.
      // Guarded, because the upgrade test replays every migration over a
      // database that has already had them — which is what an old
      // installation meeting a new build looks like.
      const hasColumn = (table: string): boolean =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
          (c) => c.name === 'certificate_pem',
        );
      if (!hasColumn('subscriber_keys')) db.exec('ALTER TABLE subscriber_keys ADD COLUMN certificate_pem TEXT');
      if (!hasColumn('bank_keys')) db.exec('ALTER TABLE bank_keys ADD COLUMN certificate_pem TEXT');
    },
  },
  {
    id: 5,
    name: 'connection-product',
    up(db) {
      // The `Product` element: which client software is talking, and under
      // which id the bank knows it. Optional in H005, but the Austrian
      // specification's worked example carries it and some banks ask for the
      // id they issued, so it is a per-connection property — one customer can
      // have a product id at one bank and none at another.
      //
      // Nullable, and null means "emit no Product element", which is exactly
      // what every message this service sent before this migration did.
      const columns = (db.prepare('PRAGMA table_info(bank_connections)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      if (!columns.includes('product_name')) db.exec('ALTER TABLE bank_connections ADD COLUMN product_name TEXT');
      if (!columns.includes('product_language')) {
        db.exec('ALTER TABLE bank_connections ADD COLUMN product_language TEXT');
      }
      if (!columns.includes('product_institute_id')) {
        db.exec('ALTER TABLE bank_connections ADD COLUMN product_institute_id TEXT');
      }
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
