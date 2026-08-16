import type {
  CaseDetail,
  CaseOutcome,
  CaseRow,
  CaseStatus,
  FieldError,
  IntakeResult,
  MessageVisibility,
  ReporterView,
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

export interface CategoryDef {
  key: string;
  label: string;
  hint: string;
}

export interface PublicConfig {
  organisation: string;
  categories: CategoryDef[];
  acknowledge_days: number;
  feedback_months: number;
}

export interface AppConfig {
  username: string;
  organisation: string;
  categories: CategoryDef[];
  outcomes: { key: CaseOutcome; label: string }[];
  statuses: CaseStatus[];
  now: string;
}

export interface Overview {
  total: number;
  open: number;
  awaiting_acknowledgement: number;
  acknowledgement_missed: number;
  feedback_at_risk: number;
  feedback_missed: number;
  due_for_erasure: number;
}

export const api = {
  // ── Public: no session, and the code never rides in a URL ──────────
  publicConfig: () => request<PublicConfig>('/api/public/config'),
  fileReport: (values: Record<string, unknown>) => request<IntakeResult>('/api/public/reports', post(values)),
  myCase: (code: string) => request<ReporterView>('/api/public/case', post({ code })),
  myMessage: (code: string, body: string) =>
    request<ReporterView>('/api/public/case/messages', post({ code, body })),

  // ── Case handler ───────────────────────────────────────────────────
  login: (username: string, password: string) =>
    request<{ ok: true; username: string }>('/api/login', post({ username, password })),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  config: () => request<AppConfig>('/api/config'),
  overview: () => request<Overview>('/api/overview'),
  cases: (params: URLSearchParams) => request<{ cases: CaseRow[] }>(`/api/cases?${params}`),
  case: (id: number) => request<CaseDetail>(`/api/cases/${id}`),
  acknowledge: (id: number) => request<CaseDetail>(`/api/cases/${id}/acknowledge`, post()),
  investigate: (id: number) => request<CaseDetail>(`/api/cases/${id}/investigate`, post()),
  close: (id: number, outcome: CaseOutcome) => request<CaseDetail>(`/api/cases/${id}/close`, post({ outcome })),
  message: (id: number, visibility: MessageVisibility, body: string) =>
    request<CaseDetail>(`/api/cases/${id}/messages`, post({ visibility, body })),
  erase: (id: number, force: boolean) => request<CaseDetail>(`/api/cases/${id}/erase`, post({ force })),
};
