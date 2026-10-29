import type Database from 'better-sqlite3';
import { addDays, weekStartOf } from '../shared/time.js';
import type { MyOverview } from '../shared/types.js';
import { flexAccount } from './flextime.js';
import { balance, listRequests, type Viewer } from './leave.js';
import { tasksOf } from './planning.js';
import { localOf, readTimerSettings, runningTimer } from './timer.js';
import { getEmployee, timesheetRow } from './tracking.js';

/**
 * "My area": one person's own figures on one screen — this week and last,
 * the flexitime balance, the leave left, what is pending, the tasks, and the
 * running timer. Nothing here is computed anew: every figure comes from the
 * function the figure's own screen reads (timesheets, flexitime, leave,
 * planning), so the overview can never say something those screens do not.
 * "Today" is the local day (the timer's time zone).
 */
export function myOverview(db: Database.Database, employeeId: number, viewer: Viewer, now = Date.now()): MyOverview {
  const employee = getEmployee(db, employeeId);
  const today = localOf(now, readTimerSettings(db).timezone).date;
  const thisWeek = weekStartOf(today);
  const lastWeek = addDays(thisWeek, -7);
  const week = timesheetRow(db, employeeId, thisWeek);
  const previous = timesheetRow(db, employeeId, lastWeek);

  const flex = flexAccount(db, employeeId, today, viewer);
  const requests = listRequests(db, viewer, { employeeId }, today);
  const upcoming = requests
    .filter((r) => (r.status === 'approved' || r.status === 'requested') && r.end_date >= today)
    .sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
  const tasks = tasksOf(db, employeeId, viewer, false, today);
  const byDue = [...tasks].sort((a, b) => (a.due_date ?? '9999-12-31').localeCompare(b.due_date ?? '9999-12-31'));

  return {
    employee: { id: employee.id, name: employee.name },
    today,
    timer: runningTimer(db, employeeId, now),
    week: { week_start: thisWeek, minutes: week.total_minutes, status: week.status },
    last_week: { week_start: lastWeek, minutes: previous.total_minutes, status: previous.status },
    flex: flex.start === null ? null : { balance: flex.balance, over_cap: flex.over_cap, under_floor: flex.under_floor },
    leave: balance(db, employeeId, Number(today.slice(0, 4))),
    pending_requests: requests.filter((r) => r.status === 'requested').length,
    next_absence: upcoming ? { type: upcoming.type, start_date: upcoming.start_date, end_date: upcoming.end_date, status: upcoming.status } : null,
    tasks: { open: tasks.length, overdue: tasks.filter((t) => t.overdue).length, next: byDue.slice(0, 5) },
  };
}
