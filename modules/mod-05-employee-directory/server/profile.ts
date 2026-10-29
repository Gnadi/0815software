import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import type { FieldError, OwnProfile, PrivateData, ProfileChange, ProfileField, ProfileRequest, RequestField } from '../shared/types.js';
import { DomainError, getEmployeeRow, nowIso } from './directory.js';

/**
 * Self-service: a person keeps their own record current instead of mailing
 * HR — the one place in this module where what may be written depends on
 * the row, so the rule is here, in named functions, not spread over routes.
 *
 * - **Whose record.** The employee whose email is the signed-in identity
 *   (PS-01's email, case-insensitively; `employeeOf`). The `/api/me/...`
 *   routes take no id, so nobody can aim them at a colleague; any level may
 *   use them, `view` included — keeping one's own phone number current is
 *   not "editing the directory".
 * - **Directly**: the work phone (directory), the private phone and the
 *   emergency contact (private). Wrong values here harm nobody but the
 *   person, and they are the ones who know.
 * - **With HR's approval** (`edit`): the name — it is the legal identity
 *   every other record and document uses — and the private address, which
 *   payroll and official letters go to. A request holds the proposed value
 *   until HR approves (the value is applied) or rejects it with a reason;
 *   nobody decides their own request; one pending request per field.
 * - **Private stays private.** Private data is seen by the person and by HR
 *   (`edit`), never by colleagues browsing the directory.
 * - **History, append-only, without the values** (`profile_changes`): which
 *   field changed, how and by whom — never what it was or became, so the
 *   log does not become a second copy of private data. A request keeps the
 *   value it asked for: that is what HR decided on. HR can erase the private
 *   data when it is no longer needed (after offboarding — docs/PII-MAP.md).
 * - **Offboarded is read-only**: a login that still works after leaving does
 *   not get to change the record.
 */

export const DIRECT_FIELDS = ['phone', 'private_phone', 'emergency_name', 'emergency_relation', 'emergency_phone'] as const;
export const REQUEST_FIELDS = ['name', 'address'] as const;

/** The employee this identity is, or null when no employee carries that email. */
export function employeeOf(db: Database.Database, actor: string): number | null {
  const row = db.prepare('SELECT id FROM employees WHERE email = ? COLLATE NOCASE').get(actor.trim()) as { id: number } | undefined;
  return row?.id ?? null;
}

export function requireOwn(db: Database.Database, actor: string): number {
  const own = employeeOf(db, actor);
  if (own === null) throw new DomainError(404, `No employee record carries ${actor} — ask HR to add your email to it`);
  return own;
}

/** HR may see and decide on private data; colleagues may not. */
export function maySeePrivate(access: AccessLevel): boolean {
  return access === 'edit' || access === 'manage';
}

/** Nobody decides their own request, whatever their level. */
export function mayDecide(db: Database.Database, actor: string, access: AccessLevel, employeeId: number): boolean {
  return maySeePrivate(access) && employeeOf(db, actor) !== employeeId;
}

function assertActive(db: Database.Database, employeeId: number): void {
  if (getEmployeeRow(db, employeeId).status !== 'active') throw new DomainError(409, 'An offboarded record is read-only');
}

// ── Private data ────────────────────────────────────────────────────────

const EMPTY_PRIVATE: Omit<PrivateData, 'employee_id'> = {
  private_phone: null,
  address: null,
  emergency_name: null,
  emergency_relation: null,
  emergency_phone: null,
  updated_at: null,
  updated_by: null,
};

export function privateOf(db: Database.Database, employeeId: number): PrivateData {
  getEmployeeRow(db, employeeId);
  const row = db.prepare('SELECT * FROM employee_private WHERE employee_id = ?').get(employeeId) as PrivateData | undefined;
  return row ?? { employee_id: employeeId, ...EMPTY_PRIVATE };
}

