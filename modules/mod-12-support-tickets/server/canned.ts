import type Database from 'better-sqlite3';
import { CANNED_PLACEHOLDERS, type CannedPlaceholder, type CannedResponse, type FieldError } from '../shared/types.js';
import { DomainError } from './tickets.js';

/**
 * Canned responses: the team's reply templates, kept by a manager (`manage`)
 * and used by every agent. A template may carry placeholders —
 * {{requester_name}}, {{requester_first_name}}, {{ticket_ref}}, {{subject}},
 * {{agent_name}} — which the server fills for one ticket, so the preview and
 * what is sent agree. An unknown placeholder is refused when the template is
 * saved, not discovered in a customer's inbox.
 *
 * The agent edits the filled text before it goes out; the reply records the
 * template it started from (`canned_id`), which is where the usage count
 * comes from. Deleting a template loses nothing: every reply holds its full
 * text.
 */

interface Row {
  id: number;
  title: string;
  body: string;
  active: number;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
  uses: number;
}

const toCanned = (r: Row): CannedResponse => ({ ...r, active: r.active === 1 });

const SELECT = `SELECT c.*, (SELECT COUNT(*) FROM ticket_events e WHERE e.type = 'comment' AND json_extract(e.payload, '$.canned_id') = c.id) AS uses
                  FROM canned_responses c`;

export function listCanned(db: Database.Database): CannedResponse[] {
  return (db.prepare(`${SELECT} ORDER BY c.active DESC, c.title COLLATE NOCASE`).all() as Row[]).map(toCanned);
}

export function getCanned(db: Database.Database, id: number): CannedResponse {
  const row = db.prepare(`${SELECT} WHERE c.id = ?`).get(id) as Row | undefined;
  if (!row) throw new DomainError(404, 'Canned response not found');
  return toCanned(row);
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;

function validate(input: Record<string, unknown>, partial: boolean): { title?: string; body?: string; active?: boolean } {
  const errors: FieldError[] = [];
  const out: { title?: string; body?: string; active?: boolean } = {};
  if (!partial || input.title !== undefined) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (title === '' || title.length > 120) errors.push({ field: 'title', message: 'is required (max 120 characters)' });
    out.title = title;
  }
  if (!partial || input.body !== undefined) {
    const body = typeof input.body === 'string' ? input.body.trim() : '';
    if (body === '' || body.length > 8000) errors.push({ field: 'body', message: 'is required (max 8000 characters)' });
    const unknown = [...body.matchAll(PLACEHOLDER)].map((m) => m[1]!).filter((name) => !(CANNED_PLACEHOLDERS as readonly string[]).includes(name));
    if (unknown.length > 0) errors.push({ field: 'body', message: `unknown placeholder ${unknown.map((n) => `{{${n}}}`).join(', ')} — use ${CANNED_PLACEHOLDERS.map((n) => `{{${n}}}`).join(', ')}` });
    out.body = body;
  }
  if (input.active !== undefined) {
    if (typeof input.active !== 'boolean') errors.push({ field: 'active', message: 'must be true or false' });
    out.active = input.active === true;
  }
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return out;
}

function uniqueTitle(db: Database.Database, title: string, exceptId: number | null): void {
  const clash = db.prepare('SELECT id FROM canned_responses WHERE title = ? COLLATE NOCASE AND id IS NOT ?').get(title, exceptId);
  if (clash) throw new DomainError(409, `A canned response called "${title}" exists already`);
}

export function createCanned(db: Database.Database, raw: Record<string, unknown>, actor: string, at: string): CannedResponse {
  const v = validate(raw, false);
  uniqueTitle(db, v.title!, null);
  const info = db
    .prepare('INSERT INTO canned_responses (title, body, active, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(v.title, v.body, v.active === false ? 0 : 1, actor, at, actor, at);
  return getCanned(db, Number(info.lastInsertRowid));
}

export function updateCanned(db: Database.Database, id: number, raw: Record<string, unknown>, actor: string, at: string): CannedResponse {
  const current = getCanned(db, id);
  const v = validate(raw, true);
  if (v.title !== undefined) uniqueTitle(db, v.title, id);
  db.prepare('UPDATE canned_responses SET title = ?, body = ?, active = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(
    v.title ?? current.title,
    v.body ?? current.body,
    (v.active ?? current.active) ? 1 : 0,
    actor,
    at,
    id,
  );
  return getCanned(db, id);
}

export function deleteCanned(db: Database.Database, id: number): void {
  getCanned(db, id);
  db.prepare('DELETE FROM canned_responses WHERE id = ?').run(id);
}

export interface RenderContext {
  requesterName: string;
  ticketRef: string;
  subject: string;
  agentName: string;
}

/** Fill a template for one ticket. */
export function renderTemplate(body: string, ctx: RenderContext): string {
  // A name that is only an address (mail intake without a display name) has
  // no first name to greet; the full address reads worse than none.
  const firstName = ctx.requesterName.includes('@') ? '' : (ctx.requesterName.trim().split(/\s+/)[0] ?? '');
  const values: Record<CannedPlaceholder, string> = {
    requester_name: ctx.requesterName,
    requester_first_name: firstName,
    ticket_ref: ctx.ticketRef,
    subject: ctx.subject,
    agent_name: ctx.agentName,
  };
  return body.replace(PLACEHOLDER, (whole, name: string) => (name in values ? values[name as CannedPlaceholder] : whole));
}
