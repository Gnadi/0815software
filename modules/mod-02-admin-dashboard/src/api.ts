import type { ResourceDef } from '../shared/resources';

export type Row = { id: number } & Record<string, string | number | null>;

export interface ListResponse {
  rows: Row[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ConfigResponse {
  resources: ResourceDef[];
  username: string;
}

export interface FieldError {
  field: string;
  message: string;
}

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

export const api = {
  login: (username: string, password: string) =>
    request<{ ok: true }>('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  config: () => request<ConfigResponse>('/api/config'),
  list: (resource: string, params: URLSearchParams) =>
    request<ListResponse>(`/api/${resource}?${params}`),
  create: (resource: string, values: Record<string, unknown>) =>
    request<Row>(`/api/${resource}`, { method: 'POST', body: JSON.stringify(values) }),
  update: (resource: string, id: number, values: Record<string, unknown>) =>
    request<Row>(`/api/${resource}/${id}`, { method: 'PUT', body: JSON.stringify(values) }),
  remove: (resource: string, id: number) =>
    request<{ ok: true }>(`/api/${resource}/${id}`, { method: 'DELETE' }),
  bulkDelete: (resource: string, ids: number[]) =>
    request<{ ok: true; deleted: number }>(`/api/${resource}/bulk-delete`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
};

/** Trigger a browser download of a CSV export. */
export function exportUrl(resource: string, params?: URLSearchParams): string {
  const query = params && params.size > 0 ? `?${params}` : '';
  return `/api/${resource}/export.csv${query}`;
}
