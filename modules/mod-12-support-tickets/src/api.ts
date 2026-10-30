import type { AccessLevel } from './access';
import type {
  Agent,
  AppConfig,
  AttachmentUpload,
  CannedResponse,
  Dashboard,
  FieldError,
  HelpdeskSettings,
  MailIngest,
  MailboxStatus,
  Priority,
  PublicTicket,
  SlaPolicy,
  SlaPolicyVersion,
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

export type { AttachmentUpload };

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

export interface SettingsView {
  settings: HelpdeskSettings;
  updated_by: string | null;
  updated_at: string | null;
  notification_configured: boolean;
  mailbox_configured: boolean;
  files_configured: boolean;
  public_base_url: string;
}

export interface PolicyView {
  current: SlaPolicyVersion;
  versions: SlaPolicyVersion[];
}

export const api = {
  // ── Public (no login) ──────────────────────────────────────────────
  publicConfig: () => request<{ attachments: { max_bytes: number; per_message: number } }>('/api/public/config'),
  submitWeb: (values: Record<string, unknown>) =>
    request<WebIntakeResult>('/api/intake/web', post(values)),
  publicTicket: (ref: string, token: string) =>
    request<PublicTicket>(`/api/public/tickets/${encodeURIComponent(ref)}?token=${encodeURIComponent(token)}`),
  publicComment: (ref: string, token: string, body: string, attachments: AttachmentUpload[] = []) =>
    request<PublicTicket>(
      `/api/public/tickets/${encodeURIComponent(ref)}/comment?token=${encodeURIComponent(token)}`,
      post({ body, attachments }),
    ),
  publicRate: (ref: string, token: string, score: number, comment: string) =>
    request<PublicTicket>(`/api/public/tickets/${encodeURIComponent(ref)}/rating?token=${encodeURIComponent(token)}`, post({ score, comment })),
  publicAttachmentUrl: (ref: string, token: string, id: number) =>
    `/api/public/tickets/${encodeURIComponent(ref)}/attachments/${id}?token=${encodeURIComponent(token)}`,

  // ── Agent session ──────────────────────────────────────────────────
  login: (username: string, password: string) =>
    request<{ ok: true; agent: string }>('/api/login', post({ username, password })),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  /** Which credentials this deployment accepts — readable before signing in. */
  authMode: () => request<AuthMode>('/api/auth-mode'),
  /** Who is signed in, and what they may do here (`view` / `edit` / `manage`). */
  me: () => request<{ access: AccessLevel }>('/api/me'),
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
  comment: (ref: string, body: string, visibility: 'public' | 'internal', attachments: AttachmentUpload[] = [], cannedId?: number) =>
    request<TicketDetail>(`/api/tickets/${encodeURIComponent(ref)}/comment`, post({ body, visibility, attachments, canned_id: cannedId })),
  attachmentUrl: (ref: string, id: number) => `/api/tickets/${encodeURIComponent(ref)}/attachments/${id}`,

  // ── Canned responses ───────────────────────────────────────────────
  canned: () => request<{ canned_responses: CannedResponse[] }>('/api/canned-responses'),
  createCanned: (values: { title: string; body: string }) => request<CannedResponse>('/api/canned-responses', post(values)),
  updateCanned: (id: number, values: Partial<{ title: string; body: string; active: boolean }>) =>
    request<CannedResponse>(`/api/canned-responses/${id}`, { method: 'PUT', body: JSON.stringify(values) }),
  deleteCanned: (id: number) => request<{ ok: true }>(`/api/canned-responses/${id}`, { method: 'DELETE' }),
  renderCanned: (ref: string, id: number) =>
    request<{ canned_id: number; body: string }>(`/api/tickets/${encodeURIComponent(ref)}/canned/${id}/render`, post()),

  // ── SLA policy and settings (writes: manage) ───────────────────────
  policy: () => request<PolicyView>('/api/sla-policy'),
  savePolicy: (policy: SlaPolicy) => request<PolicyView>('/api/sla-policy', { method: 'PUT', body: JSON.stringify(policy) }),
  settings: () => request<SettingsView>('/api/settings'),
  saveSettings: (values: Record<string, unknown>) => request<SettingsView>('/api/settings', { method: 'PUT', body: JSON.stringify(values) }),
  mailbox: () => request<MailboxStatus>('/api/mailbox'),
  testMailbox: () => request<{ mailbox: string; exists: number; unseen: number }>('/api/mailbox/test', post()),
  pollMailbox: () => request<{ fetched: number; taken: MailIngest[]; duplicates: number; remaining: number }>('/api/mailbox/poll', post()),
};
