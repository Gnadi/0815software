import Database from 'better-sqlite3';

/** Open (or create) the database and make sure the schema exists. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      name          TEXT    NOT NULL,
      role          TEXT    NOT NULL CHECK (role IN ('admin', 'member')),
      password_hash TEXT    NOT NULL,
      token_version INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS matters (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      key         TEXT    NOT NULL UNIQUE,
      name        TEXT    NOT NULL,
      description TEXT    NOT NULL DEFAULT '',
      created_by  INTEGER NOT NULL REFERENCES users(id),
      created_at  TEXT    NOT NULL
    );

    -- The access boundary: a (user, matter) grant with a per-matter role.
    CREATE TABLE IF NOT EXISTS matter_members (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      matter_id  INTEGER NOT NULL REFERENCES matters(id),
      user_id    INTEGER NOT NULL REFERENCES users(id),
      role       TEXT    NOT NULL CHECK (role IN ('viewer', 'editor', 'owner')),
      created_at TEXT    NOT NULL,
      UNIQUE (matter_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS documents (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      matter_id  INTEGER NOT NULL REFERENCES matters(id),
      title      TEXT    NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT    NOT NULL,
      deleted_at TEXT    -- soft delete: non-null hides the document
    );

    -- Append-only version chain. Rows are never updated or deleted; a new
    -- upload inserts a new row with the next gapless version_no.
    CREATE TABLE IF NOT EXISTS document_versions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id    INTEGER NOT NULL REFERENCES documents(id),
      version_no     INTEGER NOT NULL,
      size_bytes     INTEGER NOT NULL,
      sha256         TEXT    NOT NULL,
      content_type   TEXT    NOT NULL,
      filename       TEXT    NOT NULL,
      storage_path   TEXT    NOT NULL, -- content-addressed name under STORAGE_DIR
      uploaded_by    INTEGER NOT NULL REFERENCES users(id),
      uploaded_at    TEXT    NOT NULL,
      UNIQUE (document_id, version_no)
    );

    CREATE TABLE IF NOT EXISTS document_tags (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id),
      tag         TEXT    NOT NULL,
      UNIQUE (document_id, tag)
    );

    -- Text read out of each version (server/extract.ts). Derived from bytes
    -- that never change and kept so search and preview need not re-read every
    -- file; read again when the readers improve (extractor < EXTRACTOR_VERSION).
    CREATE TABLE IF NOT EXISTS version_text (
      version_id   INTEGER PRIMARY KEY REFERENCES document_versions(id),
      format       TEXT    NOT NULL,
      preview      TEXT    NOT NULL CHECK (preview IN ('pdf', 'image', 'text', 'none')),
      status       TEXT    NOT NULL CHECK (status IN ('text', 'empty', 'encrypted', 'unsupported', 'failed')),
      text         TEXT    NOT NULL DEFAULT '',
      extractor    INTEGER NOT NULL,
      extracted_at TEXT    NOT NULL
    );

    -- The full-text index: one row per live document (rowid = document id),
    -- holding its title, its CURRENT version's text and its tags. Rebuilt
    -- from the rows above whenever they change (server/search.ts).
    CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(
      title, body, tags, tokenize = 'unicode61 remove_diacritics 2'
    );

    -- What an administrator sets in the UI. One row.
    CREATE TABLE IF NOT EXISTS module_settings (
      id                     INTEGER PRIMARY KEY CHECK (id = 1),
      share_links            TEXT    NOT NULL DEFAULT 'editor' CHECK (share_links IN ('off', 'editor', 'owner')),
      share_default_days     INTEGER NOT NULL DEFAULT 14 CHECK (share_default_days BETWEEN 1 AND 365),
      share_max_days         INTEGER NOT NULL DEFAULT 30 CHECK (share_max_days BETWEEN 1 AND 365),
      share_require_password INTEGER NOT NULL DEFAULT 0 CHECK (share_require_password IN (0, 1)),
      updated_by             INTEGER REFERENCES users(id),
      updated_at             TEXT
    );

    -- A link that lets someone without an account fetch one document. Only a
    -- hash of the token is stored: the link itself is shown once, to the
    -- person who made it.
    CREATE TABLE IF NOT EXISTS share_links (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id   INTEGER NOT NULL REFERENCES documents(id),
      version_no    INTEGER,          -- NULL: always the current version
      token_hash    TEXT    NOT NULL UNIQUE,
      password_hash TEXT,
      max_downloads INTEGER CHECK (max_downloads IS NULL OR max_downloads > 0),
      expires_at    TEXT    NOT NULL,
      note          TEXT    NOT NULL DEFAULT '',
      created_by    INTEGER NOT NULL REFERENCES users(id),
      created_at    TEXT    NOT NULL,
      revoked_at    TEXT,
      revoked_by    INTEGER REFERENCES users(id),
      CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
    );

    -- Append-only: every use of a link, and every wrong password. Downloads
    -- left on a link are derived from it, never counted down in place.
    CREATE TABLE IF NOT EXISTS share_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER NOT NULL REFERENCES share_links(id),
      kind    TEXT    NOT NULL CHECK (kind IN ('opened', 'previewed', 'downloaded', 'password_failed')),
      at      TEXT    NOT NULL
    );

    -- Retention classes an administrator maintains: how many years, and the
    -- law that says so. A period always starts at the end of the calendar
    -- year of the document's date (server/retention.ts).
    CREATE TABLE IF NOT EXISTS retention_classes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE,
      years      INTEGER NOT NULL CHECK (years BETWEEN 1 AND 100),
      basis      TEXT    NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT    NOT NULL,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT
    );

    -- Append-only history of what was decided about a document beyond its
    -- versions: retention, legal holds, share links.
    CREATE TABLE IF NOT EXISTS document_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id),
      kind        TEXT    NOT NULL CHECK (kind IN ('retention_set', 'hold_set', 'hold_released', 'share_created', 'share_revoked')),
      detail      TEXT    NOT NULL DEFAULT '',
      actor_id    INTEGER NOT NULL REFERENCES users(id),
      at          TEXT    NOT NULL
    );

    -- What remains of a disposed document: which rule allowed it, who did it,
    -- and the hashes of what was destroyed — no title, no content.
    CREATE TABLE IF NOT EXISTS disposals (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id     INTEGER NOT NULL UNIQUE,
      matter_id       INTEGER NOT NULL REFERENCES matters(id),
      retention_class TEXT    NOT NULL,
      years           INTEGER NOT NULL,
      basis           TEXT    NOT NULL,
      document_date   TEXT    NOT NULL,
      retention_end   TEXT    NOT NULL,
      versions        INTEGER NOT NULL,
      bytes           INTEGER NOT NULL,
      sha256          TEXT    NOT NULL,  -- JSON array, one per version
      files_removed   INTEGER NOT NULL,  -- blobs no other version still uses
      mirrors         TEXT    NOT NULL DEFAULT '{}',
      disposed_by     INTEGER NOT NULL REFERENCES users(id),
      disposed_at     TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_members_matter  ON matter_members(matter_id);
    CREATE INDEX IF NOT EXISTS idx_members_user    ON matter_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_documents_matter ON documents(matter_id);
    CREATE INDEX IF NOT EXISTS idx_versions_document ON document_versions(document_id);
    CREATE INDEX IF NOT EXISTS idx_tags_document    ON document_tags(document_id);
    CREATE INDEX IF NOT EXISTS idx_tags_tag         ON document_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_share_document   ON share_links(document_id);
    CREATE INDEX IF NOT EXISTS idx_share_events     ON share_events(link_id);
    CREATE INDEX IF NOT EXISTS idx_doc_events       ON document_events(document_id);
  `);

  // Retention on documents and a default per matter: added in place to an
  // existing database, NULL meaning "no class — never due".
  const columns = (table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const documentColumns = columns('documents');
  const add = (table: string, have: string[], column: string, definition: string): void => {
    if (!have.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  add('documents', documentColumns, 'retention_class_id', 'INTEGER REFERENCES retention_classes(id)');
  add('documents', documentColumns, 'document_date', 'TEXT');
  add('documents', documentColumns, 'legal_hold_reason', 'TEXT');
  add('documents', documentColumns, 'legal_hold_by', 'INTEGER REFERENCES users(id)');
  add('documents', documentColumns, 'legal_hold_at', 'TEXT');
  add('matters', columns('matters'), 'retention_class_id', 'INTEGER REFERENCES retention_classes(id)');

  return db;
}
