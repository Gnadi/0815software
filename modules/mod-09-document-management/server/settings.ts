import type Database from 'better-sqlite3';
import { SHARE_POLICIES, type ModuleSettings, type SharePolicy } from '../shared/types.js';
import { DomainError, nowIso, type AuthUser } from './docs.js';

/**
 * What an administrator sets in the UI. Share links are the setting that
 * matters most: who may make them (nobody, editors and owners, or owners
 * only), how long they may live, and whether each needs a password.
 * Switching them off also stops every existing link from working — fail
 * closed rather than leave links out there the administrator thinks are dead.
 */

interface SettingsRow {
  share_links: SharePolicy;
  share_default_days: number;
  share_max_days: number;
  share_require_password: number;
  updated_by_name: string | null;
  updated_at: string | null;
}

const DEFAULTS: ModuleSettings = {
  share_links: 'editor',
  share_default_days: 14,
  share_max_days: 30,
  share_require_password: false,
  updated_by_name: null,
  updated_at: null,
};

export function readSettings(db: Database.Database): ModuleSettings {
  const row = db
    .prepare(
      `SELECT s.share_links, s.share_default_days, s.share_max_days, s.share_require_password, u.name AS updated_by_name, s.updated_at
       FROM module_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.id = 1`,
    )
    .get() as SettingsRow | undefined;
  return row ? { ...row, share_require_password: row.share_require_password === 1 } : DEFAULTS;
}

function days(raw: unknown, field: string, errors: { field: string; message: string }[]): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 365) {
    errors.push({ field, message: 'must be a whole number of days between 1 and 365' });
    return null;
  }
  return n;
}

/** Admins only (the route checks); a field left out keeps its value. */
export function writeSettings(db: Database.Database, user: AuthUser, raw: Record<string, unknown>): ModuleSettings {
  const current = readSettings(db);
  const errors: { field: string; message: string }[] = [];
  const policy = raw.share_links === undefined ? current.share_links : raw.share_links;
  if (typeof policy !== 'string' || !(SHARE_POLICIES as readonly string[]).includes(policy)) {
    errors.push({ field: 'share_links', message: `must be one of: ${SHARE_POLICIES.join(', ')}` });
  }
  const defaultDays = raw.share_default_days === undefined ? current.share_default_days : days(raw.share_default_days, 'share_default_days', errors);
  const maxDays = raw.share_max_days === undefined ? current.share_max_days : days(raw.share_max_days, 'share_max_days', errors);
  if (defaultDays !== null && maxDays !== null && defaultDays > maxDays) {
    errors.push({ field: 'share_default_days', message: 'cannot be longer than the maximum' });
  }
  const requirePassword = raw.share_require_password === undefined ? current.share_require_password : raw.share_require_password === true;
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  db.prepare(
    `INSERT INTO module_settings (id, share_links, share_default_days, share_max_days, share_require_password, updated_by, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET share_links = excluded.share_links, share_default_days = excluded.share_default_days,
       share_max_days = excluded.share_max_days, share_require_password = excluded.share_require_password,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(policy, defaultDays, maxDays, requirePassword ? 1 : 0, user.id, nowIso());
  return readSettings(db);
}
