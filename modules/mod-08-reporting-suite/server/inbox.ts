import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { ACCESS_LEVELS, type AccessLevel } from '@0815software/platform-clients';
import { MODULE_SLUG } from './access.js';
import { INBOX_VERSION, MAX_INBOX_ITEMS, type InboxItem, type ModuleInbox } from '../shared/summary.js';

/**
 * `GET /api/inbox?for=<email>&level=<view|edit|manage>` (copy-in) — what
 * waits for one person here, for a shell's badge and "Waiting for you" page
 * (shared/summary.ts, ModuleInbox).
 *
 * The stack's service token only: the shell asks on the person's behalf, at
 * the level PS-01 grants them here. What counts is the module's own rule
 * (`server/inbox-rules.ts`), counted from the rows on every request — so the
 * badge falls the moment the thing is done.
 */

export type InboxCollector = (person: string, level: AccessLevel) => { count: number; items: InboxItem[] };

function tokenMatches(provided: unknown, expected: string | undefined): boolean {
  if (!expected || typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function inboxHandler(serviceToken: string | undefined, collect: InboxCollector) {
  return (req: Request, res: Response): void => {
    if (!tokenMatches(req.headers['x-service-token'], serviceToken)) {
      res.status(401).json({ error: 'Service token required' });
      return;
    }
    const person = typeof req.query.for === 'string' ? req.query.for.trim().toLowerCase() : '';
    const level = req.query.level as AccessLevel;
    if (!person || !(ACCESS_LEVELS as readonly string[]).includes(level)) {
      res.status(422).json({ error: 'Validation failed', details: [{ field: 'for', message: 'and level are required' }] });
      return;
    }
    const { count, items } = collect(person, level);
    const body: ModuleInbox = { version: INBOX_VERSION, module: MODULE_SLUG, count: Math.max(count, items.length), items: items.slice(0, MAX_INBOX_ITEMS) };
    res.json(body);
  };
}

/** `edit` and above — the levels that may act on something, not just see it. */
export function mayAct(level: AccessLevel, needed: AccessLevel): boolean {
  return ACCESS_LEVELS.indexOf(level) >= ACCESS_LEVELS.indexOf(needed);
}
