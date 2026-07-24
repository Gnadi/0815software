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

interface SystemRoleDef {
  key: SystemRoleKey;
  name: string;
  rank: number; // higher = more privileged
  permissions: readonly Permission[];
}

const ALL: readonly Permission[] = PERMISSIONS;

export const SYSTEM_ROLES: readonly SystemRoleDef[] = [
  {
    key: 'owner',
    name: 'Owner',
    rank: 4,
    permissions: ALL,
  },
  {
    key: 'admin',
    name: 'Administrator',
    rank: 3,
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
    rank: 2,
    permissions: ['org:read', 'user:read', 'role:read'],
  },
  {
    key: 'viewer',
    name: 'Viewer',
    rank: 1,
    permissions: ['org:read', 'user:read'],
  },
];

export const ROLE_RANK: Record<SystemRoleKey, number> = SYSTEM_ROLES.reduce(
  (acc, r) => {
    acc[r.key] = r.rank;
    return acc;
  },
  {} as Record<SystemRoleKey, number>,
);

export function systemRole(key: SystemRoleKey): SystemRoleDef {
  const role = SYSTEM_ROLES.find((r) => r.key === key);
  if (!role) throw new Error(`unknown system role: ${key}`);
  return role;
}

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