function writePrivate(db: Database.Database, employeeId: number, patch: Partial<Omit<PrivateData, 'employee_id' | 'updated_at' | 'updated_by'>>, actor: string): void {
  const next = { ...privateOf(db, employeeId), ...patch, updated_at: nowIso(), updated_by: actor };
  db.prepare(
    `INSERT INTO employee_private (employee_id, private_phone, address, emergency_name, emergency_relation, emergency_phone, updated_at, updated_by)
     VALUES (@employee_id, @private_phone, @address, @emergency_name, @emergency_relation, @emergency_phone, @updated_at, @updated_by)
     ON CONFLICT (employee_id) DO UPDATE SET private_phone = excluded.private_phone, address = excluded.address,
       emergency_name = excluded.emergency_name, emergency_relation = excluded.emergency_relation,
       emergency_phone = excluded.emergency_phone, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run({ ...next, employee_id: employeeId });
}

function logChange(db: Database.Database, employeeId: number, field: ProfileField, via: ProfileChange['via'], actor: string, requestId: number | null = null): void {
  db.prepare('INSERT INTO profile_changes (employee_id, field, via, request_id, actor, at) VALUES (?, ?, ?, ?, ?, ?)').run(employeeId, field, via, requestId, actor, nowIso());
}

const PHONE_RE = /^[0-9+()/.\- ]{3,40}$/;

function optField(input: Record<string, unknown>, field: string, max: number, errors: FieldError[], pattern?: RegExp): string | null | undefined {
  if (!(field in input)) return undefined;
  const raw = input[field];
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.trim().length > max) {
    errors.push({ field, message: `${field} is text, at most ${max} characters` });
    return undefined;
  }
  const value = raw.trim();
  if (pattern && !pattern.test(value)) {
    errors.push({ field, message: `${field} is a phone number: digits, spaces and + ( ) / . -` });
    return undefined;
  }
  return value;
}

/** What the person changes themselves: the fields that are theirs to know. Returns the fields that changed. */
export function updateOwnProfile(db: Database.Database, employeeId: number, input: Record<string, unknown>, actor: string): ProfileField[] {
  const errors: FieldError[] = [];
  for (const k of Object.keys(input)) {
    if ((REQUEST_FIELDS as readonly string[]).includes(k)) errors.push({ field: k, message: `${k} changes go to HR for approval — send a change request` });
    else if (!(DIRECT_FIELDS as readonly string[]).includes(k)) errors.push({ field: k, message: `${k} is not yours to change here` });
  }
  const phone = optField(input, 'phone', 40, errors, PHONE_RE);
  const privatePhone = optField(input, 'private_phone', 40, errors, PHONE_RE);
  const emergencyName = optField(input, 'emergency_name', 120, errors);
  const emergencyRelation = optField(input, 'emergency_relation', 60, errors);
  const emergencyPhone = optField(input, 'emergency_phone', 40, errors, PHONE_RE);
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);

  return db.transaction((): ProfileField[] => {
    assertActive(db, employeeId);
    const changed: ProfileField[] = [];
    const row = getEmployeeRow(db, employeeId);
    if (phone !== undefined && phone !== row.phone) {
      db.prepare('UPDATE employees SET phone = ? WHERE id = ?').run(phone, employeeId);
      changed.push('phone');
    }
    const current = privateOf(db, employeeId);
    const patch: Partial<PrivateData> = {};
    const consider = (field: 'private_phone' | 'emergency_name' | 'emergency_relation' | 'emergency_phone', value: string | null | undefined) => {
      if (value !== undefined && value !== current[field]) {
        patch[field] = value;
        changed.push(field);
      }
    };
    consider('private_phone', privatePhone);
    consider('emergency_name', emergencyName);
    consider('emergency_relation', emergencyRelation);
    consider('emergency_phone', emergencyPhone);
    if (Object.keys(patch).length > 0) writePrivate(db, employeeId, patch, actor);
    for (const field of changed) logChange(db, employeeId, field, 'self', actor);
    return changed;
  })();
}

// ── Change requests (name, address) ─────────────────────────────────────

interface RequestRow {
  id: number;
  employee_id: number;
  field: RequestField;
  proposed: string;
  reason: string | null;
  status: ProfileRequest['status'];
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
}

function toRequest(db: Database.Database, row: RequestRow): ProfileRequest {
  const person = getEmployeeRow(db, row.employee_id);
  const current = row.field === 'name' ? person.name : privateOf(db, row.employee_id).address;
  return { ...row, employee_name: person.name, current };
}

export function getRequest(db: Database.Database, id: number): ProfileRequest {
  const row = db.prepare('SELECT * FROM profile_requests WHERE id = ?').get(id) as RequestRow | undefined;
  if (!row) throw new DomainError(404, 'Change request not found');
  return toRequest(db, row);
}

export function listRequests(db: Database.Database, filter: { employeeId?: number; status?: ProfileRequest['status'] } = {}): ProfileRequest[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.employeeId !== undefined) (where.push('employee_id = ?'), params.push(filter.employeeId));
  if (filter.status !== undefined) (where.push('status = ?'), params.push(filter.status));
  const rows = db.prepare(`SELECT * FROM profile_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`).all(...params) as RequestRow[];
  return rows.map((r) => toRequest(db, r));
}

export function requestChange(db: Database.Database, employeeId: number, input: Record<string, unknown>, actor: string): ProfileRequest {
  const errors: FieldError[] = [];
  const field = input.field as RequestField;
  if (!(REQUEST_FIELDS as readonly unknown[]).includes(field)) errors.push({ field: 'field', message: `field is one of: ${REQUEST_FIELDS.join(', ')}` });
  const max = field === 'address' ? 300 : 200;
  const value = typeof input.value === 'string' ? input.value.trim() : '';
  if (value === '' || value.length > max) errors.push({ field: 'value', message: `The new ${field ?? 'value'} is required (max ${max} characters)` });
  const reason = typeof input.reason === 'string' && input.reason.trim() !== '' ? input.reason.trim().slice(0, 300) : null;
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);

  return db.transaction((): ProfileRequest => {
    assertActive(db, employeeId);
    const open = db.prepare("SELECT id FROM profile_requests WHERE employee_id = ? AND field = ? AND status = 'pending'").get(employeeId, field) as { id: number } | undefined;
    if (open) throw new DomainError(409, `A ${field} change is already waiting for HR (#${open.id}) — withdraw it to send another`);
    const current = field === 'name' ? getEmployeeRow(db, employeeId).name : privateOf(db, employeeId).address;
    if (current === value) throw new DomainError(422, 'Validation failed', [{ field: 'value', message: `That is already your ${field}` }]);
    const info = db
      .prepare("INSERT INTO profile_requests (employee_id, field, proposed, reason, status, requested_by, requested_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
      .run(employeeId, field, value, reason, actor, nowIso());
    return getRequest(db, Number(info.lastInsertRowid));
  })();
}

export function withdrawRequest(db: Database.Database, id: number, employeeId: number, actor: string): ProfileRequest {
  const req = getRequest(db, id);
  if (req.employee_id !== employeeId) throw new DomainError(404, 'Change request not found');
  if (req.status !== 'pending') throw new DomainError(409, `The request is ${req.status}`);
  db.prepare("UPDATE profile_requests SET status = 'withdrawn', decided_by = ?, decided_at = ? WHERE id = ?").run(actor, nowIso(), id);
  return getRequest(db, id);
}

export function decideRequest(db: Database.Database, id: number, decision: 'approved' | 'rejected', note: string | null, actor: string, access: AccessLevel): ProfileRequest {
  return db.transaction((): ProfileRequest => {
    const req = getRequest(db, id);
    if (!mayDecide(db, actor, access, req.employee_id)) throw new DomainError(403, 'Nobody decides their own change request');
    if (req.status !== 'pending') throw new DomainError(409, `The request is already ${req.status}`);
    if (decision === 'rejected' && !note) throw new DomainError(422, 'Validation failed', [{ field: 'note', message: 'A rejection says why' }]);
    if (decision === 'approved') {
      assertActive(db, req.employee_id);
      if (req.field === 'name') db.prepare('UPDATE employees SET name = ? WHERE id = ?').run(req.proposed, req.employee_id);
      else writePrivate(db, req.employee_id, { address: req.proposed }, actor);
      logChange(db, req.employee_id, req.field, 'request', actor, id);
    }
    db.prepare('UPDATE profile_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?').run(decision, actor, nowIso(), note, id);
    return getRequest(db, id);
  })();
}

// ── HR's side ───────────────────────────────────────────────────────────

/** HR maintains private data too — the person is not always the one who can. */
export function updatePrivateByHr(db: Database.Database, employeeId: number, input: Record<string, unknown>, actor: string): ProfileField[] {
  const errors: FieldError[] = [];
  for (const k of Object.keys(input)) {
    if (!['private_phone', 'address', 'emergency_name', 'emergency_relation', 'emergency_phone'].includes(k)) errors.push({ field: k, message: `${k} is not private data` });
  }
  const patch: Partial<PrivateData> = {};
  const set = (field: 'private_phone' | 'address' | 'emergency_name' | 'emergency_relation' | 'emergency_phone', max: number, pattern?: RegExp) => {
    const v = optField(input, field, max, errors, pattern);
    if (v !== undefined) patch[field] = v;
  };
  set('private_phone', 40, PHONE_RE);
  set('address', 300);
  set('emergency_name', 120);
  set('emergency_relation', 60);
  set('emergency_phone', 40, PHONE_RE);
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return db.transaction((): ProfileField[] => {
    const current = privateOf(db, employeeId);
    const changed = (Object.keys(patch) as (keyof typeof patch)[]).filter((k) => patch[k] !== current[k]) as ProfileField[];
    if (changed.length === 0) return [];
    writePrivate(db, employeeId, patch, actor);
    for (const field of changed) logChange(db, employeeId, field, 'hr', actor);
    return changed;
  })();
}

/** Erase the private data — after offboarding, once nothing needs it any more. */
export function erasePrivate(db: Database.Database, employeeId: number, actor: string): void {
  db.transaction(() => {
    getEmployeeRow(db, employeeId);
    db.prepare('DELETE FROM employee_private WHERE employee_id = ?').run(employeeId);
    // Pending or decided, a request for the address holds an address.
    db.prepare("UPDATE profile_requests SET proposed = '(erased)' WHERE employee_id = ? AND field = 'address'").run(employeeId);
    logChange(db, employeeId, 'private_data', 'erased', actor);
  })();
}

export function changesOf(db: Database.Database, employeeId: number): ProfileChange[] {
  return db.prepare('SELECT id, field, via, request_id, actor, at FROM profile_changes WHERE employee_id = ? ORDER BY id DESC').all(employeeId) as ProfileChange[];
}

export function ownProfile(db: Database.Database, employeeId: number): OwnProfile {
  return {
    employee: getEmployeeRow(db, employeeId),
    private: privateOf(db, employeeId),
    requests: listRequests(db, { employeeId }),
    changes: changesOf(db, employeeId),
  };
}
