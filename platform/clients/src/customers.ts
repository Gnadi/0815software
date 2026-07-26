import { BaseClient } from './http.js';

/** `customer` is a counterparty; `self` is the stack owner (the seller). */
export type PartyKind = 'customer' | 'self';

export interface Party {
  id: number;
  kind: PartyKind;
  name: string;
  contact_person: string | null;
  email: string | null;
  /** Normalized: upper-cased, whitespace removed. */
  vat_id: string | null;
  address_lines: string[];
  iban: string | null;
  bic: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PartyRef {
  party_id: number;
  source: string;
  external_id: string;
  created_at: string;
}

export interface PartyInput {
  name: string;
  contact_person?: string | null;
  email?: string | null;
  vat_id?: string | null;
  address_lines?: string[];
  iban?: string | null;
  bic?: string | null;
}

/** A party identity plus, optionally, the caller's own id for it. */
export interface ResolveInput extends PartyInput {
  /** The consumer owning `external_id`, e.g. "mod-04-invoice-billing". */
  source?: string;
  external_id?: string;
}

/** Which matching rule found the party — worth recording on an import. */
export type MatchedOn = 'ref' | 'vat_id' | 'email' | 'created';

export interface ResolveResult {
  party: Party;
  matched_on: MatchedOn;
  created: boolean;
}

/**
 * Client for PS-11 Customers (default port 4011) — party master data for one
 * customer's stack.
 *
 * `resolve` is the method modules actually use: it finds an existing party by
 * the caller's own reference, then by VAT id, then by email, and creates one
 * only if none matched — so two modules importing the same customer converge on
 * one record instead of two. A match enriches the master record with fields it
 * was missing and never overwrites what it already knows.
 */
export class CustomersClient extends BaseClient {
  /** Find-or-create a party, reporting which rule matched. */
  resolve(input: ResolveInput): Promise<ResolveResult> {
    return this.apiPost<ResolveResult>('/api/parties/resolve', input);
  }

  get(id: number): Promise<{ party: Party; refs: PartyRef[] }> {
    return this.apiGet(`/api/parties/${id}`);
  }

  list(filter?: { q?: string; kind?: PartyKind; include_archived?: boolean; limit?: number }): Promise<{
    parties: Party[];
  }> {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(filter ?? {})) {
      if (value !== undefined) qs.set(key, String(value));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.apiGet(`/api/parties${suffix}`);
  }

  create(input: PartyInput): Promise<{ party: Party }> {
    return this.apiPost('/api/parties', input);
  }

  update(id: number, patch: Partial<PartyInput>): Promise<{ party: Party }> {
    return this.apiPatch(`/api/parties/${id}`, patch);
  }

  archive(id: number): Promise<{ party: Party }> {
    return this.apiPost(`/api/parties/${id}/archive`);
  }

  /** GDPR erasure: anonymize in place, keeping the id so references hold. */
  erase(id: number): Promise<{ party: Party }> {
    return this.apiPost(`/api/parties/${id}/erase`);
  }

  /** Register the caller's own id for a party. */
  link(id: number, source: string, externalId: string): Promise<{ ref: PartyRef }> {
    return this.apiPost(`/api/parties/${id}/refs`, { source, external_id: externalId });
  }

  refs(id: number): Promise<{ refs: PartyRef[] }> {
    return this.apiGet(`/api/parties/${id}/refs`);
  }

  /**
   * The stack owner's own party — the seller identity printed on invoices and
   * offers. `null` until it has been set.
   */
  self(): Promise<{ party: Party | null }> {
    return this.apiGet('/api/self');
  }

  setSelf(input: PartyInput): Promise<{ party: Party }> {
    return this.apiPut('/api/self', input);
  }
}
