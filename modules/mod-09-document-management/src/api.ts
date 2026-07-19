import type {
  DocumentDetail,
  DocumentSummary,
  MatterMember,
  MatterRole,
  MatterSummary,
  UserProfile,
  UserRef,
} from '../shared/types';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export interface DocumentFilters {
  matter?: number;
  tag?: string;
  search?: string;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ user: UserProfile }>('/api/login', jsonInit('POST', { username, password })),
  logout: () => request<{ ok: true }>('/api/logout', jsonInit('POST')),
  me: () => request<{ user: UserProfile }>('/api/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('/api/me/password', jsonInit('POST', { currentPassword, newPassword })),

  users: () => request<{ users: UserRef[] }>('/api/users'),
  createUser: (input: { username: string; name: string; role: string; password: string }) =>
    request<{ user: UserProfile }>('/api/users', jsonInit('POST', input)),

  matters: () => request<{ matters: MatterSummary[] }>('/api/matters'),
  createMatter: (input: { key: string; name: string; description: string }) =>
    request<{ matter: MatterSummary }>('/api/matters', jsonInit('POST', input)),
  matter: (id: number) => request<{ matter: MatterSummary }>(`/api/matters/${id}`),

  members: (matterId: number) =>
    request<{ members: MatterMember[] }>(`/api/matters/${matterId}/members`),
  addMember: (matterId: number, userId: number, role: MatterRole) =>
    request<{ members: MatterMember[] }>(
      `/api/matters/${matterId}/members`,
      jsonInit('POST', { user_id: userId, role }),
    ),
  removeMember: (matterId: number, userId: number) =>
    request<{ members: MatterMember[] }>(
      `/api/matters/${matterId}/members/${userId}`,
      jsonInit('DELETE'),
    ),

  documents: (filters: DocumentFilters = {}) => {
    const params = new URLSearchParams();
    if (filters.matter !== undefined) params.set('matter', String(filters.matter));
    if (filters.tag) params.set('tag', filters.tag);
    if (filters.search) params.set('search', filters.search);
    const qs = params.toString();
    return request<{ documents: DocumentSummary[] }>(`/api/documents${qs ? `?${qs}` : ''}`);
  },
  tags: () => request<{ tags: string[] }>('/api/tags'),
  document: (id: number) => request<DocumentDetail>(`/api/documents/${id}`),

  uploadDocument: (matterId: number, file: File, title: string) =>
    upload(`/api/matters/${matterId}/documents`, file, title),
  uploadVersion: (documentId: number, file: File, title: string) =>
    upload(`/api/documents/${documentId}/versions`, file, title),

  addTag: (documentId: number, tag: string) =>
    request<{ document: DocumentSummary }>(
      `/api/documents/${documentId}/tags`,
      jsonInit('POST', { tag }),
    ),
  removeTag: (documentId: number, tag: string) =>
    request<{ document: DocumentSummary }>(
      `/api/documents/${documentId}/tags/${encodeURIComponent(tag)}`,
      jsonInit('DELETE'),
    ),

  deleteDocument: (documentId: number) =>
    request<{ ok: true }>(`/api/documents/${documentId}`, jsonInit('DELETE')),
};

async function upload(path: string, file: File, title: string): Promise<DocumentDetail> {
  const params = new URLSearchParams({ title, filename: file.name });
  return request<DocumentDetail>(`${path}?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
}

export function downloadUrl(documentId: number, versionNo?: number): string {
  return versionNo === undefined
    ? `/api/documents/${documentId}/download`
    : `/api/documents/${documentId}/versions/${versionNo}/download`;
}
