import type Database from 'better-sqlite3';
import {
  appliedFilters,
  SUMMARY_VERSION,
  type ContextFilter,
  type ModuleSummary,
  type SummaryContext,
  type SummaryItem,
} from '../shared/summary.js';
import { listItems } from './items.js';
import type { Item } from '../shared/types.js';

/**
 * What {{N}} tells a shell about itself (`shared/summary.ts`,
 * `docs/SHELL-CONTRACT.md`). The figures come from the same functions the
 * module's own screens read, so a widget cannot disagree with the module.
 */

export const MODULE_ID = '{{ID}}';

/**
 * The context this module can narrow by. Claim only what is really filtered:
 * a board narrowed to one customer must not show this module's figures for
 * everyone and label them as narrowed.
 */
const SUPPORTED: ContextFilter[] = ['from', 'to'];

const LIST_LIMIT = 8;

function item(row: Item): SummaryItem {
  return {
    id: String(row.id),
    title: row.title,
    subtitle: row.notes,
    badge: row.status.toUpperCase(),
    tone: row.status === 'done' ? 'good' : 'neutral',
    at: row.updated_at,
    href: `/items/${row.id}`,
  };
}

export interface SummaryOptions {
  /** Injectable wall clock for `generated_at`, so tests stay deterministic. */
  now?: () => Date;
}

export function moduleSummary(
  db: Database.Database,
  context: SummaryContext = {},
  options: SummaryOptions = {},
): ModuleSummary {
  const now = options.now ?? (() => new Date());
  const applied = appliedFilters(context, SUPPORTED);

  let items = listItems(db);
  if (context.from !== undefined) items = items.filter((row) => row.created_at.slice(0, 10) >= context.from!);
  if (context.to !== undefined) items = items.filter((row) => row.created_at.slice(0, 10) <= context.to!);
  const open = items.filter((row) => row.status === 'open');

  return {
    summary_version: SUMMARY_VERSION,
    module: MODULE_ID,
    generated_at: now().toISOString(),
    tiles: [
      { key: 'open_items', label: 'Open', value: String(open.length), unit: 'items', tone: open.length > 0 ? 'warn' : 'good', href: '/items' },
      { key: 'items', label: 'Items', value: String(items.length), unit: 'not archived', tone: 'neutral', href: '/items' },
    ],
    lists: [{ key: 'open_items_list', label: 'Open items', items: open.slice(0, LIST_LIMIT).map(item), href: '/items' }],
    context: { supported: SUPPORTED, applied },
  };
}
