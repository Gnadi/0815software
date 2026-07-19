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

    CREATE INDEX IF NOT EXISTS idx_members_matter  ON matter_members(matter_id);
    CREATE INDEX IF NOT EXISTS idx_members_user    ON matter_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_documents_matter ON documents(matter_id);
    CREATE INDEX IF NOT EXISTS idx_versions_document ON document_versions(document_id);
    CREATE INDEX IF NOT EXISTS idx_tags_document    ON document_tags(document_id);
    CREATE INDEX IF NOT EXISTS idx_tags_tag         ON document_tags(tag);
  `);

  return db;
}
