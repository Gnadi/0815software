import type { ProviderEntry } from './provider-registry.js';

/** Injectable HTTP client (returns status + body text) so tests stay offline. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Build the auth headers for a connection from its decrypted credentials. */
export function authHeaders(entry: ProviderEntry, creds: Record<string, unknown>): Record<string, string> {
  switch (entry.auth_type) {
    case 'basic': {
      const token = Buffer.from(`${str(creds.username)}:${str(creds.password)}`).toString('base64');
      return { authorization: `Basic ${token}` };
    }
    case 'apikey': {
      const header = str(creds.api_key_header) || 'x-api-key';
      return { [header]: str(creds.api_key) };
    }
    case 'bearer':
    case 'oauth2':
    default:
      return { authorization: `Bearer ${str(creds.access_token) || str(creds.token) || str(creds.api_key)}` };
  }
}

function baseUrl(entry: ProviderEntry, creds: Record<string, unknown>): string {
  // Generic REST/GraphQL providers carry their base URL in the credentials.
  return entry.base_url || str(creds.base_url) || str(creds.endpoint);
}

export interface ProxyResult {
  status: number;
  ok: boolean;
  body: string;
}

/** Proxy a REST call through a connection, injecting the provider auth. */
export async function proxyRest(
  entry: ProviderEntry,
  creds: Record<string, unknown>,
  req: { method: string; path: string; query?: Record<string, string>; body?: unknown },
  fetchImpl: FetchLike,
): Promise<ProxyResult> {
  const base = baseUrl(entry, creds).replace(/\/$/, '');
  const qs = req.query && Object.keys(req.query).length ? `?${new URLSearchParams(req.query).toString()}` : '';
  const url = `${base}${req.path.startsWith('/') ? '' : '/'}${req.path}${qs}`;
  const method = (req.method || 'GET').toUpperCase();
  const headers: Record<string, string> = { 'content-type': 'application/json', ...authHeaders(entry, creds) };
  const res = await fetchImpl(url, {
    method,
    headers,
    body: req.body !== undefined && method !== 'GET' ? JSON.stringify(req.body) : undefined,
  });
  return { status: res.status, ok: res.ok, body: await res.text() };
}

/** Proxy a GraphQL query through a connection. */
export async function proxyGraphql(
  entry: ProviderEntry,
  creds: Record<string, unknown>,
  req: { query: string; variables?: Record<string, unknown> },
  fetchImpl: FetchLike,
): Promise<ProxyResult> {
  const url = baseUrl(entry, creds) || 'https://example.invalid/graphql';
  const headers: Record<string, string> = { 'content-type': 'application/json', ...authHeaders(entry, creds) };
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: req.query, variables: req.variables ?? {} }),
  });
  return { status: res.status, ok: res.ok, body: await res.text() };
}
