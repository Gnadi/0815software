import type {
  Disposal,
  DocumentDetail,
  DocumentSummary,
  DueDocument,
  MatterMember,
  MatterRole,
  MatterSummary,
  ModuleSettings,
  PublicShare,
  RetentionClass,
  RetentionInfo,
  SearchHit,
  ShareLink,
  UserProfile,
  UserRef,
} from '../shared/types';

export class ApiError extends Error {
  status: number;
  details: { field: string; message: string }[];

  constructor(status: number, message: string, details: { field: string; message: string }[] = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** An error as a person reads it: the message and what each field got wrong. */
export function errorText(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const details = err instanceof ApiError ? err.details.map((d) => d.message) : [];
  return [err.message, ...details].join(' — ');
}

export interface VersionText {
  version_no: number;
  status: string | null;
  format: string | null;
  preview: string | null;
  text: string;
  truncated: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let details: { field: string; message: string }[] = [];
    try {
      const body = (await res.json()) as { error?: string; details?: { field: string; message: string }[] };
      if (body.error) message = body.error;
      if (body.details) details = body.details;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, details);
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

  search: (q: string, filters: { matter?: number; tag?: string } = {}) => {
    const params = new URLSearchParams({ q });
    if (filters.matter !== undefined) params.set('matter', String(filters.matter));
    if (filters.tag) params.set('tag', filters.tag);
    return request<{ hits: SearchHit[] }>(`/api/search?${params}`);
  },
  versionText: (documentId: number, versionNo: number) =>
    request<VersionText>(`/api/documents/${documentId}/text?version=${versionNo}`),

  createShare: (documentId: number, input: Record<string, unknown>) =>
    request<{ link: ShareLink; token: string; path: string }>(`/api/documents/${documentId}/shares`, jsonInit('POST', input)),
  revokeShare: (linkId: number) => request<{ link: ShareLink }>(`/api/shares/${linkId}`, jsonInit('DELETE')),

  retentionClasses: () =>
    request<{ classes: RetentionClass[]; presets: { name: string; years: number; basis: string }[] }>('/api/retention-classes'),
  createRetentionClass: (input: Record<string, unknown>) =>
    request<{ class: RetentionClass }>('/api/retention-classes', jsonInit('POST', input)),
  updateRetentionClass: (id: number, input: Record<string, unknown>) =>
    request<{ class: RetentionClass }>(`/api/retention-classes/${id}`, jsonInit('PUT', input)),
  deleteRetentionClass: (id: number) => request<{ ok: true }>(`/api/retention-classes/${id}`, jsonInit('DELETE')),
  setRetention: (documentId: number, input: { retention_class_id: number | null; document_date: string | null }) =>
    request<{ retention: RetentionInfo }>(`/api/documents/${documentId}/retention`, jsonInit('PUT', input)),
  setLegalHold: (documentId: number, reason: string) =>
    request<{ retention: RetentionInfo }>(`/api/documents/${documentId}/legal-hold`, jsonInit('POST', { reason })),
  releaseLegalHold: (documentId: number) =>
    request<{ retention: RetentionInfo }>(`/api/documents/${documentId}/legal-hold`, jsonInit('DELETE')),
  setMatterRetention: (matterId: number, classId: number | null) =>
    request<{ matter: MatterSummary }>(`/api/matters/${matterId}/retention`, jsonInit('PUT', { retention_class_id: classId })),
  due: () => request<{ documents: DueDocument[] }>('/api/retention/due'),
  dispose: (documentId: number) =>
    request<{ disposal: Disposal }>(`/api/documents/${documentId}/dispose`, jsonInit('POST', { confirm: true })),
  disposals: () => request<{ disposals: Disposal[] }>('/api/disposals'),

  settings: () => request<ModuleSettings>('/api/settings'),
  saveSettings: (input: Partial<ModuleSettings>) => request<ModuleSettings>('/api/settings', jsonInit('PUT', input)),
  reindex: () => request<{ read: number; missing: number }>('/api/admin/reindex', jsonInit('POST')),

  // The public side of a share link — no session.
  shared: (token: string) => request<PublicShare>(`/api/shared/${encodeURIComponent(token)}`),
  unlockShared: (token: string, password: string) =>
    request<{ grant: string }>(`/api/shared/${encodeURIComponent(token)}/unlock`, jsonInit('POST', { password })),
  sharedText: (token: string, grant: string | null) =>
    request<VersionText>(`/api/shared/${encodeURIComponent(token)}/text${grant ? `?grant=${encodeURIComponent(grant)}` : ''}`),
};

export function previewUrl(documentId: number, versionNo: number): string {
  return `/api/documents/${documentId}/preview?version=${versionNo}`;
}

export function sharedUrl(token: string, what: 'download' | 'preview', grant: string | null): string {
  return `/api/shared/${encodeURIComponent(token)}/${what}${grant ? `?grant=${encodeURIComponent(grant)}` : ''}`;
}

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
