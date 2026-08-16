import type {
  Agent,
  AppConfig,
  Dashboard,
  FieldError,
  Priority,
  PublicTicket,
  Status,
  TicketDetail,
  TicketRow,
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

export interface WebIntakeResult {
  ref: string;
  token: string;
  status: Status;
}

/**
 * What the server says about signing in: with single sign-on the credentials
 * belong to PS-01 Identity, without it to this module's own admin account.
 */
export type AuthMode = { sso: false } | { sso: true; org: string };

export const api = {
  // ── Public (no login) ──────────────────────────────────────────────
  submitWeb: (values: Record<string, unknown>) =>
    request<WebIntakeResult>('/api/intake/web', post(values)),
  publicTicket: (ref: string, token: string) =>
    request<PublicTicket>(`/api/public/tickets/${encodeURIComponent(ref)}?token=${encodeURIComponent(token)}`),
  publicComment: (ref: string, token: string, body: string) =>
    request<PublicTicket>(
      `/api/public/tickets/${encodeURIComponent(ref)}/comment?token=${encodeURIComponent(token)}`,
      post({ body }),
    ),

  // ── Agent session ──────────────────────────────────────────────────
  login: (username: string, password: string) =>
    request<{ ok: true; agent: string }>('/api/login', post({ username, password })),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  /** Which credentials this deployment accepts — readable before signing in. */
  authMode: () => request<AuthMode>('/api/auth-mode'),
  config: () => request<AppConfig>('/api/config'),
  agents: () => request<{ agents: Agent[] }>('/api/agents'),
  dashboard: () => request<Dashboard>('/api/dashboard'),

  // ── Tickets (agent) ────────────────────────────────────────────────
  tickets: (params: URLSearchParams) => request<{ tickets: TicketRow[] }>(`/api/tickets?${params}`),
  ticket: (ref: string) => request<TicketDetail>(`/api/tickets/${encodeURIComponent(ref)}`),
  setStatus: (ref: string, to: Status) =>
    request<TicketDetail>(`/api/tickets/${encodeURIComponent(ref)}/status`, post({ to })),
  setPriority: (ref: string, priority: Priority) =>
    request<TicketDetail>(`/api/tickets/${encodeURIComponent(ref)}/priority`, post({ priority })),
  assign: (ref: string, assigneeId: number | null) =>
    request<TicketDetail>(`/api/tickets/${encodeURIComponent(ref)}/assign`, post({ assignee_id: assigneeId })),
  comment: (ref: string, body: string, visibility: 'public' | 'internal') =>
    request<TicketDetail>(`/api/tickets/${encodeURIComponent(ref)}/comment`, post({ body, visibility })),
};
