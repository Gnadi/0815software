import type Database from 'better-sqlite3';
import type { ChannelType, RenderedMessage, Template } from '../shared/types.js';
import { DomainError } from './errors.js';

export interface TemplateRow {
  id: number;
  key: string;
  version: number;
  channel_type: string;
  locale: string;
  subject: string | null;
  body: string;
  created_at: string;
}

export function mapTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    key: row.key,
    version: row.version,
    channel_type: row.channel_type as ChannelType,
    locale: row.locale,
    subject: row.subject,
    body: row.body,
    created_at: row.created_at,
  };
}

/** Escape HTML-significant characters in interpolated values (contact.ts). */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const VAR_RE = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * Replace `{{var}}` placeholders. Every referenced variable must be
 * present, otherwise a 422 lists the missing names. Values are
 * HTML-escaped for channel types that render markup (email).
 */
function interpolate(text: string, vars: Record<string, unknown>, escape: boolean): string {
  const missing = new Set<string>();
  const out = text.replace(VAR_RE, (_m, name: string) => {
    // OWN properties only. `in` also finds everything on Object.prototype, so
    // `{{constructor}}` counted as "supplied" and rendered
    // "function Object() { [native code] }" into the outgoing message instead
    // of raising the 422 this function promises.
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      missing.add(name);
      return '';
    }
    const raw = String(vars[name] ?? '');
    return escape ? esc(raw) : raw;
  });
  if (missing.size > 0) {
    throw new DomainError(422, 'Missing template variables', [
      ...missing,
    ].map((field) => ({ field: `variables.${field}`, message: 'is required' })));
  }
  return out;
}

export function renderTemplate(
  row: Pick<TemplateRow, 'subject' | 'body' | 'channel_type'>,
  vars: Record<string, unknown>,
): RenderedMessage {
  const escape = row.channel_type === 'email';
  return {
    subject: row.subject === null ? null : interpolate(row.subject, vars, escape),
    body: interpolate(row.body, vars, escape),
  };
}

/** The highest version stored for a template key. */
export function latestTemplate(db: Database.Database, key: string): TemplateRow | undefined {
  return db
    .prepare('SELECT * FROM templates WHERE key = ? ORDER BY version DESC LIMIT 1')
    .get(key) as TemplateRow | undefined;
}
