import type Database from 'better-sqlite3';
import { hashPassword, nowIso } from './auth.js';
import { mintApiKey } from './api-keys.js';
import { SYSTEM_ROLES } from './rbac-config.js';

/**
 * Idempotent demo data. Two organizations (acme, globex) are seeded so
 * tenant isolation can be demonstrated end to end. Re-running is a no-op
 * once any organization exists.
 */
export function seed(db: Database.Database): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM organizations').get() as { n: number };
  if (existing.n > 0) return;

  const at = nowIso();

  db.transaction(() => {
    // System roles + their permissions (config → tables).
    const roleIdByKey = new Map<string, number>();
    for (const role of SYSTEM_ROLES) {
      const info = db
        .prepare(`INSERT INTO roles (org_id, key, name, is_system, created_at) VALUES (NULL, ?, ?, 1, ?)`)
        .run(role.key, role.name, at);
      const roleId = Number(info.lastInsertRowid);
      roleIdByKey.set(role.key, roleId);
      for (const perm of role.permissions) {
        db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)').run(roleId, perm);
      }
    }

    const createOrg = (slug: string, name: string): number => {
      const info = db
        .prepare(`INSERT INTO organizations (slug, name, status, created_at) VALUES (?, ?, 'active', ?)`)
        .run(slug, name, at);
      return Number(info.lastInsertRowid);
    };

    const createUser = (orgId: number, email: string, name: string, password: string, roleKey: string): void => {
      const info = db
        .prepare(
          `INSERT INTO users (org_id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(orgId, email, name, hashPassword(password), at);
      db.prepare('INSERT INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)').run(
        Number(info.lastInsertRowid),
        roleIdByKey.get(roleKey),
        at,
      );
    };

    const acme = createOrg('acme', 'Acme Corporation');
    createUser(acme, 'owner@acme.test', 'Ada Owner', 'demo-owner', 'owner');
    createUser(acme, 'admin@acme.test', 'Alan Admin', 'demo-admin', 'admin');
    createUser(acme, 'member@acme.test', 'Mona Member', 'demo-member', 'member');

    const globex = createOrg('globex', 'Globex GmbH');
    createUser(globex, 'owner@globex.test', 'Greta Owner', 'demo-owner', 'owner');

    const acmeOwner = db
      .prepare('SELECT id FROM users WHERE org_id = ? AND email = ?')
      .get(acme, 'owner@acme.test') as { id: number };
    const minted = mintApiKey(db, acme, 'acme-ci', acmeOwner.id);
    console.log(`[seed] acme API key (shown once): ${minted.secret}`);
  })();

  console.log('[seed] inserted 2 organizations, 4 users, system roles, 1 API key');
}

// CLI entry: npm run seed
const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { openDb } = await import('./db.js');
  const { configFromEnv } = await import('./config.js');
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  seed(db);
  db.close();
  console.log(`[seed] done — database at ${config.databasePath}`);
}
