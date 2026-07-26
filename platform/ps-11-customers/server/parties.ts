import type Database from 'better-sqlite3';
import { DomainError, fail, failValidation } from './errors.js';
import type {
  FieldError,
  MatchedOn,
  Party,
  PartyKind,
  PartyRef,
  ResolveInput,
  ResolveResult,
} from '../shared/types.js';

/**
 * Party master data — the whole domain of PS-11.
 *
 * Two rules carry the design:
 *
 * 1. **Matching is deterministic and explained.** `resolve` looks for an
 *    existing party by the consumer's own reference first, then by VAT id, then
 *    by email, and only then creates one — and it reports which rule fired, so
 *    an importer can audit the decision instead of guessing.
 * 2. **Enrich, never clobber.** A resolve that matches fills in fields the
 *    master record is missing and leaves everything it already knows alone. A
 *    module importing a thin copy of a customer can therefore never degrade the
 *    master record; changing a known value is an explicit update.
 */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function nowIso(ms: number = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Upper-case and strip whitespace so "atu 123" and "ATU123" are one id. */
export function normalizeVatId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.replace(/\s+/g, '').toUpperCase();
  return value === '' ? null : value;
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return value === '' ? null : value;
}

function optionalText(raw: unknown, field: string, max: number, errors: FieldError[]): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    errors.push({ field, message: 'must be a string' });
    return null;
  }
  const value = raw.trim();
  if (value === '') return null;
  if (value.length > max) errors.push({ field, message: `must be at most ${max} characters` });
  return value;
}

function addressLines(raw: unknown, errors: FieldError[]): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    errors.push({ field: 'address_lines', message: 'must be an array of strings' });
    return undefined;
  }
  const lines = raw.map((line) => (typeof line === 'string' ? line.trim() : '')).filter((line) => line !== '');
  if (lines.some((line) => line.length > 200)) {
    errors.push({ field: 'address_lines', message: 'each line must be at most 200 characters' });
  }
  if (lines.length > 8) errors.push({ field: 'address_lines', message: 'must be at most 8 lines' });
  return lines;
}

interface CleanInput {
  name: string;
  kind: PartyKind;
  contact_person: string | null;
  email: string | null;
  vat_id: string | null;
  address_lines: string[] | undefined;
  iban: string | null;
  bic: string | null;
}

/** Validate and normalize a party payload. Throws 422 with field details. */
export function cleanInput(body: Record<string, unknown>, { requireName = true } = {}): CleanInput {
  const errors: FieldError[] = [];

  const rawName = body.name;
  let name = '';
  if (rawName === undefined || rawName === null || rawName === '') {
    if (requireName) errors.push({ field: 'name', message: 'is required' });
  } else if (typeof rawName !== 'string' || rawName.trim() === '') {
    errors.push({ field: 'name', message: 'is required' });
  } else {
    name = rawName.trim();
    if (name.length > 200) errors.push({ field: 'name', message: 'must be at most 200 characters' });
  }

  let kind: PartyKind = 'customer';
  if (body.kind !== undefined) {
    if (body.kind !== 'customer' && body.kind !== 'self') {
      errors.push({ field: 'kind', message: 'must be "customer" or "self"' });
    } else {
      kind = body.kind;
    }
  }

  const email = normalizeEmail(body.email);
  if (email !== null && !EMAIL_RE.test(email)) errors.push({ field: 'email', message: 'must be a valid email' });

  const result: CleanInput = {
    name,
    kind,
    contact_person: optionalText(body.contact_person, 'contact_person', 160, errors),
    email,
    vat_id: normalizeVatId(body.vat_id),
    address_lines: addressLines(body.address_lines, errors),
    iban: optionalText(body.iban, 'iban', 40, errors),
    bic: optionalText(body.bic, 'bic', 20, errors),
  };
  if (result.vat_id !== null && result.vat_id.length > 40) {
    errors.push({ field: 'vat_id', message: 'must be at most 40 characters' });
  }
  if (errors.length > 0) failValidation(errors);
  return result;
}

