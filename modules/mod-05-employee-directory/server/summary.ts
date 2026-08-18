import type Database from 'better-sqlite3';
import {
  appliedFilters,
  SUMMARY_VERSION,
  type ContextFilter,
  type ModuleSummary,
  type SummaryContext,
  type SummaryItem,
} from '../shared/summary.js';
import { listDepartments, listEmployees } from './directory.js';
import type { DepartmentRow, EmployeeRow } from '../shared/types.js';

/**
 * What MOD-05 tells a shell about itself.
 *
 * Everything MOD-05-specific stays here: the consumer gets figures, short lists
 * and paths, and nothing about the org chart, manager chains or how a
 * department tree is stored.
 */

export const MODULE_ID = 'mod-05-employee-directory';

/**
 * The context this module can narrow by.
 *
 * Neither filter applies. There is no customer in a staff directory, and its
 * records are PEOPLE rather than dated events — narrowing an org chart to July
 * would answer a question nobody asked. Declaring an empty set is the honest
 * answer: the board then shows this module's widgets unfiltered and says so,
 * instead of implying a narrowing that never happened.
 */
const SUPPORTED: ContextFilter[] = [];

const LIST_LIMIT = 8;

function employeeItem(employee: EmployeeRow): SummaryItem {
  return {
    id: String(employee.id),
    title: employee.name,
    subtitle: `${employee.job_title} · ${employee.department_name}`,
    badge: employee.status.toUpperCase(),
    tone: employee.status === 'active' ? 'neutral' : 'warn',
    at: employee.start_date,
    href: `/employees/${employee.id}`,
  };
}

function departmentItem(department: DepartmentRow): SummaryItem {
  return {
    id: String(department.id),
    title: department.name,
    subtitle: `${department.employee_count} people`,
    badge: department.code,
    tone: 'neutral',
    at: null,
    href: `/departments/${department.id}`,
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

  const employees = listEmployees(db, {});
  const departments = listDepartments(db);
  const active = employees.filter((e) => e.status === 'active');
  const unmanaged = active.filter((e) => e.manager_id === null);

  // Newest first: a directory's useful board widget is who has just joined,
  // not an alphabetical slice of everyone.
  const recent = [...active].sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''));

  return {
    summary_version: SUMMARY_VERSION,
    module: MODULE_ID,
    generated_at: now().toISOString(),
    tiles: [
      {
        key: 'headcount',
        label: 'Headcount',
        value: String(active.length),
        unit: 'active',
        tone: 'neutral',
        href: '/employees',
      },
      {
        key: 'departments',
        label: 'Departments',
        value: String(departments.length),
        unit: null,
        tone: 'neutral',
        href: '/departments',
      },
      {
        key: 'no_manager',
        label: 'Without a manager',
        value: String(unmanaged.length),
        unit: 'people',
        tone: unmanaged.length > 1 ? 'warn' : 'neutral',
        href: '/employees',
      },
    ],
    lists: [
      {
        key: 'recent_starters',
        label: 'Recently started',
        items: recent.slice(0, LIST_LIMIT).map(employeeItem),
        href: '/employees',
      },
      {
        // Not `departments`: that key is already a tile, and keys are unique
        // across a module's whole summary so a saved board can never point at
        // two different widgets.
        key: 'department_sizes',
        label: 'Departments by size',
        items: [...departments]
          .sort((a, b) => b.employee_count - a.employee_count)
          .slice(0, LIST_LIMIT)
          .map(departmentItem),
        href: '/departments',
      },
    ],
    context: { supported: SUPPORTED, applied },
  };
}
