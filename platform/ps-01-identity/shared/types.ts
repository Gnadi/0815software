/**
 * PS-01 Identity — wire contract shared between the server and any client.
 * The shape of every /api response is described here. No secrets
 * (password hashes, API-key secrets) ever appear in these types.
 */

// ── Enumerations ───────────────────────────────────────────────────────

export const ORG_STATUSES = ['active', 'suspended'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** The full permission catalog. Every role permission must be one of these. */
export const PERMISSIONS = [
  'org:read',
  'org:write',
  'user:read',
  'user:write',
  'role:read',
  'role:write',
  'apikey:read',
  'apikey:write',
  // Grants admin access to the downstream Platform Services (PS-02…10)
  // through the identity seam. Held by owner and admin system roles.
  'platform:admin',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const SYSTEM_ROLE_KEYS = ['owner', 'admin', 'member', 'viewer'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export function isOrgStatus(v: string): v is OrgStatus {
  return (ORG_STATUSES as readonly string[]).includes(v);
}
export function isUserStatus(v: string): v is UserStatus {
  return (USER_STATUSES as readonly string[]).includes(v);
}
export function isPermission(v: string): v is Permission {
  return (PERMISSIONS as readonly string[]).includes(v);
}

// ── Wire interfaces ────────────────────────────────────────────────────

export interface Organization {
  id: number;
  slug: string;
  name: string;
  status: OrgStatus;
  created_at: string;
}

export interface User {
  id: number;
  org_id: number;
  email: string;
  name: string;
  status: UserStatus;
  created_at: string;
}

export interface Role {
  id: number;
  org_id: number | null; // null = system role, shared across tenants
  key: string;
  name: string;
  is_system: boolean;
  permissions: Permission[];
}

export interface ApiKeySummary {
  id: number;
  name: string;
  prefix: string; // safe to display; the secret is shown only once at creation
  /**
   * The user who minted it, or null for a key created without one (the seed).
   *
   * Reported because a key outlives the session that made it, so "which keys
   * did the person who just left mint?" is a question an operator has to be
   * able to answer from the list. Before this it was answerable only through
   * the subject export, which needs the address you are already trying to
   * clean up after.
   */
  created_by: number | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** Claims carried inside a session token. */
export interface SessionClaims {
  userId: number;
  orgId: number;
  tokenVersion: number;
}

/** Result of GET /api/me. */
export interface Me {
  user: User;
  roles: Role[];
  permissions: Permission[];
}

export interface FieldError {
  field: string;
  message: string;
}
