import type { ActivityEvent, Board, PeerSummary, Preferences, ShellContext, WidgetPlacement } from '../shared/types';

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

export interface CatalogueModule {
  id: string;
  n: string;
  label: string;
  configured: boolean;
  embeddable: boolean;
  publicUrl: string | null;
}

export interface CatalogueAction {
  id: string;
  label: string;
  source_module: string;
  source_list: string;
  target_module: string;
  available: boolean;
}

export interface Catalogue {
  modules: CatalogueModule[];
  actions: CatalogueAction[];
  customers_configured: boolean;
}

export interface PartyOption {
  id: number;
  name: string;
  vat_id: string | null;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ ok: true; username: string }>('/api/login', post({ username, password })),
  logout: () => request<{ ok: true }>('/api/logout', post()),
  me: () => request<{ username: string }>('/api/me'),

  catalogue: () => request<Catalogue>('/api/catalogue'),

  boards: () => request<{ boards: Board[]; preferences: Preferences }>('/api/boards'),
  createBoard: (name: string) => request<Board>('/api/boards', post({ name })),
  renameBoard: (id: number, name: string) =>
    request<Board>(`/api/boards/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  deleteBoard: (id: number) => request<{ ok: true }>(`/api/boards/${id}`, { method: 'DELETE' }),
  setActiveBoard: (id: number) => request<{ ok: true }>(`/api/boards/${id}/active`, post()),

  addWidget: (boardId: number, widget: Record<string, unknown>) =>
    request<unknown>(`/api/boards/${boardId}/widgets`, post(widget)),
  removeWidget: (boardId: number, widgetId: number) =>
    request<{ ok: true }>(`/api/boards/${boardId}/widgets/${widgetId}`, { method: 'DELETE' }),
  saveLayout: (boardId: number, widgets: WidgetPlacement[]) =>
    request<Board>(`/api/boards/${boardId}/layout`, { method: 'PUT', body: JSON.stringify({ widgets }) }),

  setContext: (context: ShellContext) =>
    request<{ context: ShellContext }>('/api/context', { method: 'PUT', body: JSON.stringify(context) }),
  parties: (q: string) =>
    request<{ parties: PartyOption[]; configured: boolean }>(`/api/parties?q=${encodeURIComponent(q)}`),

  summaries: () => request<{ summaries: PeerSummary[]; context: ShellContext }>('/api/summaries'),
  activity: () => request<{ events: ActivityEvent[] }>('/api/activity'),

  embedUrl: (moduleId: string, path: string) =>
    request<{ url: string }>(`/api/embed/${encodeURIComponent(moduleId)}?path=${encodeURIComponent(path)}`),

  runAction: (actionId: string, itemId: string) =>
    request<{ ok: true; message: string }>(`/api/actions/${encodeURIComponent(actionId)}`, post({ item_id: itemId })),
};
