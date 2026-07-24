/**
 * PS-09 Search — wire contract shared between server and clients.
 */

export interface FieldError {
  field: string;
  message: string;
}

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

export interface FacetCount {
  key: string;
  value: string;
  count: number;
}

export interface SearchResult {
  total: number;
  hits: SearchHit[];
  facets: FacetCount[];
}
