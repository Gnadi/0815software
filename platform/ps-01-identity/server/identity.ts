import type Database from 'better-sqlite3';
import type { Organization, Permission, Role, User } from '../shared/types.js';

// ── Row shapes (as stored) ─────────────────────────────────────────────

export interface OrgRow {
  id: number;
  slug: string;
  name: string;
  status: string;
  created_at: string;
}

export interface UserRow {
  id: number;
  org_id: number;
  email: string;
  name: string;
  password_hash: string;
  token_version: number;
  status: string;
  created_at: string;
}

export interface RoleRow {
  id: number;
  org_id: number | null;
  key: string;
  name: string;
  is_system: number;
  created_at: string;
}

// ── Mappers (strip secrets, coerce types for the wire) ─────────────────

export function mapOrg(row: OrgRow): Organization {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status as Organization['status'],
    created_at: row.created_at,
  };
}

export function mapUser(row: UserRow): User {
  return {
    id: row.id,
    org_id: row.org_id,
    email: row.email,
    name: row.name,
    status: row.status as User['status'],
    created_at: row.created_at,
  };
}

export function rolePermissions(db: Database.Database, roleId: number): Permission[] {
  const rows = db
    .prepare('SELECT permission FROM role_permissions WHERE role_id = ? ORDER BY permission')
    .all(roleId) as { permission: string }[];
  return rows.map((r) => r.permission as Permission);
}

export function mapRole(db: Database.Database, row: RoleRow): Role {
  return {
    id: row.id,
    org_id: row.org_id,
    key: row.key,
    name: row.name,
    is_system: row.is_system === 1,
    permissions: rolePermissions(db, row.id),
  };
}

/** All roles a user holds, with their permissions. */
export function userRoles(db: Database.Database, userId: number): Role[] {
  const rows = db
    .prepare(
      `SELECT r.* FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = ?
       ORDER BY r.is_system DESC, r.key`,
    )
    .all(userId) as RoleRow[];
  return rows.map((row) => mapRole(db, row));
}

/** The distinct permission set granted to a user across all their roles. */
export function userPermissions(db: Database.Database, userId: number): Permission[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT rp.permission FROM role_permissions rp
       JOIN user_roles ur ON ur.role_id = rp.role_id
       WHERE ur.user_id = ?
       ORDER BY rp.permission`,
    )
    .all(userId) as { permission: string }[];
  return rows.map((r) => r.permission as Permission);
}

/** System roles (org_id NULL) plus the caller org's custom roles. */
export function listRoles(db: Database.Database, orgId: number): Role[] {
  const rows = db
    .prepare(
      `SELECT * FROM roles WHERE org_id IS NULL OR org_id = ?
       ORDER BY is_system DESC, key`,
    )
    .all(orgId) as RoleRow[];
  return rows.map((row) => mapRole(db, row));
}

/** A role usable by an org: either a system role or one the org owns. */
export function roleForOrg(db: Database.Database, roleId: number, orgId: number): RoleRow | undefined {
  return db
    .prepare('SELECT * FROM roles WHERE id = ? AND (org_id IS NULL OR org_id = ?)')
    .get(roleId, orgId) as RoleRow | undefined;
}
