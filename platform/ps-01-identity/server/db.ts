import Database from 'better-sqlite3';

/** Open (or create) the database and make sure the schema exists. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      slug       TEXT    NOT NULL UNIQUE,
      name       TEXT    NOT NULL,
      status     TEXT    NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'suspended')),
      created_at TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id        INTEGER NOT NULL REFERENCES organizations(id),
      email         TEXT    NOT NULL,
      name          TEXT    NOT NULL,
      password_hash TEXT    NOT NULL,
      token_version INTEGER NOT NULL DEFAULT 1,
      status        TEXT    NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'disabled')),
      created_at    TEXT    NOT NULL,
      UNIQUE (org_id, email)
    );

    CREATE TABLE IF NOT EXISTS roles (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id     INTEGER REFERENCES organizations(id),   -- NULL = system role
      key        TEXT    NOT NULL,
      name       TEXT    NOT NULL,
      is_system  INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL,
      UNIQUE (org_id, key)
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission TEXT    NOT NULL,
      UNIQUE (role_id, permission)
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      created_at TEXT    NOT NULL,
      UNIQUE (user_id, role_id)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id       INTEGER NOT NULL REFERENCES organizations(id),
      name         TEXT    NOT NULL,
      prefix       TEXT    NOT NULL UNIQUE,   -- non-secret; safe to display
      key_hash     TEXT    NOT NULL,          -- scrypt hash of the secret half
      created_by   INTEGER REFERENCES users(id),
      created_at   TEXT    NOT NULL,
      last_used_at TEXT,
      revoked_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      provider     TEXT    NOT NULL,
      state        TEXT    NOT NULL UNIQUE,
      redirect_uri TEXT,
      created_at   TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id     INTEGER,
      user_id    INTEGER,
      type       TEXT    NOT NULL
                 CHECK (type IN ('login_ok', 'login_fail', 'logout', 'token_issued',
                                 'apikey_created', 'apikey_revoked', 'password_changed')),
      ip         TEXT,
      meta       TEXT    NOT NULL DEFAULT '{}',
      created_at TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_users_org         ON users(org_id, email);
    CREATE INDEX IF NOT EXISTS idx_user_roles_user   ON user_roles(user_id);
    CREATE INDEX IF NOT EXISTS idx_role_perms_role   ON role_permissions(role_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_org      ON api_keys(org_id);
    CREATE INDEX IF NOT EXISTS idx_auth_events_org   ON auth_events(org_id, created_at, id);
  `);

  return db;
}
