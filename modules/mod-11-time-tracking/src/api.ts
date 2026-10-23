import type { AccessLevel } from './access';
import type {
  BoardTask,
  CalendarDay,
  CalendarRow,
  DaySheet,
  Employee,
  ExportProfileInfo,
  FieldError,
  FlexAccount,
  FlexDay,
  FlexEntry,
  LeaveBalance,
  LeaveEntitlement,
  LeaveRequest,
  LeaveSettings,
  Milestone,
  Project,
  ProjectProgress,
  TaskEvent,
  TaskStatus,
  TimeEntry,
  TimesheetDetail,
  TimesheetRow,
  WorkSchedule,
} from '../shared/types';

export class ApiError extends Error {
  status: number;
  details: FieldError[];

  constructor(status: number, message: string, details: FieldError[] = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let details: FieldError[] = [];
    try {
      const body = (await res.json()) as { error?: string; details?: FieldError[] };
      if (body.error) message = body.error;
      if (body.details) details = body.details;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, details);
  }
  return (await res.json()) as T;
}

function post(values?: Record<string, unknown>): RequestInit & { method: string } {
  return { method: 'POST', body: JSON.stringify(values ?? {}) };
}
function put(values: Record<string, unknown>): RequestInit & { method: string } {
  return { method: 'PUT', body: JSON.stringify(values) };
}

export interface SummaryResponse {
  from: string;
  to: string;
  by_project: import('../shared/types').ProjectRollup[];
  by_employee: import('../shared/types').EmployeeRollup[];
  total_minutes: number;
  billable_minutes: number;
  billable_cents: number;
}

/**
 * What the server says about signing in: with single sign-on the credentials
 * belong to PS-01 Identity, without it to this module's own admin account.
 */
export type AuthMode = { sso: false } | { sso: true; org: string };

