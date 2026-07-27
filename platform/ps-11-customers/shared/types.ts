/**
 * PS-11 Customers — wire contract shared between server and clients.
 *
 * The service owns ONE thing: the party master record. A party is a customer
 * (or the stack owner itself — see `kind`), identified by name and, where
 * available, a VAT id and an email. Everything a module used to keep in its own
 * `customers` table and could not reconcile with any other module's.
 */

export interface FieldError {
  field: string;
  message: string;
}

/**
 * `customer` is someone you sell to; `supplier` is someone you buy from. They
 * are separate kinds rather than one "party" bucket because matching must not
 * cross them: a company that is both is two records with two relationships, and
 * silently merging them would let a procurement import rewrite a customer's
 * billing address.
 *
 * `self` is the stack owner's own party — the seller whose name, address and VAT
 * id modules print on their documents. Exactly one exists per stack (a partial
 * unique index enforces it), which is what gives the otherwise-duplicated
 * SELLER_* configuration a single home.
 */
export const PARTY_KINDS = ['customer', 'supplier', 'self'] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

/** The kinds a consumer may resolve. `self` is managed through /api/self only. */
export const RESOLVABLE_KINDS = ['customer', 'supplier'] as const;
export type ResolvableKind = (typeof RESOLVABLE_KINDS)[number];

export interface Party {
  id: number;
  kind: PartyKind;
  name: string;
  contact_person: string | null;
  email: string | null;
  /** Normalized: upper-cased, whitespace removed. */
  vat_id: string | null;
  /** Postal address, one entry per line. */
  address_lines: string[];
  iban: string | null;
  bic: string | null;
  /**
   * Set when this party was merged into another: the survivor's id. The row is
   * kept so a consumer holding this id is redirected rather than reading a
   * stale record.
   */
  merged_into: number | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A module's own row id for a party — how a local table maps onto the master. */
export interface PartyRef {
  party_id: number;
  /** The consumer that owns `external_id`, e.g. "mod-04-invoice-billing". */
  source: string;
  external_id: string;
  created_at: string;
}

export interface PartyInput {
  name: string;
  kind?: PartyKind;
  contact_person?: string | null;
  email?: string | null;
  vat_id?: string | null;
  address_lines?: string[];
  iban?: string | null;
  bic?: string | null;
}

/** What `POST /api/parties/resolve` accepts: an identity plus an optional ref. */
export interface ResolveInput extends PartyInput {
  /** Consumer registering its own id for the resolved party. */
  source?: string;
  external_id?: string;
}

/** How a resolve request found its party — useful for auditing an import. */
export const MATCHES = ['ref', 'vat_id', 'email', 'created'] as const;
export type MatchedOn = (typeof MATCHES)[number];

export interface ResolveResult {
  party: Party;
  matched_on: MatchedOn;
  /** True when the call created the party rather than finding it. */
  created: boolean;
}

/** What a merge did, for the operator and for the audit trail. */
export interface MergeResult {
  /** The surviving party, enriched with anything only the loser knew. */
  party: Party;
  /** The id that was merged away; it now redirects here. */
  merged_id: number;
  /** References moved from the loser onto the survivor. */
  moved_refs: number;
}
