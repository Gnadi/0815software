import type { AccessLevel } from './access';
import type {
  Chart,
  ChartRow,
  ExportFormat,
  FieldError,
  ParamValues,
  PivotConfig,
  PivotResult,
  QueryResult,
  Report,
  ReportParam,
  ReportSettings,
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
  policy: { max_rows: number; timeout_ms: number; views_only: boolean };
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
  me: () => request<{ username: string; access: AccessLevel }>('/api/me'),
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
  runReport: (id: number, params: ParamValues = {}) => request<QueryResult>(`/api/reports/${id}/run`, post({ params })),
  /** Unsaved SQL, with the parameters being declared and the values to try. */
  preview: (sql: string, params: unknown[] = [], values: ParamValues = {}) =>
    request<QueryResult>('/api/preview', post({ sql, params, values })),
  pivot: (id: number, config: PivotConfig, params: ParamValues = {}) =>
    request<PivotResult>(`/api/reports/${id}/pivot`, post({ ...config, params })),
  chartPreview: (id: number, config: Record<string, unknown>) =>
    requestText(`/api/reports/${id}/chart-preview`, post(config)),
  runNow: (id: number, format: ExportFormat, params: ParamValues = {}) =>
    request<Run>(`/api/reports/${id}/run-now`, post({ format, params })),

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

  settings: () => request<ReportSettings>('/api/settings'),
  saveSettings: (values: Record<string, unknown>) => request<ReportSettings>('/api/settings', put(values)),
};

/** `p_<name>=value` for each given value — how a download link carries them. */
function query(values: ParamValues, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra);
  for (const [name, value] of Object.entries(values)) if (value !== '') q.set(`p_${name}`, value);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** URL to download a report's result as CSV (triggers a download). */
export function exportCsvUrl(reportId: number, values: ParamValues = {}): string {
  return `/api/reports/${reportId}/export.csv${query(values)}`;
}

/** The same as an Excel workbook; with a pivot, as a second sheet. */
export function exportXlsxUrl(reportId: number, values: ParamValues = {}, pivot?: PivotConfig): string {
  const extra: Record<string, string> = pivot
    ? { pivot_row: pivot.row, pivot_measure: pivot.measure, pivot_aggregation: pivot.aggregation, ...(pivot.col ? { pivot_col: pivot.col } : {}) }
    : {};
  return `/api/reports/${reportId}/export.xlsx${query(values, extra)}`;
}

/** A report's parameters that must be given before it can run. */
export function missingRequired(params: ReportParam[], values: ParamValues): ReportParam[] {
  return params.filter((p) => p.required && !p.default && !values[p.name]);
}

/** An error as a person reads it: the message and what each field got wrong. */
export function errorText(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const details = err instanceof ApiError ? err.details.map((d) => d.message) : [];
  return [err.message, ...details].join(' — ');
}