export const api = {
  login: (username: string, password: string) =>
    request<{ ok: true }>('/api/login', post({ username, password })),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  /** Which credentials this deployment accepts — readable before signing in. */
  authMode: () => request<AuthMode>('/api/auth-mode'),
  me: () => request<{ username: string; access: AccessLevel; employee_id: number | null }>('/api/me'),

  projects: (activeOnly = false) =>
    request<{ projects: Project[] }>(`/api/projects${activeOnly ? '?active=1' : ''}`),
  createProject: (v: Record<string, unknown>) => request<Project>('/api/projects', post(v)),
  updateProject: (id: number, v: Record<string, unknown>) => request<Project>(`/api/projects/${id}`, put(v)),
  deleteProject: (id: number) => request<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' }),
  createTask: (projectId: number, name: string) =>
    request<Project>(`/api/projects/${projectId}/tasks`, post({ name })),
  updateTask: (id: number, v: Record<string, unknown>) => request<{ ok: true }>(`/api/tasks/${id}`, put(v)),
  deleteTask: (id: number) => request<{ ok: true }>(`/api/tasks/${id}`, { method: 'DELETE' }),

  employees: () => request<{ employees: Employee[] }>('/api/employees'),
  createEmployee: (v: Record<string, unknown>) => request<Employee>('/api/employees', post(v)),
  updateEmployee: (id: number, v: Record<string, unknown>) => request<Employee>(`/api/employees/${id}`, put(v)),
  deleteEmployee: (id: number) => request<{ ok: true }>(`/api/employees/${id}`, { method: 'DELETE' }),

  day: (employeeId: number, date: string) =>
    request<DaySheet>(`/api/day?employee_id=${employeeId}&date=${date}`),
  createEntry: (v: Record<string, unknown>) => request<TimeEntry>('/api/entries', post(v)),
  updateEntry: (id: number, v: Record<string, unknown>) => request<TimeEntry>(`/api/entries/${id}`, put(v)),
  deleteEntry: (id: number) => request<{ ok: true }>(`/api/entries/${id}`, { method: 'DELETE' }),

  timesheets: (employeeId: number) =>
    request<{ timesheets: TimesheetRow[] }>(`/api/timesheets?employee_id=${employeeId}`),
  timesheet: (employeeId: number, weekStart: string) =>
    request<TimesheetDetail>(`/api/timesheets/${employeeId}/${weekStart}`),
  submitWeek: (employeeId: number, weekStart: string) =>
    request<TimesheetDetail>('/api/timesheets/submit', post({ employee_id: employeeId, week_start: weekStart })),
  approveWeek: (employeeId: number, weekStart: string, note: string | null) =>
    request<TimesheetDetail>('/api/timesheets/approve', post({ employee_id: employeeId, week_start: weekStart, note })),
  rejectWeek: (employeeId: number, weekStart: string, note: string | null) =>
    request<TimesheetDetail>('/api/timesheets/reject', post({ employee_id: employeeId, week_start: weekStart, note })),

  summary: (from: string, to: string) =>
    request<SummaryResponse>(`/api/summary?from=${from}&to=${to}`),
  exportProfiles: () => request<{ profiles: ExportProfileInfo[] }>('/api/export/profiles'),

  leaveRequests: (query: { year?: number; employee_id?: number; to_decide?: boolean }) => {
    const params = new URLSearchParams();
    if (query.year) params.set('year', String(query.year));
    if (query.employee_id) params.set('employee_id', String(query.employee_id));
    if (query.to_decide) params.set('to_decide', '1');
    return request<{ requests: LeaveRequest[] }>(`/api/leave/requests?${params.toString()}`);
  },
  requestLeave: (v: Record<string, unknown>) => request<LeaveRequest>('/api/leave/requests', post(v)),
  approveLeave: (id: number, note: string | null) => request<LeaveRequest>(`/api/leave/requests/${id}/approve`, post({ note })),
  rejectLeave: (id: number, note: string) => request<LeaveRequest>(`/api/leave/requests/${id}/reject`, post({ note })),
  withdrawLeave: (id: number) => request<LeaveRequest>(`/api/leave/requests/${id}/withdraw`, post()),
  leaveBalance: (employeeId: number, year: number) =>
    request<LeaveBalance>(`/api/leave/balance?employee_id=${employeeId}&year=${year}`),
  entitlements: (employeeId: number, year: number) =>
    request<{ entitlements: LeaveEntitlement[] }>(`/api/employees/${employeeId}/entitlements?year=${year}`),
  addEntitlement: (employeeId: number, v: Record<string, unknown>) =>
    request<LeaveEntitlement>(`/api/employees/${employeeId}/entitlements`, post(v)),
  leaveCalendar: (month: string) =>
    request<{ month: string; days: CalendarDay[]; rows: CalendarRow[] }>(`/api/leave/calendar?month=${month}`),
  holidays: (year: number) => request<{ year: number; holidays: { date: string; name: string }[] }>(`/api/leave/holidays?year=${year}`),
  leaveSettings: () =>
    request<{ settings: LeaveSettings; updated_at: string | null; updated_by: string | null }>('/api/leave/settings'),
  saveLeaveSettings: (v: LeaveSettings) =>
    request<{ settings: LeaveSettings; updated_at: string | null; updated_by: string | null }>('/api/leave/settings', put({ ...v })),

  schedules: (employeeId: number) => request<{ schedules: WorkSchedule[] }>(`/api/employees/${employeeId}/schedules`),
  addSchedule: (employeeId: number, v: Record<string, unknown>) =>
    request<WorkSchedule>(`/api/employees/${employeeId}/schedules`, post(v)),
  flexAccount: (employeeId: number) => request<FlexAccount>(`/api/flex/account?employee_id=${employeeId}`),
  flexDays: (employeeId: number, month: string) =>
    request<{ month: string; days: FlexDay[] }>(`/api/flex/days?employee_id=${employeeId}&month=${month}`),
  flexOverview: () =>
    request<{
      as_of: string;
      rows: { employee_id: number; employee_name: string; balance: number; over_cap: number; under_floor: number; days_over_max: number }[];
    }>('/api/flex/overview'),
  flexEntries: (employeeId: number) => request<{ entries: FlexEntry[] }>(`/api/employees/${employeeId}/flex-entries`),
  addFlexEntry: (employeeId: number, v: Record<string, unknown>) =>
    request<FlexEntry>(`/api/employees/${employeeId}/flex-entries`, post(v)),
};

export const planning = {
  portfolio: (archived = false) => request<{ projects: ProjectProgress[] }>(`/api/portfolio${archived ? '?archived=1' : ''}`),
  board: (projectId: number) =>
    request<{ progress: ProjectProgress; milestones: Milestone[]; tasks: BoardTask[] }>(`/api/projects/${projectId}/board`),
  myTasks: (done = false) => request<{ tasks: BoardTask[] }>(`/api/my-tasks${done ? '?done=1' : ''}`),
  task: (id: number) => request<{ task: BoardTask; events: TaskEvent[] }>(`/api/tasks/${id}`),
  plan: (id: number, v: Record<string, unknown>) => request<BoardTask>(`/api/tasks/${id}/plan`, put(v)),
  move: (id: number, status: TaskStatus, note?: string) => request<BoardTask>(`/api/tasks/${id}/status`, post({ status, note })),
  addMilestone: (projectId: number, v: Record<string, unknown>) => request<Milestone>(`/api/projects/${projectId}/milestones`, post(v)),
  deleteMilestone: (id: number) => request<{ ok: true }>(`/api/milestones/${id}`, { method: 'DELETE' }),
};

/** URL of the month's flexitime CSV for payroll. */
export function flexCsvUrl(month: string): string {
  return `/api/export/flex.csv?month=${month}`;
}

/** URL of the CSV export for a profile over a date range. */
export function exportCsvUrl(profile: string, from: string, to: string): string {
  return `/api/export/timesheets.csv?profile=${encodeURIComponent(profile)}&from=${from}&to=${to}`;
}
