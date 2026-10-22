import type { FieldError, Item, ItemEvent, ItemStatus, Me } from '../shared/types';

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

function send(method: string, values?: Record<string, unknown>): RequestInit {
  return { method, body: values ? JSON.stringify(values) : undefined };
}

/**
 * What the server says about signing in: with single sign-on the credentials
 * belong to PS-01 Identity, without it to this module's own admin account.
 */
export type AuthMode = { sso: false } | { sso: true; org: string };

export const api = {
  login: (username: string, password: string) => request<{ ok: true }>('/api/login', send('POST', { username, password })),
  logout: () => request<{ ok: true }>('/api/logout', send('POST')),
  /** Which credentials this deployment accepts — readable before signing in. */
  authMode: () => request<AuthMode>('/api/auth-mode'),
  /** Who is signed in, and what they may do (`view` / `edit` / `manage`). */
  me: () => request<Me>('/api/me'),

  items: () => request<{ items: Item[] }>('/api/items'),
  item: (id: number) => request<{ item: Item; history: ItemEvent[] }>(`/api/items/${id}`),
  createItem: (values: { title: string; notes: string }) => request<Item>('/api/items', send('POST', values)),
  setStatus: (id: number, status: Exclude<ItemStatus, 'archived'>) =>
    request<Item>(`/api/items/${id}/status`, send('POST', { status })),
  archive: (id: number) => request<Item>(`/api/items/${id}/archive`, send('POST')),
  remove: (id: number) => request<{ ok: true }>(`/api/items/${id}`, send('DELETE')),
};
