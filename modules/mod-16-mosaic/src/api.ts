import type { Board, PanePlacement, PeerStatus, Preferences } from '../shared/types';

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

function post(values?: Record<string, unknown>): RequestInit {
  return { method: 'POST', body: JSON.stringify(values ?? {}) };
}

/**
 * Which credentials this deployment accepts. With SSO configured the logins
 * belong to PS-01 Identity, without it to this module's own admin account.
 */
export type AuthMode = { sso: false } | { sso: true; org: string };

export interface Catalogue {
  /** Every module in the catalogue, with what this stack can do with it. */
  modules: PeerStatus[];
  /** Is PS-01 validating logins? False means one shared account — see App.tsx. */
  identity_configured: boolean;
}


export const api = {
  login: (username: string, password: string) =>
    request<{ ok: true; username: string }>('/api/login', post({ username, password })),
  logout: () => request<{ ok: true }>('/api/logout', post()),
  /** Which credentials this deployment accepts — readable before signing in. */
  authMode: () => request<AuthMode>('/api/auth-mode'),
  me: () => request<{ username: string }>('/api/me'),

  catalogue: () => request<Catalogue>('/api/catalogue'),

  boards: () => request<{ boards: Board[]; preferences: Preferences }>('/api/boards'),
  createBoard: (name: string) => request<Board>('/api/boards', post({ name })),
  renameBoard: (id: number, name: string) =>
    request<Board>(`/api/boards/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  deleteBoard: (id: number) => request<{ ok: true }>(`/api/boards/${id}`, { method: 'DELETE' }),
  setActiveBoard: (id: number) => request<{ ok: true }>(`/api/boards/${id}/active`, post()),

  addPane: (boardId: number, moduleId: string) =>
    request<unknown>(`/api/boards/${boardId}/panes`, post({ module_id: moduleId })),
  removePane: (boardId: number, paneId: number) =>
    request<{ ok: true }>(`/api/boards/${boardId}/panes/${paneId}`, { method: 'DELETE' }),
  saveLayout: (boardId: number, panes: PanePlacement[]) =>
    request<Board>(`/api/boards/${boardId}/layout`, { method: 'PUT', body: JSON.stringify({ panes }) }),

  /**
   * A URL that opens this module already signed in.
   *
   * Single-use and short-lived, so the caller must hold the answer rather than
   * asking again on every render — see PaneFrame.
   */
  embed: (moduleId: string) => request<{ url: string }>(`/api/embed/${encodeURIComponent(moduleId)}`),
};
