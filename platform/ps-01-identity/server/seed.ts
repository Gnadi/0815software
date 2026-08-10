import type Database from 'better-sqlite3';
import { hashPassword, nowIso } from './auth.js';
import { insertApiKey, prepareApiKey } from './api-keys.js';
import { SYSTEM_ROLES } from './rbac-config.js';

/**
 * Idempotent demo data. Two organizations (acme, globex) are seeded so
 * tenant isolation can be demonstrated end to end. Re-running is a no-op
 * once any organization exists.
 */
export async function seed(db: Database.Database): Promise<void> {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM organizations').get() as { n: number };
  if (existing.n > 0) return;

  const at = nowIso();

  // Password hashing is async (it runs off the event loop — see server/auth.ts)
  // and a better-sqlite3 transaction is synchronous, so every hash is computed
  // before the transaction opens. The writes themselves all stay inside the one
  // transaction, so a fresh database is either fully seeded or untouched —
  // a half-seeded one would never self-heal, since the guard above sees the
  // organizations and returns.
  const demoUsers = [
    { org: 'acme', email: 'owner@acme.test', name: 'Ada Owner', password: 'demo-owner', role: 'owner' },
    { org: 'acme', email: 'admin@acme.test', name: 'Alan Admin', password: 'demo-admin', role: 'admin' },
    { org: 'acme', email: 'member@acme.test', name: 'Mona Member', password: 'demo-member', role: 'member' },
    { org: 'globex', email: 'owner@globex.test', name: 'Greta Owner', password: 'demo-owner', role: 'owner' },
  ] as const;
  const hashes = new Map<string, string>(
    await Promise.all(
      demoUsers.map(async (u): Promise<[string, string]> => [u.email, await hashPassword(u.password)]),
    ),
  );

  const preparedKey = await prepareApiKey();

  let apiKeySecret = '';
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

    const createUser = (orgId: number, email: string, name: string, roleKey: string): void => {
      const info = db
        .prepare(
          `INSERT INTO users (org_id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(orgId, email, name, hashes.get(email), at);
      db.prepare('INSERT INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)').run(
        Number(info.lastInsertRowid),
        roleIdByKey.get(roleKey),
        at,
      );
    };

    const orgIdBySlug: Record<string, number> = {
      acme: createOrg('acme', 'Acme Corporation'),
      globex: createOrg('globex', 'Globex GmbH'),
    };
    for (const u of demoUsers) createUser(orgIdBySlug[u.org]!, u.email, u.name, u.role);

    const acmeOwner = db
      .prepare('SELECT id FROM users WHERE org_id = ? AND email = ?')
      .get(orgIdBySlug.acme, 'owner@acme.test') as { id: number };
    apiKeySecret = insertApiKey(db, preparedKey, orgIdBySlug.acme!, 'acme-ci', acmeOwner.id).secret;
  })();

  console.log(`[seed] acme API key (shown once): ${apiKeySecret}`);
  console.log('[seed] inserted 2 organizations, 4 users, system roles, 1 API key');
}

// CLI entry: npm run seed
const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { openDb } = await import('./db.js');
  const { configFromEnv } = await import('./config.js');
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  await seed(db);
  db.close();
  console.log(`[seed] done — database at ${config.databasePath}`);
}
