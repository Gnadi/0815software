import { PERMISSIONS, SYSTEM_ROLE_KEYS, type Permission, type SystemRoleKey } from '../shared/types.js';

/**
 * The canonical definition of the built-in system roles: their display
 * names, the permissions they grant, and their ordinal rank. This is
 * config-as-code — the seed writes these into the `roles` /
 * `role_permissions` tables so that, at runtime, the database is the
 * single source of truth for permission checks. The import-time
 * self-check below guarantees the config can never reference an unknown
 * permission.
 */

/**
 * No `rank` field, deliberately.
 *
 * There used to be one, plus a `ROLE_RANK` map and a `systemRole()` lookup, and
 * nothing in the service ever read any of them — the seed imports
 * `SYSTEM_ROLES` and that is all. A ladder that nobody consults is worse than
 * no ladder: it reads like a live control, so the question it appears to answer
 * ("may an Administrator act on an Owner?") looks handled when it is not, and
 * it was not — see `requireNotAbove` in server/app.ts for the door that stood
 * open behind it.
 *
 * The control that replaced it compares PERMISSION SETS, which a rank cannot
 * do: a custom role has no rank, and a custom role granting `org:write` has to
 * be caught by the same rule that catches the Owner.
 */
interface SystemRoleDef {
  key: SystemRoleKey;
  name: string;
  permissions: readonly Permission[];
}

const ALL: readonly Permission[] = PERMISSIONS;

export const SYSTEM_ROLES: readonly SystemRoleDef[] = [
  {
    key: 'owner',
    name: 'Owner',
    permissions: ALL,
  },
  {
    key: 'admin',
    name: 'Administrator',
    permissions: [
      'org:read',
      'user:read',
      'user:write',
      'role:read',
      'role:write',
      'apikey:read',
      'apikey:write',
      'platform:admin',
    ],
  },
  {
    key: 'member',
    name: 'Member',
    permissions: ['org:read', 'user:read', 'role:read'],
  },
  {
    key: 'viewer',
    name: 'Viewer',
    permissions: ['org:read', 'user:read'],
  },
];

// ── Import-time self-check ─────────────────────────────────────────────
// Fail fast on a misconfigured role table rather than at request time.
(function selfCheck(): void {
  const catalog = new Set<string>(PERMISSIONS);
  const keys = new Set<string>();
  for (const role of SYSTEM_ROLES) {
    if (!SYSTEM_ROLE_KEYS.includes(role.key)) {
      throw new Error(`rbac-config: unexpected role key "${role.key}"`);
    }
    if (keys.has(role.key)) throw new Error(`rbac-config: duplicate role key "${role.key}"`);
    keys.add(role.key);
    for (const perm of role.permissions) {
      if (!catalog.has(perm)) {
        throw new Error(`rbac-config: role "${role.key}" grants unknown permission "${perm}"`);
      }
    }
  }
  for (const key of SYSTEM_ROLE_KEYS) {
    if (!keys.has(key)) throw new Error(`rbac-config: missing system role "${key}"`);
  }
})();
