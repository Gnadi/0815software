import type {
  Activity,
  AppConfig,
  Company,
  CompanyRow,
  Contact,
  ContactRow,
  DealDetail,
  DealRow,
  FieldError,
  FollowUp,
  Metrics,
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

export interface CompanyDetail extends CompanyRow {
  contacts: ContactRow[];
  deals: DealRow[];
}

export interface ContactDetail extends Contact {
  company_name: string | null;
  company: Company | null;
  deals: DealRow[];
  activities: Activity[];
}

export const api = {
  login: (username: string, password: string) =>
    request<{ ok: true }>('/api/login', post({ username, password })),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  me: () => request<{ username: string }>('/api/me'),
  config: () => request<AppConfig>('/api/config'),

  companies: (search?: string) =>
    request<{ companies: CompanyRow[] }>(
      `/api/companies${search ? `?search=${encodeURIComponent(search)}` : ''}`,
    ),
  company: (id: number) => request<CompanyDetail>(`/api/companies/${id}`),
  createCompany: (values: Record<string, unknown>) => request<Company>('/api/companies', post(values)),
  updateCompany: (id: number, values: Record<string, unknown>) =>
    request<Company>(`/api/companies/${id}`, put(values)),
  deleteCompany: (id: number) => request<{ ok: true }>(`/api/companies/${id}`, { method: 'DELETE' }),

  contacts: (params: URLSearchParams) =>
    request<{ contacts: ContactRow[] }>(`/api/contacts?${params}`),
  contact: (id: number) => request<ContactDetail>(`/api/contacts/${id}`),
  createContact: (values: Record<string, unknown>) => request<Contact>('/api/contacts', post(values)),
  updateContact: (id: number, values: Record<string, unknown>) =>
    request<Contact>(`/api/contacts/${id}`, put(values)),
  deleteContact: (id: number) => request<{ ok: true }>(`/api/contacts/${id}`, { method: 'DELETE' }),

  deals: (params: URLSearchParams) => request<{ deals: DealRow[] }>(`/api/deals?${params}`),
  deal: (id: number) => request<DealDetail>(`/api/deals/${id}`),
  createDeal: (values: Record<string, unknown>) => request<DealDetail>('/api/deals', post(values)),
  updateDeal: (id: number, values: Record<string, unknown>) => request<DealDetail>(`/api/deals/${id}`, put(values)),
  deleteDeal: (id: number) => request<{ ok: true }>(`/api/deals/${id}`, { method: 'DELETE' }),
  moveStage: (id: number, stage: string, note?: string) =>
    request<DealDetail>(`/api/deals/${id}/stage`, post({ stage, note })),
  reopenDeal: (id: number, stage: string, note?: string) =>
    request<DealDetail>(`/api/deals/${id}/reopen`, post({ stage, note })),

  activities: () => request<{ activities: Activity[] }>('/api/activities'),
  createActivity: (values: Record<string, unknown>) => request<Activity>('/api/activities', post(values)),
  followups: () => request<{ followups: FollowUp[] }>('/api/followups'),
  setDone: (id: number, done: boolean) => request<Activity>(`/api/activities/${id}/done`, post({ done })),

  metrics: (from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    return request<Metrics>(`/api/metrics${qs ? `?${qs}` : ''}`);
  },
};

/** URL of the deals CSV export (triggers a download). */
export const dealsCsvUrl = '/api/deals.csv';
