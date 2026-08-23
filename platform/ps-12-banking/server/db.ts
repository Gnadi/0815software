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
  {
    id: 6,
    name: 'connection-request-eds',
    up(db) {
      // Whether uploads ask the bank to spool into its distributed-signature
      // (VEU/EDS) queue. A property of the account's bank agreement — how many
      // signatures it requires — so it belongs on the connection, not on the
      // individual order.
      //
      // Default 0, which is signature class E: the ES this service attaches is
      // the whole authorisation, and a bank wanting more rejects the order
      // rather than parking it.
      const columns = (db.prepare('PRAGMA table_info(bank_connections)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      if (!columns.includes('request_eds')) {
        db.exec('ALTER TABLE bank_connections ADD COLUMN request_eds INTEGER NOT NULL DEFAULT 0');
      }
    },
  },
  {
    id: 7,
    name: 'connection-verification-of-payee',
    up(db) {
      // Verification of Payee. Since 09.10.2025 the ServiceOption VOO/VOI on a
      // SEPA credit transfer selects opt-out/opt-in; leaving it off means the
      // market's default decides, and both published tables set that default
      // to OPT-OUT for SCT and SCI.
      //
      // "default" keeps exactly that behaviour — no option, the bank decides —
      // and is what every existing connection gets. The point of the column is
      // that an installation which cares can say so rather than inherit it.
      const columns = (db.prepare('PRAGMA table_info(bank_connections)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      if (!columns.includes('vop')) {
        db.exec("ALTER TABLE bank_connections ADD COLUMN vop TEXT NOT NULL DEFAULT 'default'");
      }
    },
  },
  {
    id: 8,
    name: 'download-subscriptions',
    up(db) {
      // WHAT THE TICK POLLS, per connection, instead of two hard-coded BTFs.
      //
      // Until now `tick()` fetched exactly `profile.paymentStatus` and
      // `profile.statement` — a payment status report and a camt.053 — and
      // nothing else, on every connection. Every other BTF a bank offers
      // (camt.052 intraday, camt.054 notifications, camt.086 fees, MT940,
      // the Austrian CIM customer information, PDF statements) was reachable
      // only by an operator pressing "fetch now". That is not a protocol
      // limitation and never was; the upload side has always taken any BTF
      // the caller names.
      //
      // A row here is one standing instruction: fetch this BTF on every tick.
      // `HTD` is where the list of legitimate values comes from — the bank's
      // own statement of what it has enabled for this contract.
      db.exec(`
      CREATE TABLE IF NOT EXISTS download_subscriptions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id  INTEGER NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
        btf            TEXT    NOT NULL,          -- json, as sent
        -- The same BTF with its keys in a fixed order, so that two spellings
        -- of one subscription collide on the index instead of both polling.
        btf_key        TEXT    NOT NULL,
        label          TEXT,
        enabled        INTEGER NOT NULL DEFAULT 1,
        -- When set, each poll asks for this many days back. Banks differ on
        -- whether an absent DateRange means "everything new" or "today", and
        -- for a statement the difference is a missed day.
        lookback_days  INTEGER,
        created_at     TEXT    NOT NULL,
        last_fetched_at TEXT,
        last_problem   TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_download_subscriptions_btf
        ON download_subscriptions (connection_id, btf_key);
      `);
    },
  },
  {
    id: 9,
    name: 'backfill-download-subscriptions',
    up(db) {
      // Every connection that existed before migration 8 keeps polling exactly
      // what it polled before — its profile's status report and statement.
      // Written out as literal JSON rather than read from `bank-registry.ts`
      // because a migration must produce the same result forever, and that
      // file is edited whenever a published mapping table changes.
      const profiles: Record<string, { label: string; btf: Record<string, string> }[]> = {
        'de-sepa': [
          { label: 'payment status reports', btf: { service_name: 'REP', scope: 'DE', option: 'SCT', msg_name: 'pain.002', container: 'ZIP' } },
          { label: 'account statements', btf: { service_name: 'EOP', scope: 'DE', msg_name: 'camt.053', container: 'ZIP' } },
        ],
        'at-sepa': [
          { label: 'payment status reports', btf: { service_name: 'REP', scope: 'AT', option: 'SCT', msg_name: 'pain.002', container: 'ZIP' } },
          { label: 'account statements', btf: { service_name: 'EOP', scope: 'AT', msg_name: 'camt.053', container: 'ZIP' } },
        ],
        generic: [
          { label: 'payment status reports', btf: { service_name: 'REP', option: 'SCT', msg_name: 'pain.002', container: 'ZIP' } },
          { label: 'account statements', btf: { service_name: 'EOP', msg_name: 'camt.053', container: 'ZIP' } },
        ],
      };
      // The same canonical ordering `subscriptions.ts` uses. Repeated here
      // rather than imported for the reason above.
      const order = ['service_name', 'scope', 'option', 'msg_name', 'msg_version', 'msg_variant', 'msg_format', 'container'];
      const canonical = (btf: Record<string, string>): string =>
        JSON.stringify(order.filter((k) => btf[k] !== undefined).map((k) => [k, btf[k]]));

      const connections = db.prepare('SELECT id, bank_key, created_at FROM bank_connections').all() as {
        id: number;
        bank_key: string;
        created_at: string;
      }[];
      const insert = db.prepare(
        `INSERT OR IGNORE INTO download_subscriptions
           (connection_id, btf, btf_key, label, enabled, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      );
      for (const connection of connections) {
        for (const entry of profiles[connection.bank_key] ?? profiles.generic) {
          insert.run(connection.id, JSON.stringify(entry.btf), canonical(entry.btf), entry.label, connection.created_at);
        }
      }
    },
  },
  {
    id: 10,
    name: 'pending-subscriber-keys',
    up(db) {
      // Key rotation over the wire (HCA/HCS) needs two live keys per purpose
      // for the length of one request: the one the bank still knows, which
      // signs the change, and the one that takes over if it says yes.
      //
      // THE ORDERING THIS COLUMN EXISTS FOR. The new keys are generated and
      // COMMITTED — as pending — before the request goes out. Generating them
      // in memory and writing them only after the bank accepts would leave a
      // window where the bank has moved to a key this service no longer holds,
      // and the recovery from that is re-initialising on paper. A pending row
      // nobody activated costs nothing; a lost private key costs days.
      const columns = (db.prepare('PRAGMA table_info(subscriber_keys)').all() as { name: string }[]).map((c) => c.name);
      if (!columns.includes('pending')) {
        db.exec('ALTER TABLE subscriber_keys ADD COLUMN pending INTEGER NOT NULL DEFAULT 0');
      }
      // The live-key index has to make room for the pending one. Named
      // explicitly at creation (migration 1), so it can be replaced.
      db.exec(`
      DROP INDEX IF EXISTS idx_subscriber_keys_live;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriber_keys_live
        ON subscriber_keys (connection_id, purpose) WHERE retired_at IS NULL AND pending = 0;
      -- And at most one pending key per purpose, for the same reason: "which
      -- key is taking over?" must have one answer.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriber_keys_pending
        ON subscriber_keys (connection_id, purpose) WHERE retired_at IS NULL AND pending = 1;
      `);
    },
  },
  {
    id: 11,
    name: 'order-ebics-order-id',
    up(db) {
      // The BANK's order number, from the mutable header of the response that
      // accepted the upload. Not the same thing as `transaction_id`, which
      // names one conversation and is meaningless once it ends.
      //
      // This is the handle the customer protocol (HAC) logs every action
      // under. Without it a HAC entry saying "signature refused, order A445"
      // cannot be tied to the payment file it refused, which makes the whole
      // protocol readable but not actionable.
      const columns = (db.prepare('PRAGMA table_info(orders)').all() as { name: string }[]).map((c) => c.name);
      if (!columns.includes('ebics_order_id')) {
        db.exec('ALTER TABLE orders ADD COLUMN ebics_order_id TEXT');
      }
      // Not unique: a bank may reuse an order number across customers, and
      // orders are looked up per connection anyway.
      db.exec('CREATE INDEX IF NOT EXISTS idx_orders_ebics_order ON orders (connection_id, ebics_order_id)');
    },
  },
  {
    id: 12,
    name: 'account-statements',
    up(db) {
      // Bookings, read out of a camt.053 and made queryable.
      //
      // This is the one place the "nothing derivable is stored" rule is bent,
      // and deliberately: a consumer asking "was invoice 42 paid?" needs to
      // search across every statement ever collected, by reference, by amount
      // and by date. Re-parsing every stored blob on each such question is not
      // a read model, it is a full scan.
      //
      // The bytes remain the record. These rows are rebuilt by clearing
      // `downloads.processed_at`, which is exactly what a fix to the parser
      // needs — so a better reader improves every statement already collected
      // rather than only the next one.
      db.exec(`
      CREATE TABLE IF NOT EXISTS statements (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        download_id     INTEGER NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
        connection_id   INTEGER NOT NULL REFERENCES bank_connections(id),
        public_id       TEXT    NOT NULL UNIQUE,        -- "stm_<hex>"
        -- The schema version the bank sent. Worth keeping: .02 and .08 differ
        -- in ways that decide how this row was read (see server/camt.ts).
        version         TEXT    NOT NULL,
        message_id      TEXT    NOT NULL,               -- GrpHdr/MsgId
        statement_id    TEXT    NOT NULL,               -- Stmt/Id
        electronic_seq  INTEGER,
        legal_seq       INTEGER,
        created_at      TEXT,
        from_date       TEXT,
        to_date         TEXT,
        account_iban    TEXT,
        account_other   TEXT,
        account_currency TEXT,
        account_name    TEXT,
        account_owner   TEXT,
        opening_balance TEXT,
        closing_balance TEXT,
        balance_currency TEXT,
        entry_count     INTEGER NOT NULL,
        stored_at       TEXT    NOT NULL
      );
      -- THE INVARIANT: one statement per account per identifier. A bank
      -- re-offering a file whose receipt it never saw must not double every
      -- booking on it — the download digest absorbs the usual case, and this
      -- absorbs a bank that regenerates the same statement with new bytes.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_statements_identity
        ON statements (connection_id, account_iban, statement_id);
      CREATE INDEX IF NOT EXISTS idx_statements_download ON statements (download_id);

      CREATE TABLE IF NOT EXISTS statement_entries (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        statement_id    INTEGER NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
        seq             INTEGER NOT NULL,               -- position in the file
        -- EXACTLY as the bank wrote it, unsigned. ISO puts the direction in a
        -- separate indicator and never a minus sign.
        amount          TEXT    NOT NULL,
        -- The amount times one hundred. NOT called amount_minor: minor units
        -- need the currency's exponent (2 for EUR, 0 for JPY, 3 for KWD), and
        -- that table is not something to transcribe from memory. Null when the
        -- bank sent more than two decimal places.
        amount_hundredths INTEGER,
        currency        TEXT    NOT NULL,
        credit          INTEGER NOT NULL,               -- 1 = money in
        reversal        INTEGER NOT NULL DEFAULT 0,
        status          TEXT    NOT NULL,               -- BOOK | PDNG | INFO
        booking_date    TEXT,
        value_date      TEXT,
        entry_ref       TEXT,
        account_servicer_ref TEXT,
        bank_transaction_code TEXT,
        end_to_end_id   TEXT,
        mandate_id      TEXT,
        msg_id          TEXT,
        payment_info_id TEXT,
        instruction_id  TEXT,
        counterparty_name TEXT,
        counterparty_iban TEXT,
        remittance      TEXT,
        creditor_reference TEXT,
        purpose         TEXT,
        return_reason   TEXT,
        additional_info TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_position
        ON statement_entries (statement_id, seq);
      -- The three a consumer actually searches by.
      CREATE INDEX IF NOT EXISTS idx_entries_e2e ON statement_entries (end_to_end_id);
      CREATE INDEX IF NOT EXISTS idx_entries_reference ON statement_entries (creditor_reference);
      CREATE INDEX IF NOT EXISTS idx_entries_booking ON statement_entries (booking_date);
      `);
    },
  },
  {
    id: 13,
    name: 'statement-source-message',
    up(db) {
      // WHICH of the three account messages a statement came out of.
      //
      // camt.052/053/054 carry the same entry structure — verified against the
      // Austrian schemas, which define ReportEntry2 identically in all three —
      // so one reader serves them. But they do NOT mean the same thing, and
      // storing them undifferentiated is a double-count waiting to happen:
      //
      //   statement     camt.053, end of day. The definitive record.
      //   report        camt.052, intraday and PROVISIONAL. Every booking on
      //                 it appears AGAIN on the day's statement.
      //   notification  camt.054, individual items as they happen. Same.
      //
      // So the source is recorded and `findEntries` defaults to statements
      // alone. A caller that wants to see money arriving before end of day has
      // to ask for it, exactly as with pending entries.
      //
      // Existing rows are statements: camt.053 is all this service could read
      // before this migration.
      const columns = (db.prepare('PRAGMA table_info(statements)').all() as { name: string }[]).map((c) => c.name);
      if (!columns.includes('source')) {
        db.exec("ALTER TABLE statements ADD COLUMN source TEXT NOT NULL DEFAULT 'statement'");
      }
      if (!columns.includes('message_name')) {
        db.exec('ALTER TABLE statements ADD COLUMN message_name TEXT');
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_statements_source ON statements (source)');
    },
  },
  {
    id: 14,
    name: 'entry-proprietary-transaction-code',
    up(db) {
      // The bank's OWN transaction code, beside the ISO domain code.
      //
      // The Austrian schemas make both `Domn` and `Prtry` mandatory on every
      // entry, so an Austrian bank always sends both. The reader used to prefer
      // the ISO code and fall back to the proprietary one — which in Austria
      // means the fallback never fires and the proprietary code, the one the
      // bank actually keys on, was dropped on every single booking.
      const columns = (db.prepare('PRAGMA table_info(statement_entries)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      if (!columns.includes('proprietary_transaction_code')) {
        db.exec('ALTER TABLE statement_entries ADD COLUMN proprietary_transaction_code TEXT');
      }
    },
  },
  {
    id: 15,
    name: 'entry-batch-count',
    up(db) {
      // How many payments one entry covers — null or 1 for the ordinary case.
      //
      // A collective credit is ONE movement on the account carrying many
      // customer payments. Its per-transaction references belong to the
      // individual payments and NOT to the entry, so `server/camt.ts` leaves
      // them null and records the count here instead. Without that, the first
      // transaction's invoice number was reported as the whole entry's, which
      // is the strongest possible evidence for a wrong conclusion.
      const columns = (db.prepare('PRAGMA table_info(statement_entries)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      if (!columns.includes('batch_count')) {
        db.exec('ALTER TABLE statement_entries ADD COLUMN batch_count INTEGER');
      }
    },
  },
  {
    id: 16,
    name: 'bank-exchanges',
    up(db) {
      // APPEND-ONLY: every HTTP round-trip with a bank, with the bytes.
      //
      // Until this table existed, a submitted payment left behind only the
      // parsed verdict. That is enough while everything works and useless in
      // the one conversation that matters: the bank says the signature was
      // wrong, or that nothing ever arrived, and there is nothing to put on
      // the table. The envelopes carry the ES signature and the encrypted
      // order data — never a private key, which never leaves `keystore.ts` in
      // plaintext — so keeping them is safe and is what makes a dispute
      // arguable from the record instead of from memory.
      db.exec(`
        CREATE TABLE IF NOT EXISTS bank_exchanges (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          connection_id INTEGER REFERENCES bank_connections(id) ON DELETE CASCADE,
          order_id      INTEGER REFERENCES orders(id) ON DELETE CASCADE,
          phase         TEXT    NOT NULL,   -- "order.initialisation", "hpb", "download.transfer", ...
          url           TEXT    NOT NULL,
          request       TEXT    NOT NULL,   -- the envelope as sent, byte for byte
          response      TEXT,               -- null when the bank never answered
          http_status   INTEGER,
          error         TEXT,               -- why it did not complete, when it did not
          started_at    TEXT    NOT NULL,
          finished_at   TEXT    NOT NULL,
          duration_ms   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_bank_exchanges_order ON bank_exchanges (order_id, id);
        CREATE INDEX IF NOT EXISTS idx_bank_exchanges_conn ON bank_exchanges (connection_id, id);
        CREATE INDEX IF NOT EXISTS idx_bank_exchanges_started ON bank_exchanges (started_at);
      `);
    },
  },
  {
    id: 17,
    name: 'order-event-actor',
    up(db) {
      // Who caused this step. `connection_events` has carried an actor since
      // migration 1; `order_events` did not, so a payment's own history could
      // say what happened and when but never on whose behalf — an operator
      // retrying by hand and the ticker looked identical.
      const columns = (db.prepare('PRAGMA table_info(order_events)').all() as { name: string }[]).map((c) => c.name);
      if (!columns.includes('actor')) {
        db.exec('ALTER TABLE order_events ADD COLUMN actor TEXT');
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
