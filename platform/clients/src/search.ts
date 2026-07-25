import { BaseClient } from './http.js';

export interface IndexDocInput {
  collection: string;
  id: string;
  title: string;
  body?: string;
  facets?: Record<string, string>;
  tenant?: string | null;
}

export interface SearchHit {
  collection: string;
  id: string;
  title: string;
  score: number;
  snippet: string;
  facets: Record<string, string>;
}

export interface SearchResult {
  total: number;
  hits: SearchHit[];
  facets: { key: string; value: string; count: number }[];
}

/** Client for PS-09 Search (default port 4009). */
export class SearchClient extends BaseClient {
  /** Upsert a document into the index. */
  index(doc: IndexDocInput): Promise<{ indexed: boolean }> {
    return this.apiPost('/api/index', doc);
  }

  remove(collection: string, id: string, tenant?: string): Promise<{ deleted: boolean }> {
    const suffix = tenant ? `?tenant=${encodeURIComponent(tenant)}` : '';
    return this.apiDelete(`/api/index/${encodeURIComponent(collection)}/${encodeURIComponent(id)}${suffix}`);
  }

  /** Search a collection. `filters` become `facet.<key>=<value>` params. */
  search(opts: {
    collection: string;
    q: string;
    filters?: Record<string, string>;
    tenant?: string;
    limit?: number;
    offset?: number;
  }): Promise<SearchResult> {
    const qs = new URLSearchParams({ collection: opts.collection, q: opts.q });
    for (const [k, v] of Object.entries(opts.filters ?? {})) qs.set(`facet.${k}`, v);
    if (opts.tenant) qs.set('tenant', opts.tenant);
    if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
    if (opts.offset !== undefined) qs.set('offset', String(opts.offset));
    return this.apiGet(`/api/search?${qs.toString()}`);
  }
}
