import type {
  AbsenceRequest,
  AbsenceTypeDef,
  Balance,
  Employee,
  Entitlement,
  FieldError,
  RequestDetail,
  RequestStatus,
} from '../shared/types';
import type { Holiday, Region } from '../shared/calendar';

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

function post(values?: Record<string, unknown>): RequestInit {
  return { method: 'POST', body: JSON.stringify(values ?? {}) };
}

export interface AppConfig {
  username: string;
  types: AbsenceTypeDef[];
  regions: { code: Region; label: string }[];
  default_region: Region;
  /** The server's today, so the client never disagrees with the balance maths. */
  today: string;
}

export interface RequestFilter {
  employee_id?: number;
  status?: RequestStatus;
  from?: string;
  to?: string;
}

function query(filter: RequestFilter): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return params.toString();
}

export const api = {
  login: (username: string, password: string) =>
    request<{ ok: true; username: string }>('/api/login', post({ username, password })),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  config: () => request<AppConfig>('/api/config'),

  employees: (includeLeft = false) =>
    request<{ employees: Employee[] }>(`/api/employees${includeLeft ? '?include_left=true' : ''}`),
  createEmployee: (values: Record<string, unknown>) => request<Employee>('/api/employees', post(values)),
  offboard: (id: number, leftOn: string) =>
    request<Employee>(`/api/employees/${id}/offboard`, post({ left_on: leftOn })),

  entitlement: (employeeId: number, year: number) =>
    request<{ entitlement: Entitlement | null }>(`/api/employees/${employeeId}/entitlement?year=${year}`),
  setEntitlement: (employeeId: number, values: Record<string, unknown>) =>
    request<Entitlement>(`/api/employees/${employeeId}/entitlement`, {
      method: 'PUT',
      body: JSON.stringify(values),
    }),

  requests: (filter: RequestFilter = {}) => request<{ requests: AbsenceRequest[] }>(`/api/requests?${query(filter)}`),
  request: (id: number) => request<RequestDetail>(`/api/requests/${id}`),
  createRequest: (values: Record<string, unknown>) => request<AbsenceRequest>('/api/requests', post(values)),
  decide: (id: number, action: 'approve' | 'reject' | 'withdraw', note?: string) =>
    request<AbsenceRequest>(`/api/requests/${id}/${action}`, post({ note })),

  balances: (year: number) => request<{ year: number; balances: Balance[] }>(`/api/balances?year=${year}`),
  balance: (employeeId: number, year: number) =>
    request<Balance>(`/api/employees/${employeeId}/balance?year=${year}`),

  holidays: (region: Region, year: number) =>
    request<{ region: Region; year: number; holidays: Holiday[] }>(
      `/api/holidays?region=${encodeURIComponent(region)}&year=${year}`,
    ),
};
