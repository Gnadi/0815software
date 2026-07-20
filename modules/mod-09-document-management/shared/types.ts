/**
 * Types shared between the API server and the React client.
 * The wire format of every /api response is described here.
 */

export const GLOBAL_ROLES = ['admin', 'member'] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

/**
 * Per-matter access levels, in ascending order of privilege:
 *   viewer < editor < owner
 * - viewer  can read and download
 * - editor  can also upload new documents and versions, and edit tags
 * - owner   can also manage matter members and soft-delete documents
 * Admins implicitly hold `owner` on every matter.
 */
export const MATTER_ROLES = ['viewer', 'editor', 'owner'] as const;
export type MatterRole = (typeof MATTER_ROLES)[number];

export const MATTER_ROLE_RANK: Record<MatterRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

export function isMatterRole(value: string): value is MatterRole {
  return (MATTER_ROLES as readonly string[]).includes(value);
}

export function isGlobalRole(value: string): value is GlobalRole {
  return (GLOBAL_ROLES as readonly string[]).includes(value);
}

export interface UserProfile {
  id: number;
  username: string;
  name: string;
  role: GlobalRole;
  created_at: string;
}

/** A user as seen in the shared directory (for picking matter members). */
export interface UserRef {
  id: number;
  username: string;
  name: string;
  role: GlobalRole;
}

export interface MatterSummary {
  id: number;
  key: string;
  name: string;
  description: string;
  created_at: string;
  /** The signed-in user's effective role on this matter. */
  role: MatterRole;
  /** Number of non-deleted documents visible in this matter. */
  document_count: number;
  member_count: number;
}

export interface MatterMember {
  user_id: number;
  username: string;
  name: string;
  role: MatterRole;
  created_at: string;
}

export interface DocumentTag {
  tag: string;
}

export interface DocumentSummary {
  id: number;
  matter_id: number;
  matter_key: string;
  title: string;
  created_at: string;
  created_by_name: string;
  deleted_at: string | null;
  /** Highest version number = the current version. */
  current_version: number;
  version_count: number;
  updated_at: string;
  tags: string[];
}

export interface DocumentVersion {
  id: number;
  version_no: number;
  size_bytes: number;
  sha256: string;
  content_type: string;
  filename: string;
  uploaded_by_id: number;
  uploaded_by_name: string;
  uploaded_at: string;
}

export interface ActivityEntry {
  kind: 'document_created' | 'version_added';
  version_no: number;
  at: string;
  actor_name: string;
  detail: string;
}

export interface DocumentDetail {
  document: DocumentSummary;
  versions: DocumentVersion[];
  activity: ActivityEntry[];
  /** The signed-in user's effective role on the owning matter. */
  matter_role: MatterRole;
  matter_key: string;
}

/** Format a byte count as a short human string, e.g. "12.3 KB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
