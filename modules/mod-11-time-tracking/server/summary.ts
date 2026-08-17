import type Database from 'better-sqlite3';
import {
  appliedFilters,
  SUMMARY_VERSION,
  type ContextFilter,
  type ModuleSummary,
  type SummaryContext,
  type SummaryItem,
} from '../shared/summary.js';
import { listEmployees, listProjects, listTimesheets, rangeSummary, todayIso } from './tracking.js';
import type { TimesheetRow } from '../shared/types.js';

/**
 * What MOD-11 tells a shell about itself.
 *
 * Everything MOD-11-specific stays here: the consumer gets figures, short lists
 * and paths, and nothing about entries, weeks or how billable value is derived.
 * The numbers come from `rangeSummary` and `listTimesheets` — the same
 * functions the module's own screens read — so a widget cannot disagree with
 * the module.
 */

export const MODULE_ID = 'mod-11-time-tracking';

/**
 * The context this module can narrow by.
 *
 * `party` is deliberately absent: a project carries a free-text `client`, not a
 * PS-11 party, so there is no id to filter on. Claiming it and quietly ignoring
 * it is exactly what `context.applied` exists to prevent.
 */
const SUPPORTED: ContextFilter[] = ['from', 'to'];

const LIST_LIMIT = 8;

/** Hours, as this module's own screens render them. */
function hours(minutes: number): string {
  return (Math.round((minutes / 60) * 10) / 10).toFixed(1);
}

/**
 * The window a summary covers when the shell asks for no dates.
 *
 * Time is unbounded — every entry ever recorded is "all time" — and a tile
 * reading 12,480 h is a number nobody acts on. Thirty days back is the span the
 * module's own range view opens on, so an unfiltered widget agrees with what
 * someone sees when they click through it.
 */
function defaultWindow(today: string): { from: string; to: string } {
  const to = new Date(`${today}T00:00:00Z`);
  const from = new Date(to.getTime() - 29 * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: today };
}

function timesheetItem(row: TimesheetRow, employeeName: string): SummaryItem {
  return {
    id: `${row.employee_id}:${row.week_start}`,
    title: `${employeeName} · week of ${row.week_start}`,
    subtitle: `${hours(row.total_minutes)} h · ${hours(row.billable_minutes)} h billable`,
    badge: row.status.toUpperCase(),
    tone: row.status === 'approved' ? 'good' : row.status === 'submitted' ? 'warn' : 'neutral',
    at: row.week_start,
    href: `/timesheets?employee=${row.employee_id}&week=${row.week_start}`,
  };
}

export interface SummaryOptions {
  /** Injectable date "YYYY-MM-DD", so the default window is deterministic. */
  today?: string;
  /** Injectable wall clock for `generated_at`. */
  now?: () => Date;
}

export function moduleSummary(
  db: Database.Database,
  context: SummaryContext = {},
  options: SummaryOptions = {},
): ModuleSummary {
  const today = options.today ?? todayIso();
  const now = options.now ?? (() => new Date());

  // What this response was narrowed by. A filter counts as applied when it
  // RAN, not when it matched.
  const applied = appliedFilters(context, SUPPORTED);

  const window = defaultWindow(today);
  const from = context.from ?? window.from;
  const to = context.to ?? window.to;
  const range = rangeSummary(db, from, to);

  const employees = listEmployees(db);
  const projects = listProjects(db, false);

  // Timesheets are per employee in this module, so the pending queue is the
  // union across everyone rather than a single query.
  const pending: { row: TimesheetRow; name: string }[] = [];
  for (const employee of employees) {
    for (const sheet of listTimesheets(db, employee.id)) {
      if (sheet.status === 'submitted') pending.push({ row: sheet, name: employee.name });
    }
  }
  pending.sort((a, b) => a.row.week_start.localeCompare(b.row.week_start));

  const billablePct =
    range.total_minutes === 0 ? null : Math.round((range.billable_minutes / range.total_minutes) * 100);

  return {
    summary_version: SUMMARY_VERSION,
    module: MODULE_ID,
    generated_at: now().toISOString(),
    tiles: [
      {
        key: 'hours',
        label: 'Hours logged',
        value: hours(range.total_minutes),
        unit: `h · ${from} → ${to}`,
        tone: 'neutral',
        href: '/reports',
      },
      {
        key: 'billable_hours',
        label: 'Billable',
        value: hours(range.billable_minutes),
        unit: 'h',
        tone: 'good',
        href: '/reports',
      },
      {
        key: 'billable_share',
        // A percentage of nothing is a figure a board would repeat all day.
        label: 'Billable share',
        value: billablePct === null ? '—' : `${billablePct} %`,
        unit: null,
        tone: 'neutral',
        href: '/reports',
      },
      {
        key: 'pending_timesheets',
        label: 'Timesheets to approve',
        value: String(pending.length),
        unit: 'submitted',
        tone: pending.length > 0 ? 'warn' : 'good',
        href: '/timesheets',
      },
      {
        key: 'active_projects',
        label: 'Active projects',
        value: String(projects.length),
        unit: null,
        tone: 'neutral',
        href: '/projects',
      },
    ],
    lists: [
      {
        key: 'awaiting_approval',
        label: 'Awaiting approval',
        items: pending.slice(0, LIST_LIMIT).map(({ row, name }) => timesheetItem(row, name)),
        href: '/timesheets',
      },
    ],
    context: { supported: SUPPORTED, applied },
  };
}
