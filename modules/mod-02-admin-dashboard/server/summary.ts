import type Database from 'better-sqlite3';
import {
  appliedFilters,
  SUMMARY_VERSION,
  type ContextFilter,
  type ModuleSummary,
  type SummaryContext,
  type SummaryTile,
} from '../shared/summary.js';
import { resources } from '../shared/resources.js';

/**
 * What MOD-02 tells a shell about itself.
 *
 * This module is config-driven — its tables ARE `shared/resources.ts` — so its
 * summary is too: one tile per configured resource, carrying that resource's
 * own label and row count. Point the dashboard at a different data model and
 * the board follows, with no change here and none in MOD-15.
 *
 * That is also why there are no list widgets. A generic CRUD table has no
 * "interesting rows" this module could pick without knowing what the columns
 * mean, and inventing a rule — newest first, say — would put an arbitrary slice
 * of someone's data on a board and imply it mattered.
 */

export const MODULE_ID = 'mod-02-admin-dashboard';

/**
 * The context this module can narrow by.
 *
 * Nothing. A configured resource need not have a customer column or a date
 * column at all, so there is no filter this module can honour for every one of
 * them. Declaring an empty set is the honest answer: the board shows these
 * tiles unfiltered and says so, rather than implying a narrowing that never
 * happened for some resources and did for others.
 */
const SUPPORTED: ContextFilter[] = [];

/** Row count for one resource. */
function countOf(db: Database.Database, table: string): number {
  // The table name comes from `resources`, which is source code in this
  // package, not from a request — the same trust boundary every other query in
  // this module works within.
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
  return row.n;
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

  const tiles: SummaryTile[] = resources.map((resource) => ({
    // The resource name is already `[a-z_]` only, which is exactly what the
    // contract requires of a key — so a board's saved widget survives any
    // change to a resource's LABEL, and is retired by a change to its name.
    key: resource.name,
    label: resource.label,
    value: String(countOf(db, resource.name)),
    unit: 'records',
    tone: 'neutral',
    href: `/${resource.name}`,
  }));

  return {
    summary_version: SUMMARY_VERSION,
    module: MODULE_ID,
    generated_at: now().toISOString(),
    tiles,
    lists: [],
    context: { supported: SUPPORTED, applied },
  };
}
