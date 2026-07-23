import type Database from 'better-sqlite3';
import type { ChatMessage, ChatRole, Prompt } from '../shared/types.js';
import { CHAT_ROLES } from '../shared/types.js';
import { DomainError } from './errors.js';

export interface PromptRow {
  id: number;
  key: string;
  name: string;
  active_version: number;
  created_at: string;
}

export interface PromptVersionRow {
  id: number;
  prompt_id: number;
  version: number;
  template: string;
  notes: string | null;
  created_at: string;
}

export function promptByKey(db: Database.Database, key: string): PromptRow | undefined {
  return db.prepare('SELECT * FROM prompts WHERE key = ?').get(key) as PromptRow | undefined;
}

export function mapPrompt(db: Database.Database, row: PromptRow): Prompt {
  const versions = db
    .prepare('SELECT version FROM prompt_versions WHERE prompt_id = ? ORDER BY version')
    .all(row.id) as { version: number }[];
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    active_version: row.active_version,
    versions: versions.map((v) => v.version),
  };
}

/** Validate a prompt template body — an array of {role, content} messages. */
export function validateTemplate(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new DomainError(422, 'Validation failed', [{ field: 'template', message: 'must be a non-empty message array' }]);
  }
  return raw.map((m, i) => {
    const msg = m as { role?: unknown; content?: unknown };
    if (typeof msg.role !== 'string' || !(CHAT_ROLES as readonly string[]).includes(msg.role)) {
      throw new DomainError(422, 'Validation failed', [{ field: `template[${i}].role`, message: 'invalid role' }]);
    }
    if (typeof msg.content !== 'string') {
      throw new DomainError(422, 'Validation failed', [{ field: `template[${i}].content`, message: 'must be a string' }]);
    }
    return { role: msg.role as ChatRole, content: msg.content };
  });
}

const VAR_RE = /\{\{\s*(\w+)\s*\}\}/g;

/** Interpolate `{{var}}` in each message; a missing variable is a 422. */
export function renderMessages(template: ChatMessage[], vars: Record<string, unknown>): ChatMessage[] {
  const missing = new Set<string>();
  const rendered = template.map((m) => ({
    role: m.role,
    content: m.content.replace(VAR_RE, (_x, name: string) => {
      if (!(name in vars)) {
        missing.add(name);
        return '';
      }
      return String(vars[name] ?? '');
    }),
  }));
  if (missing.size > 0) {
    throw new DomainError(422, 'Missing prompt variables', [...missing].map((f) => ({ field: `variables.${f}`, message: 'is required' })));
  }
  return rendered;
}

/** The active version's template for a prompt key. */
export function activeTemplate(db: Database.Database, key: string): ChatMessage[] {
  const prompt = promptByKey(db, key);
  if (!prompt) throw new DomainError(404, 'Prompt not found');
  const row = db
    .prepare('SELECT * FROM prompt_versions WHERE prompt_id = ? AND version = ?')
    .get(prompt.id, prompt.active_version) as PromptVersionRow | undefined;
  if (!row) throw new DomainError(404, 'Active prompt version not found');
  return JSON.parse(row.template) as ChatMessage[];
}
