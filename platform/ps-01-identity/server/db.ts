import Database from 'better-sqlite3';
import { runMigrations, type Migration } from './migrations.js';

/**
 * Ordered schema migrations. 001 is the v1 baseline — idempotent
 * `CREATE TABLE IF NOT EXISTS`, so databases created before the runner adopt
 * it cleanly. Never edit a shipped migration; append a new one instead.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'baseline',
    up(db) {
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
        scopes       TEXT    NOT NULL DEFAULT '', -- JSON Permission[]; '' = all
        created_by   INTEGER REFERENCES users(id),
        created_at   TEXT    NOT NULL,
        last_used_at TEXT,
        revoked_at   TEXT
      );

      CREATE TABLE IF NOT EXISTS oauth_states (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        provider     TEXT    NOT NULL,
        state        TEXT    NOT NULL UNIQUE,
        org_slug     TEXT,
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
    },
  },
  {
    id: 2,
    name: 'oauth_states-org_slug',
    up(db) {
      const cols = db.prepare("PRAGMA table_info('oauth_states')").all() as { name: string }[];
      if (!cols.some((c) => c.name === 'org_slug')) db.exec('ALTER TABLE oauth_states ADD COLUMN org_slug TEXT');
    },
  },
  {
    id: 3,
    name: 'api_keys-scopes',
    up(db) {
      const cols = db.prepare("PRAGMA table_info('api_keys')").all() as { name: string }[];
      if (!cols.some((c) => c.name === 'scopes')) db.exec("ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    id: 4,
    name: 'auth_events-user_erased-type',
    up(db) {
      // SQLite can't alter a CHECK in place — rebuild the table with the
      // widened type set (adds 'user_erased' for the GDPR erasure hook).
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_events'").get();
      db.exec(`
      CREATE TABLE auth_events_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id     INTEGER,
        user_id    INTEGER,
        type       TEXT    NOT NULL
                   CHECK (type IN ('login_ok', 'login_fail', 'logout', 'token_issued',
                                   'apikey_created', 'apikey_revoked', 'password_changed',
                                   'user_erased')),
        ip         TEXT,
        meta       TEXT    NOT NULL DEFAULT '{}',
        created_at TEXT    NOT NULL
      );`);
      if (exists) {
        db.exec(`
        INSERT INTO auth_events_new (id, org_id, user_id, type, ip, meta, created_at)
          SELECT id, org_id, user_id, type, ip, meta, created_at FROM auth_events;
        DROP TABLE auth_events;`);
      }
      db.exec(`
      ALTER TABLE auth_events_new RENAME TO auth_events;
      CREATE INDEX IF NOT EXISTS idx_auth_events_org ON auth_events(org_id, created_at, id);
    `);
    },
  },
  {
    id: 5,
    name: 'auth_events-password_change_denied-type',
    up(db) {
      // Same rebuild as migration 4, for the failed self-service password
      // change — a burst of these is what a stolen session looks like, so it
      // has to be on the trail.
      db.exec(`
      CREATE TABLE auth_events_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id     INTEGER,
        user_id    INTEGER,
        type       TEXT    NOT NULL
                   CHECK (type IN ('login_ok', 'login_fail', 'logout', 'token_issued',
                                   'apikey_created', 'apikey_revoked', 'password_changed',
                                   'password_change_denied', 'user_erased')),
        ip         TEXT,
        meta       TEXT    NOT NULL DEFAULT '{}',
        created_at TEXT    NOT NULL
      );
      INSERT INTO auth_events_new (id, org_id, user_id, type, ip, meta, created_at)
        SELECT id, org_id, user_id, type, ip, meta, created_at FROM auth_events;
      DROP TABLE auth_events;
      ALTER TABLE auth_events_new RENAME TO auth_events;
      CREATE INDEX IF NOT EXISTS idx_auth_events_org ON auth_events(org_id, created_at, id);
    `);
    },
  },
  {
    id: 6,
    name: 'auth_events-sessions_revoked-type',
    up(db) {
      // Same rebuild again, for the explicit session revocation. (SQLite still
      // cannot alter a CHECK in place; a widened type set is a new table.)
      db.exec(`
      CREATE TABLE auth_events_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id     INTEGER,
        user_id    INTEGER,
        type       TEXT    NOT NULL
                   CHECK (type IN ('login_ok', 'login_fail', 'logout', 'token_issued',
                                   'apikey_created', 'apikey_revoked', 'password_changed',
                                   'password_change_denied', 'sessions_revoked', 'user_erased')),
        ip         TEXT,
        meta       TEXT    NOT NULL DEFAULT '{}',
        created_at TEXT    NOT NULL
      );
      INSERT INTO auth_events_new (id, org_id, user_id, type, ip, meta, created_at)
        SELECT id, org_id, user_id, type, ip, meta, created_at FROM auth_events;
      DROP TABLE auth_events;
      ALTER TABLE auth_events_new RENAME TO auth_events;
      CREATE INDEX IF NOT EXISTS idx_auth_events_org ON auth_events(org_id, created_at, id);
    `);
    },
  },
  {
    id: 7,
    name: 'login_throttle',
    up(db) {
      // Failed logins per submitted (org, email) — see server/throttle.ts for
      // why the key is what was TYPED rather than an account that exists.
      db.exec(`
      CREATE TABLE IF NOT EXISTS login_throttle (
        key        TEXT    PRIMARY KEY,
        fails      INTEGER NOT NULL,
        updated_at TEXT    NOT NULL
      );
    `);
    },
  },
  {
    id: 8,
    name: 'two-factor',
    up(db) {
      // A second factor per user (server/mfa.ts). The pending pair holds a
      // secret between "show me the QR code" and "here is the first code" — an
      // account is only switched over once its owner has proved the phone
      // produces the right digits, or a mistyped scan would lock them out.
      // `totp_last_step` is the replay guard: a code is dead once used.
      // A database that never had a users table (the partial v1 shape the
      // upgrade test builds) has nothing to widen; there is no user to protect.
      const cols = db.prepare("PRAGMA table_info('users')").all() as { name: string }[];
      const add = (name: string, type: string): void => {
        if (cols.length > 0 && !cols.some((c) => c.name === name)) {
          db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
        }
      };
      add('totp_secret', 'TEXT');
      add('totp_enabled_at', 'TEXT');
      add('totp_last_step', 'INTEGER');
      add('totp_pending_secret', 'TEXT');
      add('totp_pending_at', 'TEXT');
      db.exec(`
      CREATE TABLE IF NOT EXISTS recovery_codes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash  TEXT    NOT NULL,
        created_at TEXT    NOT NULL,
        used_at    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id);

      CREATE TABLE auth_events_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id     INTEGER,
        user_id    INTEGER,
        type       TEXT    NOT NULL
                   CHECK (type IN ('login_ok', 'login_fail', 'logout', 'token_issued',
                                   'apikey_created', 'apikey_revoked', 'password_changed',
                                   'password_change_denied', 'sessions_revoked', 'user_erased',
                                   'mfa_enabled', 'mfa_disabled', 'mfa_reset', 'mfa_failed',
                                   'recovery_code_used', 'recovery_codes_renewed')),
        ip         TEXT,
        meta       TEXT    NOT NULL DEFAULT '{}',
        created_at TEXT    NOT NULL
      );
      INSERT INTO auth_events_new (id, org_id, user_id, type, ip, meta, created_at)
        SELECT id, org_id, user_id, type, ip, meta, created_at FROM auth_events;
      DROP TABLE auth_events;
      ALTER TABLE auth_events_new RENAME TO auth_events;
      CREATE INDEX IF NOT EXISTS idx_auth_events_org ON auth_events(org_id, created_at, id);
    `);
    },
  },
  {
    id: 9,
    name: 'two-factor-policy-and-devices',
    up(db) {
      // `mfa_required`: the organization's "two-factor or no sign-in" switch.
      // `known_devices`: the coarse device labels a person signed in from, so
      // a new one can be told to them (server/security-notify.ts).
      const orgCols = db.prepare("PRAGMA table_info('organizations')").all() as { name: string }[];
      if (orgCols.length > 0 && !orgCols.some((c) => c.name === 'mfa_required')) {
        db.exec('ALTER TABLE organizations ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0');
      }
      db.exec(`
      CREATE TABLE IF NOT EXISTS known_devices (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        fingerprint TEXT    NOT NULL,
        label       TEXT    NOT NULL,
        first_seen  TEXT    NOT NULL,
        last_seen   TEXT    NOT NULL,
        UNIQUE (user_id, fingerprint)
      );

      CREATE TABLE auth_events_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id     INTEGER,
        user_id    INTEGER,
        type       TEXT    NOT NULL
                   CHECK (type IN ('login_ok', 'login_fail', 'logout', 'token_issued',
                                   'apikey_created', 'apikey_revoked', 'password_changed',
                                   'password_change_denied', 'sessions_revoked', 'user_erased',
                                   'mfa_enabled', 'mfa_disabled', 'mfa_reset', 'mfa_failed',
                                   'recovery_code_used', 'recovery_codes_renewed',
                                   'mfa_policy_changed', 'new_device')),
        ip         TEXT,
        meta       TEXT    NOT NULL DEFAULT '{}',
        created_at TEXT    NOT NULL
      );
      INSERT INTO auth_events_new (id, org_id, user_id, type, ip, meta, created_at)
        SELECT id, org_id, user_id, type, ip, meta, created_at FROM auth_events;
      DROP TABLE auth_events;
      ALTER TABLE auth_events_new RENAME TO auth_events;
      CREATE INDEX IF NOT EXISTS idx_auth_events_org ON auth_events(org_id, created_at, id);
    `);
    },
  },
];

/** Open (or create) the database, apply pragmas, and run pending migrations. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db, MIGRATIONS);
  return db;
}
