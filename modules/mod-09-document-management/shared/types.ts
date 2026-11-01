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
  /** The retention class new documents in this matter get. */
  retention_class_id: number | null;
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

/** How a version may be shown in the browser — decided from its bytes. */
export type PreviewKind = 'pdf' | 'image' | 'text' | 'none';

/** Whether text could be read out of a version (`empty`: a scan, a picture). */
export type TextStatus = 'text' | 'empty' | 'encrypted' | 'unsupported' | 'failed';

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
  /** Null until the version's text has been read (just after an upgrade). */
  preview: PreviewKind | null;
  text_status: TextStatus | null;
  format: string | null;
}

/** A full-text match: the document and a passage around the words found. */
export interface SearchHit extends DocumentSummary {
  /** The passage; matches are wrapped in \u0002 … \u0003. */
  snippet: string;
}

// ── Settings ─────────────────────────────────────────────────────────────

/** Who may make share links: nobody, editors and owners, or owners only. */
export const SHARE_POLICIES = ['off', 'editor', 'owner'] as const;
export type SharePolicy = (typeof SHARE_POLICIES)[number];

export interface ModuleSettings {
  share_links: SharePolicy;
  share_default_days: number;
  share_max_days: number;
  share_require_password: boolean;
  updated_by_name: string | null;
  updated_at: string | null;
}

// ── Share links ──────────────────────────────────────────────────────────

export type ShareStatus = 'active' | 'expired' | 'revoked' | 'used_up';

export interface ShareLink {
  id: number;
  /** Null: the link always serves the current version. */
  version_no: number | null;
  expires_at: string;
  note: string;
  has_password: boolean;
  max_downloads: number | null;
  /** Derived from the link's events. */
  downloads: number;
  last_used_at: string | null;
  created_by_name: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by_name: string | null;
  status: ShareStatus;
  /** The signed-in user made it or owns the matter. */
  can_revoke: boolean;
}

/** What someone with the link sees — nothing about the matter or the people. */
export interface PublicShare {
  title: string;
  filename: string;
  size_bytes: number;
  version_no: number;
  preview: PreviewKind;
  expires_at: string;
  password_required: boolean;
  downloads_left: number | null;
}

// ── Retention ────────────────────────────────────────────────────────────

export interface RetentionClass {
  id: number;
  name: string;
  years: number;
  /** The legal source, as the administrator wrote it. */
  basis: string;
  document_count: number;
  created_at: string;
  updated_at: string | null;
}

export interface LegalHold {
  reason: string;
  by_name: string;
  at: string;
}

export interface RetentionInfo {
  class_id: number | null;
  class_name: string | null;
  years: number | null;
  basis: string | null;
  /** The date the period is counted from — the upload date unless one was set. */
  document_date: string;
  document_date_set: boolean;
  /** Derived: 31 December of (document year + years). Null without a class. */
  retention_end: string | null;
  /** The first day the document may be disposed of. */
  due_from: string | null;
  due: boolean;
  legal_hold: LegalHold | null;
}

export interface DocumentEvent {
  kind: 'retention_set' | 'hold_set' | 'hold_released' | 'share_created' | 'share_revoked';
  detail: string;
  actor_name: string;
  at: string;
}

export interface DueDocument {
  id: number;
  matter_id: number;
  matter_key: string;
  title: string;
  deleted: boolean;
  class_name: string;
  years: number;
  basis: string;
  document_date: string;
  retention_end: string;
  due_from: string;
  version_count: number;
  size_bytes: number;
}

export interface Disposal {
  id: number;
  document_id: number;
  matter_key: string;
  retention_class: string;
  years: number;
  basis: string;
  document_date: string;
  retention_end: string;
  versions: number;
  bytes: number;
  files_removed: number;
  mirrors: Record<string, string>;
  disposed_by_name: string;
  disposed_at: string;
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
  retention: RetentionInfo;
  /** Retention, hold and share decisions, newest first. */
  events: DocumentEvent[];
  /** The document's share links; null for someone who may not see them (viewers). */
  shares: ShareLink[] | null;
  share_policy: SharePolicy;
  can_share: boolean;
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
