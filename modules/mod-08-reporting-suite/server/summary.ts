import type Database from 'better-sqlite3';
import {
  appliedFilters,
  SUMMARY_VERSION,
  type ContextFilter,
  type ModuleSummary,
  type SummaryContext,
  type SummaryItem,
} from '../shared/summary.js';
import type { Report, Run, Schedule } from '../shared/types.js';

/**
 * What MOD-08 tells a shell about itself.
 *
 * This module runs saved SQL against a source database, so its summary is
 * about the REPORTING MACHINERY — how many reports exist, what is scheduled,
 * and what failed — rather than about the figures those reports produce. The
 * numbers inside a report belong to the module that owns the data, and it puts
 * its own tiles on the board.
 *
 * That line matters: a board carrying both would show the same figure twice,
 * computed two different ways, and there would be no way to tell which one to
 * believe when they disagreed.
 */

export const MODULE_ID = 'mod-08-reporting-suite';

/**
 * The context this module can narrow by.
 *
 * Nothing. A saved report is arbitrary SQL over someone else's schema — this
 * module cannot know whether a given report has a customer column or a date
 * column, let alone rewrite the query to filter on one. Declaring an empty set
 * is the honest answer.
 */
const SUPPORTED: ContextFilter[] = [];

const LIST_LIMIT = 8;

function runItem(run: Run & { report_name: string }): SummaryItem {
  return {
    id: String(run.id),
    title: run.report_name,
    subtitle: run.status === 'error' ? (run.error ?? 'failed') : `${run.row_count ?? 0} rows`,
    badge: run.trigger.toUpperCase(),
    tone: run.status === 'error' ? 'bad' : 'good',
    at: run.finished_at || run.started_at,
    href: `/reports/${run.report_id}`,
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

  const reports = db.prepare('SELECT * FROM reports ORDER BY id').all() as Report[];
  const schedules = db.prepare('SELECT * FROM schedules ORDER BY id').all() as Schedule[];
  const runs = db
    .prepare(
      `SELECT r.*, rep.name AS report_name FROM runs r
       JOIN reports rep ON rep.id = r.report_id
       ORDER BY r.started_at DESC, r.id DESC
       LIMIT 50`,
    )
    .all() as (Run & { report_name: string })[];

  const enabled = schedules.filter((s) => s.enabled === 1);
  const failed = runs.filter((r) => r.status === 'error');

  return {
    summary_version: SUMMARY_VERSION,
    module: MODULE_ID,
    generated_at: now().toISOString(),
    tiles: [
      {
        key: 'reports',
        label: 'Saved reports',
        value: String(reports.length),
        unit: null,
        tone: 'neutral',
        href: '/reports',
      },
      {
        key: 'schedules',
        label: 'Scheduled',
        value: String(enabled.length),
        unit: 'enabled',
        tone: 'neutral',
        href: '/schedules',
      },
      {
        key: 'failed_runs',
        label: 'Recent failures',
        // Scoped to the recent window above, not to all time: a report that
        // failed once last year is not something a board should keep flagging.
        value: String(failed.length),
        unit: 'of last 50',
        tone: failed.length > 0 ? 'bad' : 'good',
        href: '/runs',
      },
    ],
    lists: [
      {
        key: 'recent_runs',
        label: 'Recent runs',
        items: runs.slice(0, LIST_LIMIT).map(runItem),
        href: '/runs',
      },
    ],
    context: { supported: SUPPORTED, applied },
  };
}
