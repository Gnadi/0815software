import type {
  Chart,
  ChartRow,
  FieldError,
  PivotResult,
  QueryResult,
  Report,
  Run,
  RunRow,
  ScheduleRow,
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
      const b = (await res.json()) as { error?: string; details?: FieldError[] };
      if (b.error) message = b.error;
      if (b.details) details = b.details;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, details);
  }
  return (await res.json()) as T;
}

async function requestText(path: string, init?: RequestInit): Promise<string> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const b = (await res.json()) as { error?: string };
      if (b.error) message = b.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message);
  }
  return res.text();
}

function post(values?: Record<string, unknown>): RequestInit & { method: string } {
  return { method: 'POST', body: JSON.stringify(values ?? {}) };
}

function put(values: Record<string, unknown>): RequestInit & { method: string } {
  return { method: 'PUT', body: JSON.stringify(values) };
}

export interface SourceSchema {
  tables: { table: string; columns: string[] }[];
  policy: { max_rows: number; timeout_ms: number };
}

export const api = {
  login: (username: string, password: string) =>
    request<{ ok: true }>('/api/login', post({ username, password })),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  me: () => request<{ username: string }>('/api/me'),
  source: () => request<SourceSchema>('/api/source'),

  reports: (search?: string) =>
    request<{ reports: Report[] }>(
      `/api/reports${search ? `?search=${encodeURIComponent(search)}` : ''}`,
    ),
  report: (id: number) => request<Report>(`/api/reports/${id}`),
  createReport: (values: Record<string, unknown>) => request<Report>('/api/reports', post(values)),
  updateReport: (id: number, values: Record<string, unknown>) =>
    request<Report>(`/api/reports/${id}`, put(values)),
  deleteReport: (id: number) => request<{ ok: true }>(`/api/reports/${id}`, { method: 'DELETE' }),
  runReport: (id: number) => request<QueryResult>(`/api/reports/${id}/run`, post()),
  preview: (sql: string) => request<QueryResult>('/api/preview', post({ sql })),
  pivot: (id: number, config: Record<string, unknown>) =>
    request<PivotResult>(`/api/reports/${id}/pivot`, post(config)),
  chartPreview: (id: number, config: Record<string, unknown>) =>
    requestText(`/api/reports/${id}/chart-preview`, post(config)),
  runNow: (id: number) => request<Run>(`/api/reports/${id}/run-now`, post()),

  charts: () => request<{ charts: ChartRow[] }>('/api/charts'),
  createChart: (values: Record<string, unknown>) => request<Chart>('/api/charts', post(values)),
  deleteChart: (id: number) => request<{ ok: true }>(`/api/charts/${id}`, { method: 'DELETE' }),
  chartEmbed: (id: number) =>
    request<{ chart_id: number; token: string; path: string }>(`/api/charts/${id}/embed`),

  schedules: () => request<{ schedules: ScheduleRow[] }>('/api/schedules'),
  upsertSchedule: (reportId: number, values: Record<string, unknown>) =>
    request<ScheduleRow>(`/api/schedules/report/${reportId}`, put(values)),
  deleteSchedule: (id: number) => request<{ ok: true }>(`/api/schedules/${id}`, { method: 'DELETE' }),
  runSchedule: (id: number) => request<Run>(`/api/schedules/${id}/run-now`, post()),

  runs: (reportId?: number) =>
    request<{ runs: RunRow[] }>(`/api/runs${reportId ? `?report_id=${reportId}` : ''}`),
};

/** URL to download a report's result as CSV (triggers a download). */
export function exportCsvUrl(reportId: number): string {
  return `/api/reports/${reportId}/export.csv`;
}