interface PartyRow {
  id: number;
  kind: PartyKind;
  name: string;
  contact_person: string | null;
  email: string | null;
  vat_id: string | null;
  address_lines: string;
  iban: string | null;
  bic: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function toParty(row: PartyRow): Party {
  return {
    ...row,
    address_lines: row.address_lines === '' ? [] : row.address_lines.split('\n'),
  };
}

export function getParty(db: Database.Database, id: number): Party | null {
  const row = db.prepare('SELECT * FROM parties WHERE id = ?').get(id) as PartyRow | undefined;
  return row ? toParty(row) : null;
}

/** Like getParty but 404s — for routes that must not return null. */
export function requireParty(db: Database.Database, id: number): Party {
  const party = getParty(db, id);
  if (!party) fail(404, 'Party not found');
  return party;
}

export interface ListFilter {
  /** Substring match on name, email or VAT id. */
  q?: string;
  kind?: PartyKind;
  includeArchived?: boolean;
  limit?: number;
}

export function listParties(db: Database.Database, filter: ListFilter = {}): Party[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!filter.includeArchived) where.push('archived_at IS NULL');
  if (filter.kind) {
    where.push('kind = ?');
    params.push(filter.kind);
  }
  if (filter.q) {
    where.push('(name LIKE ? OR IFNULL(email, \'\') LIKE ? OR IFNULL(vat_id, \'\') LIKE ?)');
    const like = `%${filter.q}%`;
    params.push(like, like, filter.q.replace(/\s+/g, '').toUpperCase() + '%');
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const sql = `SELECT * FROM parties ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name COLLATE NOCASE, id LIMIT ?`;
  return (db.prepare(sql).all(...params, limit) as PartyRow[]).map(toParty);
}

export function createParty(db: Database.Database, input: CleanInput, at = nowIso()): Party {
  if (input.kind === 'self' && db.prepare("SELECT 1 FROM parties WHERE kind = 'self'").get()) {
    fail(409, 'A self party already exists — update it instead');
  }
  const info = db
    .prepare(
      `INSERT INTO parties (kind, name, contact_person, email, vat_id, address_lines, iban, bic, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.kind,
      input.name,
      input.contact_person,
      input.email,
      input.vat_id,
      (input.address_lines ?? []).join('\n'),
      input.iban,
      input.bic,
      at,
      at,
    );
  return getParty(db, Number(info.lastInsertRowid))!;
}

/** Overwrite the fields present in `patch`; absent fields are left alone. */
export function updateParty(db: Database.Database, id: number, patch: Record<string, unknown>, at = nowIso()): Party {
  const existing = requireParty(db, id);
  const clean = cleanInput({ name: existing.name, ...patch }, { requireName: false });
  const next = {
    name: patch.name !== undefined ? clean.name : existing.name,
    contact_person: patch.contact_person !== undefined ? clean.contact_person : existing.contact_person,
    email: patch.email !== undefined ? clean.email : existing.email,
    vat_id: patch.vat_id !== undefined ? clean.vat_id : existing.vat_id,
    address_lines: patch.address_lines !== undefined ? (clean.address_lines ?? []) : existing.address_lines,
    iban: patch.iban !== undefined ? clean.iban : existing.iban,
    bic: patch.bic !== undefined ? clean.bic : existing.bic,
  };
  db.prepare(
    `UPDATE parties SET name = ?, contact_person = ?, email = ?, vat_id = ?, address_lines = ?,
            iban = ?, bic = ?, updated_at = ? WHERE id = ?`,
  ).run(
    next.name,
    next.contact_person,
    next.email,
    next.vat_id,
    next.address_lines.join('\n'),
    next.iban,
    next.bic,
    at,
    id,
  );
  return getParty(db, id)!;
}

export function archiveParty(db: Database.Database, id: number, at = nowIso()): Party {
  const party = requireParty(db, id);
  if (party.kind === 'self') fail(409, 'The self party cannot be archived');
  if (party.archived_at === null) {
    db.prepare('UPDATE parties SET archived_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
  }
  return getParty(db, id)!;
}

/**
 * GDPR erasure: anonymize the personal fields in place, keeping the row and its
 * id so every module's foreign reference stays valid (the same stance PS-01
 * takes for users). Refs survive; the identity does not.
 */
export function eraseParty(db: Database.Database, id: number, at = nowIso()): Party {
  const party = requireParty(db, id);
  if (party.kind === 'self') fail(409, 'The self party cannot be erased');
  db.prepare(
    `UPDATE parties SET name = ?, contact_person = NULL, email = NULL, vat_id = NULL,
            address_lines = '', iban = NULL, bic = NULL, archived_at = ?, updated_at = ? WHERE id = ?`,
  ).run(`[erased party ${id}]`, party.archived_at ?? at, at, id);
  return getParty(db, id)!;
}

export function listRefs(db: Database.Database, partyId: number): PartyRef[] {
  return db
    .prepare('SELECT party_id, source, external_id, created_at FROM party_refs WHERE party_id = ? ORDER BY source, external_id')
    .all(partyId) as PartyRef[];
}

/** Register a consumer's own id for a party. Idempotent; 409 on a re-point. */
export function linkRef(
  db: Database.Database,
  partyId: number,
  source: string,
  externalId: string,
  at = nowIso(),
): PartyRef {
  requireParty(db, partyId);
  const existing = db
    .prepare('SELECT party_id, source, external_id, created_at FROM party_refs WHERE source = ? AND external_id = ?')
    .get(source, externalId) as PartyRef | undefined;
  if (existing) {
    if (existing.party_id !== partyId) {
      fail(409, `${source}/${externalId} is already linked to party ${existing.party_id}`);
    }
    return existing;
  }
  db.prepare('INSERT INTO party_refs (party_id, source, external_id, created_at) VALUES (?, ?, ?, ?)').run(
    partyId,
    source,
    externalId,
    at,
  );
  return { party_id: partyId, source, external_id: externalId, created_at: at };
}

function findByRef(db: Database.Database, source: string, externalId: string): Party | null {
  const row = db
    .prepare(
      `SELECT p.* FROM parties p JOIN party_refs r ON r.party_id = p.id
       WHERE r.source = ? AND r.external_id = ?`,
    )
    .get(source, externalId) as PartyRow | undefined;
  return row ? toParty(row) : null;
}

function findByVatId(db: Database.Database, vatId: string): Party | null {
  const row = db
    .prepare("SELECT * FROM parties WHERE kind = 'customer' AND vat_id = ? AND archived_at IS NULL ORDER BY id LIMIT 1")
    .get(vatId) as PartyRow | undefined;
  return row ? toParty(row) : null;
}

function findByEmail(db: Database.Database, email: string): Party | null {
  const row = db
    .prepare("SELECT * FROM parties WHERE kind = 'customer' AND email = ? AND archived_at IS NULL ORDER BY id LIMIT 1")
    .get(email) as PartyRow | undefined;
  return row ? toParty(row) : null;
}

/** Fill in what the master record is missing; never overwrite a known value. */
function enrich(db: Database.Database, party: Party, input: CleanInput, at: string): Party {
  const patch: Record<string, unknown> = {};
  if (!party.email && input.email) patch.email = input.email;
  if (!party.vat_id && input.vat_id) patch.vat_id = input.vat_id;
  if (!party.contact_person && input.contact_person) patch.contact_person = input.contact_person;
  if (!party.iban && input.iban) patch.iban = input.iban;
  if (!party.bic && input.bic) patch.bic = input.bic;
  if (party.address_lines.length === 0 && input.address_lines && input.address_lines.length > 0) {
    patch.address_lines = input.address_lines;
  }
  if (Object.keys(patch).length === 0) return party;
  return updateParty(db, party.id, patch, at);
}

/**
 * Find-or-create, in one atomic call — the endpoint every consuming module
 * actually uses. Matching order: the caller's own reference, then VAT id, then
 * email, then create. See the module docstring for why it enriches rather than
 * overwrites.
 */
export function resolveParty(db: Database.Database, body: ResolveInput, at = nowIso()): ResolveResult {
  const source = typeof body.source === 'string' && body.source.trim() !== '' ? body.source.trim() : null;
  const externalId =
    typeof body.external_id === 'string' && body.external_id.trim() !== '' ? body.external_id.trim() : null;
  if ((source === null) !== (externalId === null)) {
    failValidation([{ field: source === null ? 'source' : 'external_id', message: 'source and external_id go together' }]);
  }
  const input = cleanInput(body as unknown as Record<string, unknown>);
  if (input.kind === 'self') fail(422, 'Use PUT /api/self to manage the self party');

  return db.transaction((): ResolveResult => {
    let matched: MatchedOn = 'created';
    let party: Party | null = source && externalId ? findByRef(db, source, externalId) : null;
    if (party) matched = 'ref';

    if (!party && input.vat_id) {
      party = findByVatId(db, input.vat_id);
      if (party) matched = 'vat_id';
    }
    if (!party && input.email) {
      party = findByEmail(db, input.email);
      if (party) matched = 'email';
    }

    const created = party === null;
    if (!party) party = createParty(db, input, at);
    else party = enrich(db, party, input, at);

    if (source && externalId) linkRef(db, party.id, source, externalId, at);
    return { party, matched_on: created ? 'created' : matched, created };
  })();
}

/** Replay-safe create: the same idempotency key returns the original party. */
export function createPartyIdempotent(
  db: Database.Database,
  input: CleanInput,
  key: string | null,
  at = nowIso(),
): { party: Party; replayed: boolean } {
  if (!key) return { party: createParty(db, input, at), replayed: false };
  const existing = db.prepare('SELECT party_id FROM idempotency WHERE key = ?').get(key) as
    | { party_id: number }
    | undefined;
  if (existing) {
    const party = getParty(db, existing.party_id);
    if (party) return { party, replayed: true };
  }
  return db.transaction((): { party: Party; replayed: boolean } => {
    const party = createParty(db, input, at);
    db.prepare('INSERT INTO idempotency (key, party_id, created_at) VALUES (?, ?, ?)').run(key, party.id, at);
    return { party, replayed: false };
  })();
}

/** The stack owner's own party — the seller identity, or null before it is set. */
export function getSelf(db: Database.Database): Party | null {
  const row = db.prepare("SELECT * FROM parties WHERE kind = 'self'").get() as PartyRow | undefined;
  return row ? toParty(row) : null;
}

/** Create or replace the self party. Idempotent; this is the seller's home. */
export function putSelf(db: Database.Database, body: Record<string, unknown>, at = nowIso()): Party {
  const input = cleanInput({ ...body, kind: 'self' });
  const existing = getSelf(db);
  if (!existing) return createParty(db, input, at);
  return updateParty(
    db,
    existing.id,
    {
      name: input.name,
      contact_person: input.contact_person,
      email: input.email,
      vat_id: input.vat_id,
      address_lines: input.address_lines ?? [],
      iban: input.iban,
      bic: input.bic,
    },
    at,
  );
}

export function countParties(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM parties WHERE kind = 'customer' AND archived_at IS NULL").get() as {
    n: number;
  }).n;
}

export { DomainError };
