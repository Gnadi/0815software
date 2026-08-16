import type {
  DaySheet,
  Employee,
  ExportProfileInfo,
  FieldError,
  Project,
  TimeEntry,
  TimesheetDetail,
  TimesheetRow,
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
  me: () => request<{ username: string }>('/api/me'),

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
};

/** URL of the CSV export for a profile over a date range. */
export function exportCsvUrl(profile: string, from: string, to: string): string {
  return `/api/export/timesheets.csv?profile=${encodeURIComponent(profile)}&from=${from}&to=${to}`;
}
