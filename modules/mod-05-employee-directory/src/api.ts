import type {
  DepartmentRow,
  EmployeeDetail,
  EmployeeRow,
  FieldError,
  OnboardingFlags,
  OnboardingLists,
  OrgNode,
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

export const api = {
  login: (username: string, password: string) =>
    request<{ ok: true }>('/api/login', post({ username, password })),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  me: () => request<{ username: string }>('/api/me'),

  departments: () => request<{ departments: DepartmentRow[] }>('/api/departments'),
  createDepartment: (values: Record<string, unknown>) =>
    request<DepartmentRow>('/api/departments', post(values)),
  updateDepartment: (id: number, values: Record<string, unknown>) =>
    request<DepartmentRow>(`/api/departments/${id}`, { method: 'PUT', body: JSON.stringify(values) }),
  deleteDepartment: (id: number) =>
    request<{ ok: true }>(`/api/departments/${id}`, { method: 'DELETE' }),

  employees: (params: URLSearchParams) =>
    request<{ employees: EmployeeRow[]; today: string }>(`/api/employees?${params}`),
  locations: () => request<{ locations: string[] }>('/api/locations'),
  employeeDetail: (id: number) => request<EmployeeDetail>(`/api/employees/${id}`),
  createEmployee: (values: Record<string, unknown>) =>
    request<EmployeeDetail>('/api/employees', post(values)),
  updateEmployee: (id: number, values: Record<string, unknown>) =>
    request<EmployeeDetail>(`/api/employees/${id}`, { method: 'PUT', body: JSON.stringify(values) }),
  offboard: (id: number) => request<EmployeeDetail>(`/api/employees/${id}/offboard`, post()),
  reactivate: (id: number) => request<EmployeeDetail>(`/api/employees/${id}/reactivate`, post()),
  setOnboarding: (id: number, patch: Partial<OnboardingFlags>) =>
    request<OnboardingFlags>(`/api/employees/${id}/onboarding`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  orgChart: () => request<{ roots: OrgNode[] }>('/api/orgchart'),
  onboarding: () => request<OnboardingLists>('/api/onboarding'),
};

/** URL of the CSV export honouring the given directory filters. */
export function exportCsvUrl(params: URLSearchParams): string {
  const query = params.toString();
  return `/api/employees/export.csv${query ? `?${query}` : ''}`;
}
