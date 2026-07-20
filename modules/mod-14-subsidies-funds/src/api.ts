import type {
  ApplicationDetail,
  ApplicationRow,
  AppConfig,
  Dashboard,
  FieldError,
  ProgramDetail,
  ProgramRow,
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

function post(values?: Record<string, unknown>): RequestInit {
  return { method: 'POST', body: JSON.stringify(values ?? {}) };
}

function put(values: Record<string, unknown>): RequestInit {
  return { method: 'PUT', body: JSON.stringify(values) };
}

export const EXPORT_URL = '/api/export/applications.csv';

export const api = {
  login: (username: string, password: string) =>
    request<{ ok: true; admin: string }>('/api/login', post({ username, password })),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  config: () => request<AppConfig>('/api/config'),
  dashboard: () => request<Dashboard>('/api/dashboard'),

  // ── Programs ─────────────────────────────────────────────────────────
  programs: (params: URLSearchParams) => request<{ programs: ProgramRow[] }>(`/api/programs?${params}`),
  program: (id: number) => request<ProgramDetail>(`/api/programs/${id}`),
  createProgram: (values: Record<string, unknown>) => request<ProgramDetail>('/api/programs', post(values)),
  updateProgram: (id: number, values: Record<string, unknown>) => request<ProgramDetail>(`/api/programs/${id}`, put(values)),
  deleteProgram: (id: number) => request<{ ok: true }>(`/api/programs/${id}`, { method: 'DELETE' }),

  // ── Applications ─────────────────────────────────────────────────────
  applications: (params: URLSearchParams) => request<{ applications: ApplicationRow[] }>(`/api/applications?${params}`),
  application: (id: number) => request<ApplicationDetail>(`/api/applications/${id}`),
  createApplication: (values: Record<string, unknown>) => request<ApplicationDetail>('/api/applications', post(values)),
  updateApplication: (id: number, values: Record<string, unknown>) =>
    request<ApplicationDetail>(`/api/applications/${id}`, put(values)),
  transition: (id: number, values: Record<string, unknown>) =>
    request<ApplicationDetail>(`/api/applications/${id}/transition`, post(values)),
  addTranche: (id: number, values: Record<string, unknown>) =>
    request<ApplicationDetail>(`/api/applications/${id}/tranches`, post(values)),
  addObligation: (id: number, values: Record<string, unknown>) =>
    request<ApplicationDetail>(`/api/applications/${id}/obligations`, post(values)),
  toggleObligation: (obligationId: number) =>
    request<ApplicationDetail>(`/api/obligations/${obligationId}/toggle`, post()),
};
